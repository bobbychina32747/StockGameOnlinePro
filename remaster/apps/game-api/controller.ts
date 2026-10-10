import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res, UnauthorizedException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { GameService } from './service';
import { AuthBridge, tokenFrom } from './auth';
import { commandKey, marketId, parseCommand } from '../../packages/protocol/commands';
import { RuleError } from '../../packages/domain/types';
import { account, accountId, sellable } from '../../packages/engine/world';
import { cloneWorld, active, placeOrder, tradable } from '../../packages/engine/matching';
import { fees } from '../../packages/domain/money';
import { history, ranking, snapshot } from './read-model';
import { backtest } from '../../packages/engine/backtest';
@Controller('v2')
export class GameController {
  constructor(@Inject('GAME') readonly game:GameService,@Inject('AUTH') readonly auth:AuthBridge) {}
  @Get('config') config() {return {protocolVersion:2,sandbox:this.auth.config.sandbox,mode:this.game.world.mode,version:'2.0.0-dev',siteLogin:'https://bobbycn.cc/login/'};}
  @Get('health') health() {
    if(!this.game.healthy) throw new ServiceUnavailableException('市场引擎已停止写入');
    return {healthy:true,worldVersion:this.game.world.version,generation:this.game.generation,queueLength:this.game.queueLength,lastCommitAt:this.game.lastCommitAt,mode:this.game.world.mode};
  }
  @Post('auth/demo') async demo(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any) {
    this.auth.assertOrigin(request.headers.origin);const existing=tokenFrom(request);
    if(existing) {try {const principal=await this.auth.authenticate(existing);return {...principal,token:existing};} catch {}}
    const session=this.auth.createDemo(body?.name??'沙盒交易员');await this.game.execute({kind:'create-player',owner:session.principal.owner,name:session.principal.name},'create:'+session.principal.owner);
    response.setHeader('Set-Cookie',this.demoCookie(session.token,86400));response.setHeader('Cache-Control','no-store');return {...session.principal,token:session.token};
  }
  @Get('auth/session') async session(@Req() request:any) {return this.auth.authenticate(tokenFrom(request));}
  @Post('auth/site-session') async siteSession(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any) {
    this.auth.assertOrigin(request.headers.origin);if(this.auth.config.sandbox) throw new BadRequestException('沙盒与站点账户隔离，请使用沙盒账户');
    const result=await this.auth.request('/api/auth/site-session',{create:body?.create===true},String(request.headers.cookie??''));response.setHeader('Cache-Control','no-store');
    if(result.needsAccountSetup) return result;
    const principal=await this.auth.authenticate(result.token);const existing=this.game.world.accounts[accountId(principal.owner,'CN')];
    if(!existing&&!body?.createRemaster) return {...result,needsRemasterAccount:true,owner:principal.owner};
    if(!existing) await this.game.execute({kind:'create-player',owner:principal.owner,name:result.user.username},'create:'+principal.owner);
    return {...result,...principal,name:result.user.username};
  }
  @Post('auth/site-link') async siteLink(@Body() body:any,@Req() request:any) {
    this.auth.assertOrigin(request.headers.origin);if(this.auth.config.sandbox) throw new BadRequestException('沙盒不会绑定真实账户');
    if(typeof body?.username!=='string'||typeof body?.password!=='string'||body.username.length>50||body.password.length>200) throw new BadRequestException('账号证明无效');
    return {...await this.auth.request('/api/auth/site-link',{username:body.username,password:body.password},String(request.headers.cookie??'')),needsRemasterAccount:true};
  }
  @Post('auth/logout') async logout(@Req() request:any,@Res({passthrough:true}) response:any) {
    this.auth.assertOrigin(request.headers.origin);const token=tokenFrom(request);this.auth.revoke(token);
    if(!this.auth.config.sandbox) await this.auth.request('/api/auth/identity/logout',{},String(request.headers.cookie??''));
    response.setHeader('Set-Cookie',this.demoCookie('',0));return {success:true};
  }
  private demoCookie(token:string,maxAge:number):string {
    const path=process.env.REMASTER_COOKIE_PATH??'/';if(!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new Error('Invalid cookie path');
    return `rgp-demo=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.REMASTER_COOKIE_SECURE==='true'?'; Secure':''}`;
  }
  @Get('state') async state(@Req() request:any) {const player=await this.auth.authenticate(tokenFrom(request));return snapshot(this.game.world,player.owner);}
  @Post('commands') async command(@Body() body:any,@Req() request:any) {
    this.auth.assertOrigin(request.headers.origin);const player=await this.auth.authenticate(tokenFrom(request));
    try {const command=parseCommand(body,player.owner);const key=commandKey(request.headers['idempotency-key']);return await this.game.execute(command,key);} catch(error) {if(error instanceof RuleError) throw new BadRequestException({success:false,code:error.code,error:error.message});throw error;}
  }
  @Get('commands/:key') async commandResult(@Param('key') key:string,@Req() request:any) {
    const player=await this.auth.authenticate(tokenFrom(request));const row=this.game.repository.db.prepare('SELECT result FROM commands WHERE scope=? AND key=?').get(player.owner,key);
    return row?{found:true,result:JSON.parse(row.result)}:{found:false};
  }
  @Post('orders/estimate') async estimate(@Body() body:any,@Req() request:any) {
    const player=await this.auth.authenticate(tokenFrom(request));try {
      const command=parseCommand({kind:'order',market:body.market,input:body.input},player.owner);if(command.kind!=='order') throw new Error();
      const copy=cloneWorld(this.game.world);const held=account(copy,player.owner,command.market);const order=placeOrder(copy,player.owner,command.market,command.input,'estimate-only');const price=order.averagePrice||command.input.price||copy.quotes[command.input.symbol].price;
      const executionFee=copy.ledger.slice(this.game.world.ledger.length).filter(entry=>entry.accountId===held.id&&entry.kind==='fee').reduce((sum,entry)=>sum-entry.amount,0);
      return {valid:true,price,quantity:order.quantity,filled:order.filled,total:price*order.quantity,fee:order.filled?executionFee:fees(command.market,order.side,price*order.quantity),cash:account(copy,player.owner,command.market).cash,availableSell:sellable(this.game.world,account(this.game.world,player.owner,command.market),order.symbol),status:order.status,worldVersion:this.game.world.version};
    } catch(error) {if(error instanceof RuleError) return {valid:false,code:error.code,error:error.message};throw error;}
  }
  @Get('history/:symbol') async candles(@Param('symbol') symbol:string,@Query('interval') interval='day',@Query('adjusted') adjusted='false',@Query('all') all='false',@Req() request:any) {
    await this.auth.authenticate(tokenFrom(request));if(!['1m','5m','60m','day','week','month'].includes(interval)) throw new BadRequestException('周期无效');return history(this.game.world,symbol,interval,adjusted==='true',all==='true');
  }
  @Get('book/:symbol') async book(@Param('symbol') symbol:string,@Req() request:any) {
    await this.auth.authenticate(tokenFrom(request));const orders=Object.values(this.game.world.orders).filter(order=>order.symbol===symbol&&tradable(order)&&order.price!==undefined);
    const levels=(buy:boolean)=>{const sums=new Map<number,number>();for(const order of orders.filter(item=>(item.side==='buy'||item.side==='cover')===buy)) sums.set(order.price!,(sums.get(order.price!)??0)+Math.min(order.visible||order.remaining,order.remaining));return [...sums].sort(([left],[right])=>buy?right-left:left-right).slice(0,5).map(([price,quantity])=>({price,quantity}));};
    return {bids:levels(true),asks:levels(false),worldVersion:this.game.world.version};
  }
  @Get('activity/:table') async activity(@Param('table') table:string,@Query('market') market:string,@Req() request:any) {
    const player=await this.auth.authenticate(tokenFrom(request));if(!['orders','trades','ledger'].includes(table)) throw new BadRequestException('记录类型无效');return this.game.repository.history(table as 'orders'|'trades'|'ledger',accountId(player.owner,marketId(market)));
  }
  @Post('backtest') async research(@Body() body:any,@Req() request:any) {
    await this.auth.authenticate(tokenFrom(request));if(typeof body?.symbol!=='string'||typeof body?.strategy!=='string') throw new BadRequestException('回测参数无效');
    try {const bars=history(this.game.world,body.symbol,'day',false,true) as any[];return backtest(body.symbol,bars.slice(0,-1),body.strategy,this.game.world.seed);} catch(error) {if(error instanceof RuleError) throw new BadRequestException(error.message);throw error;}
  }
}
