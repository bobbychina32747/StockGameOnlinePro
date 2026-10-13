import { Controller, Get, Post, Body, Param, Query, Req, Res, Inject, BadRequestException } from '@nestjs/common';
import { AuthBridge, tokenFrom, Principal } from './auth';
import { UnifiedLedger, cents } from './unified-ledger';
import { marketId } from '../../packages/protocol/commands';
import { backtest } from '../../packages/engine/backtest';
import { RuleError } from '../../packages/domain/types';

@Controller('v2')
export class UnifiedController {
  constructor(@Inject('AUTH') readonly auth:AuthBridge,@Inject('LEDGER') readonly ledger:UnifiedLedger){}
  private realm(value:unknown){try{return marketId(value);}catch{throw new BadRequestException('请选择有效区服');}}
  private async player(request:any){const token=tokenFrom(request);const p=await this.auth.authenticate(token,String(request.headers.cookie??''));return {token,p};}
  private session(session:{token:string;principal:Principal},response:any){
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Set-Cookie',`rgp-role-${session.principal.market}=${session.token}; Path=/; HttpOnly; SameSite=Strict${session.principal.rememberMe?'; Max-Age=604800':''}${process.env.REMASTER_COOKIE_SECURE==='true'?'; Secure':''}`);
    return {...session.principal,token:session.token};
  }
  @Get('config') config(){return {protocolVersion:2,sandbox:false,unified:true,mode:'real',version:'2.0.0',siteLogin:'https://bobbycn.cc/login/'};}
  @Get('health') async health(){const response=await fetch(new URL('/api/market/state',this.auth.config.identityBaseUrl),{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error('账本不可用');return {healthy:true,mode:'real',ledger:'legacy-authoritative'};}
  @Get('auth/session') async current(@Req() request:any){return (await this.player(request)).p;}
  @Post('auth/login') async login(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any){return this.credentials(false,body,request,response);}
  @Post('auth/register') async register(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any){return this.credentials(true,body,request,response);}
  private async credentials(register:boolean,body:any,request:any,response:any){
    this.auth.assertOrigin(request.headers.origin);const market=this.realm(body?.market);
    if(body?.rememberMe!==undefined&&typeof body.rememberMe!=='boolean')throw new BadRequestException('记住我选项无效');
    if(typeof body.username!=='string'||body.username.trim().length<2||body.username.length>50||typeof body.password!=='string'||body.password.length<1||body.password.length>200)throw new BadRequestException('请输入有效账密');
    if(register&&(body.password.length<8||Buffer.byteLength(body.password,'utf8')>72))throw new BadRequestException('密码至少8位，不超过72个UTF-8字节');
    const result=await this.auth.request('/api/auth/'+(register?'register':'login'),{username:body.username.trim(),password:body.password,...(body.rememberMe===true?{rememberMe:true}:{})},undefined,undefined,request.ip);
    if(!result.token)throw new BadRequestException(result.error??'注册失败');
    return this.session(await this.auth.createGameSession(result.token,market,body.rememberMe===true),response);
  }
  @Post('auth/site-session') async site(@Body() body:any,@Req() request:any,@Res({passthrough:true}) response:any){
    this.auth.assertOrigin(request.headers.origin);const market=this.realm(body?.market);
    if(body?.rememberMe!==undefined&&typeof body.rememberMe!=='boolean')throw new BadRequestException('记住我选项无效');const cookie=String(request.headers.cookie??'');
    const linked=await this.auth.request('/api/auth/site-session',{create:body?.create===true},cookie);
    if(linked.needsAccountSetup)return {needsAccountSetup:true,identity:linked.identity};
    if(!linked.token||!linked.user?.id)throw new BadRequestException('请先登录站点账号');
    return this.session(await this.auth.createSiteSession(linked.token,market,linked.user.username,'game:'+linked.user.id,body.rememberMe===true),response);
  }
  @Post('auth/site-link') async link(@Body() body:any,@Req() request:any){
    this.auth.assertOrigin(request.headers.origin);
    if(typeof body.username!=='string'||typeof body.password!=='string'||body.username.length>50||body.password.length>200)throw new BadRequestException('请输入有效账密');
    await this.auth.request('/api/auth/site-link',{username:body.username,password:body.password},String(request.headers.cookie??''));return {success:true};
  }
  @Post('auth/logout') async logout(@Req() request:any,@Res({passthrough:true}) response:any){
    this.auth.assertOrigin(request.headers.origin);const token=tokenFrom(request);let market=['CN','HK','US'].includes(request.headers['x-game-realm'])?request.headers['x-game-realm']:'CN';try{market=(await this.auth.authenticate(token)).market;}catch{}this.auth.revoke(token);
    response.setHeader('Set-Cookie',`rgp-role-${market}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.REMASTER_COOKIE_SECURE==='true'?'; Secure':''}`);return {success:true};
  }
  @Get('state') async state(@Req() request:any){const {token,p}=await this.player(request);return this.ledger.snapshot(token,p);}
  @Post('commands') async command(@Body() body:any,@Req() request:any){this.auth.assertOrigin(request.headers.origin);const {token,p}=await this.player(request);return this.ledger.command(token,p,body,request.headers['idempotency-key']);}
  @Get('commands/:key') async result(@Param('key') key:string,@Req() request:any){const {p}=await this.player(request);return this.ledger.result(p.owner,key);}
  @Post('orders/estimate') async estimate(@Body() body:any,@Req() request:any){const {token,p}=await this.player(request);return this.ledger.estimate(token,p,body);}
  @Get('history/:symbol') async history(@Param('symbol') symbol:string,@Query('interval') interval='day',@Query('adjusted') adjusted='false',@Req() request:any){const {token,p}=await this.player(request);return this.ledger.history(token,p,symbol,interval,adjusted==='true');}
  @Get('book/:symbol') async book(@Param('symbol') symbol:string,@Req() request:any){const {token,p}=await this.player(request);return this.ledger.book(token,p,symbol);}
  @Get('activity/:table') async activity(@Param('table') table:string,@Req() request:any){
    const {token,p}=await this.player(request);const raw=await this.auth.forward(token,'/api/account/unified?mode='+p.market);
    if(table==='orders')return raw.orders.map((r:any)=>({...r,quantity:r.quantity,averagePrice:cents(r.avgFillPrice),price:r.price==null?undefined:cents(r.price)}));
    if(!['trades','ledger'].includes(table))throw new BadRequestException('记录类型无效');
    return raw.transactions.map((r:any)=>({...r,kind:r.side,reference:r.orderId,price:cents(r.price),amount:cents((['buy','cover'].includes(r.side)?-1:1)*r.turnover-r.totalFees),currency:p.market}));
  }
  @Get('research/:symbol') async research(@Param('symbol') symbol:string,@Req() request:any){const {token,p}=await this.player(request);await this.ledger.symbol(token,p,symbol);
    const [reports,flow]=await Promise.all(['/api/market/reports?symbol=','/api/market/flow-signals?symbol='].map(path=>this.auth.forward(token,path+encodeURIComponent(symbol))));return {reports,flow};}
  @Get('competition') async competition(@Req() request:any){const {token,p}=await this.player(request);
    const [current,leaderboard,history,schedule,opponents]=await Promise.all(['/api/season/current','/api/season/leaderboard?market='+p.market,'/api/season/history','/api/season/schedule','/api/market/ai-opponents'].map(path=>this.auth.forward(token,path)));
    return {current,leaderboard,history,schedule,opponents:opponents.filter((r:any)=>r.market===p.market)};}
  @Post('backtest') async backtest(@Body() body:any,@Req() request:any){const {token,p}=await this.player(request);const bars=await this.ledger.history(token,p,body?.symbol,'day');
    try{return backtest(body.symbol,bars.slice(0,-1),body.strategy,20261010);}catch(error){if(error instanceof RuleError)throw new BadRequestException(error.message);throw error;}}
}
