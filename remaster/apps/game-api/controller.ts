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
  private realm(value:unknown) {try{return marketId(value);}catch{throw new BadRequestException('请选择中国、香港或美国区服');}}
  private async playerForSymbol(request:any,symbol:string) {const player=await this.auth.authenticate(tokenFrom(request));if(this.game.world.instruments[symbol]?.market!==player.market)throw new BadRequestException('不能查看其他区服标的');return player;}
  @Get('config') config() {return {protocolVersion:2,sandbox:this.auth.config.sandbox,mode:this.game.world.mode,version:'2.0.0-dev',siteLogin:'https://bobbycn.cc/login/'};}
  @Get('health') health() {
    if(!this.game.healthy) throw new ServiceUnavailableException('市场引擎已停止写入');
    return {healthy:true,worldVersion:this.game.world.version,generation:this.game.generation,queueLength:this.game.queueLength,lastCommitAt:this.game.lastCommitAt,mode:this.game.world.mode};
  }
  @Post('auth/demo') async demo(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any) {
    this.auth.assertOrigin(request.headers.origin);const existing=tokenFrom(request);
    if(existing) {try {const principal=await this.auth.authenticate(existing);if(body?.market&&principal.market!==body.market) throw new BadRequestException('角色区服不可修改，请先退出角色');return {...principal,token:existing};} catch(error) {if(error instanceof BadRequestException)throw error;}}
    const market=this.realm(body?.market??'CN');const session=this.auth.createDemo(body?.name??'沙盒交易员',market);await this.game.execute({kind:'create-player',owner:session.principal.owner,name:session.principal.name,market},'create:'+session.principal.owner);
    response.setHeader('Set-Cookie',this.demoCookie(session.token,86400));response.setHeader('Cache-Control','no-store');return {...session.principal,token:session.token};
  }
  @Get('auth/session') async session(@Req() request:any) {return this.auth.authenticate(tokenFrom(request));}
  @Post('auth/login') async gameLogin(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any) {
    return this.gameCredentials(false,body,request,response);
  }
  @Post('auth/register') async gameRegister(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any) {
    return this.gameCredentials(true,body,request,response);
  }
  private async gameCredentials(register:boolean,body:any,request:any,response:any) {
    this.auth.assertOrigin(request.headers.origin);const market=this.realm(body?.market);
    if(this.auth.config.sandbox)throw new BadRequestException('沙盒与正式游戏账号隔离');
    if(typeof body?.username!=='string'||body.username.trim().length<2||body.username.length>50||typeof body?.password!=='string'||body.password.length<1||body.password.length>200)throw new BadRequestException('请输入有效的用户名和密码');
    if(register&&(body.password.length<8||Buffer.byteLength(body.password,'utf8')>72))throw new BadRequestException('密码至少8位且不超过72个UTF-8字节');
    const result=await this.auth.request('/api/auth/'+(register?'register':'login'),{username:body.username.trim(),password:body.password},undefined,undefined,request.ip);
    if(!result.token)throw new BadRequestException(result.error??'注册失败，请更换用户名');
    const session=await this.auth.createGameSession(result.token,market);const principal=session.principal;
    if(!this.game.world.accounts[accountId(principal.owner,market)])await this.game.execute({kind:'create-player',owner:principal.owner,name:principal.name,market},'create:'+principal.owner);
    response.setHeader('Set-Cookie',this.demoCookie(session.token,86400,'rgp-role-'+market));response.setHeader('Cache-Control','no-store');return {...principal,token:session.token};
  }
  @Post('auth/site-session') async siteSession(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any) {
    const market=this.realm(body?.market);
    this.auth.assertOrigin(request.headers.origin);if(this.auth.config.sandbox) throw new BadRequestException('沙盒与站点账户隔离，请使用沙盒账户');
    const cookie=String(request.headers.cookie??'');const result=await this.auth.request('/api/auth/identity/token',{},cookie);const user=await this.auth.request('/api/auth/identity/me',undefined,cookie);response.setHeader('Cache-Control','no-store');
    const linked=await this.auth.request('/api/auth/site-session',{create:false},cookie);
    const session=await this.auth.createSiteSession(result.token,market,user.username??'站点玩家',linked.user?.id?'game:'+linked.user.id:undefined);const principal=session.principal;const existing=this.game.world.accounts[accountId(principal.owner,market)];
    if(!existing&&!body?.createRemaster) return {...result,needsRemasterAccount:true,owner:principal.owner};
    if(!existing) await this.game.execute({kind:'create-player',owner:principal.owner,name:principal.name,market},'create:'+principal.owner);
    response.setHeader('Set-Cookie',this.demoCookie(session.token,600,'rgp-role-'+market));
    return {...result,...principal,token:session.token,user,name:principal.name};
  }
  @Post('auth/site-link') async siteLink(@Body() body:any,@Req() request:any) {
    this.auth.assertOrigin(request.headers.origin);if(this.auth.config.sandbox) throw new BadRequestException('沙盒不会绑定真实账户');
    if(typeof body?.username!=='string'||typeof body?.password!=='string'||body.username.length>50||body.password.length>200) throw new BadRequestException('账号证明无效');
    return {...await this.auth.request('/api/auth/site-link',{username:body.username,password:body.password},String(request.headers.cookie??'')),needsRemasterAccount:true};
  }
  @Post('auth/logout') async logout(@Req() request:any,@Res({passthrough:true}) response:any) {
    this.auth.assertOrigin(request.headers.origin);const token=tokenFrom(request);let market='CN';try{market=(await this.auth.authenticate(token)).market;}catch{}this.auth.revoke(token);
    // Leaving a game role must not log out the shared site identity or other realm roles.
    response.setHeader('Set-Cookie',[this.demoCookie('',0),this.demoCookie('',0,'rgp-role-'+market)]);return {success:true};
  }
  private demoCookie(token:string,maxAge:number,name='rgp-demo'):string {
    const path=process.env.REMASTER_COOKIE_PATH??'/';if(!/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new Error('Invalid cookie path');
    return `${name}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.REMASTER_COOKIE_SECURE==='true'?'; Secure':''}`;
  }
  @Get('state') async state(@Req() request:any) {const player=await this.auth.authenticate(tokenFrom(request));return snapshot(this.game.world,player.owner,player.market);}
  @Post('commands') async command(@Body() body:any,@Req() request:any) {
    this.auth.assertOrigin(request.headers.origin);const player=await this.auth.authenticate(tokenFrom(request));
    try {const command=parseCommand(body,player.owner);if(command.kind==='transfer'||('market'in command&&command.market!==player.market)) throw new RuleError('REALM_LOCKED','角色区服不可切换，区服之间不可划转');const key=commandKey(request.headers['idempotency-key']);return await this.game.execute(command,key);} catch(error) {if(error instanceof RuleError) throw new BadRequestException({success:false,code:error.code,error:error.message});throw error;}
  }
  @Get('commands/:key') async commandResult(@Param('key') key:string,@Req() request:any) {
    const player=await this.auth.authenticate(tokenFrom(request));const row=this.game.repository.db.prepare('SELECT result FROM commands WHERE scope=? AND key=?').get(player.owner,key);
    return row?{found:true,result:JSON.parse(row.result)}:{found:false};
  }
  @Post('orders/estimate') async estimate(@Body() body:any,@Req() request:any) {
    const player=await this.auth.authenticate(tokenFrom(request));try {
      const command=parseCommand({kind:'order',market:body.market,input:body.input},player.owner);if(command.kind!=='order') throw new Error();if(command.market!==player.market) throw new RuleError('REALM_LOCKED','不能操作其他区服');
      const copy=cloneWorld(this.game.world);const held=account(copy,player.owner,command.market);const order=placeOrder(copy,player.owner,command.market,command.input,'estimate-only');const price=order.averagePrice||command.input.price||copy.quotes[command.input.symbol].price;
      const executionFee=copy.ledger.slice(this.game.world.ledger.length).filter(entry=>entry.accountId===held.id&&entry.kind==='fee').reduce((sum,entry)=>sum-entry.amount,0);
      return {valid:true,price,quantity:order.quantity,filled:order.filled,total:price*order.quantity,fee:order.filled?executionFee:fees(command.market,order.side,price*order.quantity),cash:account(copy,player.owner,command.market).cash,availableSell:sellable(this.game.world,account(this.game.world,player.owner,command.market),order.symbol),status:order.status,worldVersion:this.game.world.version};
    } catch(error) {if(error instanceof RuleError) return {valid:false,code:error.code,error:error.message};throw error;}
  }
  @Get('history/:symbol') async candles(@Param('symbol') symbol:string,@Query('interval') interval='day',@Query('adjusted') adjusted='false',@Query('all') all='false',@Req() request:any) {
    await this.playerForSymbol(request,symbol);if(!['1m','5m','60m','day','week','month'].includes(interval)) throw new BadRequestException('周期无效');return history(this.game.world,symbol,interval,adjusted==='true',all==='true',['1m','5m','60m'].includes(interval)?this.game.repository.candles(symbol):undefined);
  }
  @Get('book/:symbol') async book(@Param('symbol') symbol:string,@Req() request:any) {
    await this.playerForSymbol(request,symbol);const orders=Object.values(this.game.world.orders).filter(order=>order.symbol===symbol&&tradable(order)&&order.price!==undefined);
    const levels=(buy:boolean)=>{const sums=new Map<number,number>();for(const order of orders.filter(item=>(item.side==='buy'||item.side==='cover')===buy)) sums.set(order.price!,(sums.get(order.price!)??0)+Math.min(order.visible||order.remaining,order.remaining));return [...sums].sort(([left],[right])=>buy?right-left:left-right).slice(0,5).map(([price,quantity])=>({price,quantity}));};
    return {bids:levels(true),asks:levels(false),worldVersion:this.game.world.version};
  }
  @Get('activity/:table') async activity(@Param('table') table:string,@Query('market') market:string,@Req() request:any) {
    const player=await this.auth.authenticate(tokenFrom(request));if(!['orders','trades','ledger'].includes(table)) throw new BadRequestException('记录类型无效');return this.game.repository.history(table as 'orders'|'trades'|'ledger',accountId(player.owner,player.market));
  }
  @Post('backtest') async research(@Body() body:any,@Req() request:any) {
    await this.playerForSymbol(request,body?.symbol);if(typeof body?.symbol!=='string'||typeof body?.strategy!=='string') throw new BadRequestException('回测参数无效');
    try {const bars=history(this.game.world,body.symbol,'day',false,true) as any[];return backtest(body.symbol,bars.slice(0,-1),body.strategy,this.game.world.seed);} catch(error) {if(error instanceof RuleError) throw new BadRequestException(error.message);throw error;}
  }
}
