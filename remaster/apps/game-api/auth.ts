import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { UnauthorizedException, ServiceUnavailableException, HttpException } from '@nestjs/common';
import { RoleSessions, REMEMBER_SECONDS } from './role-sessions';
import { MarketId, MARKETS } from '../../packages/domain/types';
export interface Principal {owner:string;name:string;market:MarketId;token?:string;mode:'sandbox'|'site'|'game';rememberMe?:boolean}
export interface AuthConfig {sandbox:boolean;identityBaseUrl:string;origin:string;allowedOrigins:string[]}
export class AuthBridge {
  resolveOwner:(subject:string,market:MarketId,gameSubject?:string)=>string=(subject,market)=>subject+':'+market;
  private demos=new Map<string,{principal:Principal;expires:number}>();
  private siteSessions=new Map<string,{principal:Principal;siteToken:string;expires:number}>();
  private gameSessions=new Map<string,{principal:Principal;gameToken:string;expires:number}>();
  constructor(readonly config:AuthConfig, private readonly remembered?:RoleSessions) {}
  assertOrigin(origin?: string): void {if(origin&&!this.config.allowedOrigins.includes(origin)) throw new UnauthorizedException('请求来源不受信任');}
  createDemo(name: string,market:MarketId='CN'): {token:string;principal:Principal} {
    if(!this.config.sandbox) throw new UnauthorizedException('当前环境未开放沙盒账号');
    if(typeof name!=='string'||name.length<1||name.length>40) throw new UnauthorizedException('演示名称无效');
    if(!MARKETS.includes(market)) throw new UnauthorizedException('请选择有效区服');
    const token=randomBytes(32).toString('base64url');const principal:Principal={owner:'demo:'+randomBytes(12).toString('hex'),name,market,mode:'sandbox'};
    this.demos.set(token,{principal,expires:Date.now()+86400000});return {token,principal};
  }
  async authenticate(token: string, cookie?:string): Promise<Principal> {
    if(!token||token.length>8192) throw new UnauthorizedException('请先登录');
    if(!this.gameSessions.has(token)&&!this.siteSessions.has(token)){const saved=this.remembered?.load(token);if(saved?.principal?.mode==='game')this.gameSessions.set(token,saved);else if(saved?.principal?.mode==='site')this.siteSessions.set(token,saved);}
    const game=this.gameSessions.get(token);
    if(game) {
      if(game.expires<=Date.now()) {this.revoke(token);throw new UnauthorizedException('游戏会话已失效');}
      const profile=await this.request('/api/auth/game-profile',undefined,undefined,game.gameToken);
      if(this.resolveOwner(profile.subject,game.principal.market,'game:'+profile.user.id)!==game.principal.owner) {this.revoke(token);throw new UnauthorizedException('账号绑定已变化，请重新登录');}
      return game.principal;
    }
    if(this.config.sandbox) {const demo=this.demos.get(token);if(demo&&demo.expires>Date.now()) return demo.principal;throw new UnauthorizedException('沙盒会话已失效');}
    const session=this.siteSessions.get(token);if(!session) throw new UnauthorizedException('请重新选择区服角色登录');
    if(session.expires<=Date.now()){this.revoke(token);throw new UnauthorizedException('站点角色会话已过期');}
    const oldClaims=JSON.parse(Buffer.from(session.siteToken.split('.')[1],'base64url').toString('utf8'));
    if(oldClaims.exp<=Date.now()/1000+60&&cookie){
      const linked=await this.request('/api/auth/site-session',{create:false},cookie);
      const claims=await this.verifySiteToken(linked.token);
      if(claims.sub!==oldClaims.sub||claims.sid!==oldClaims.sid||this.resolveOwner('site:'+claims.sub,session.principal.market,'game:'+linked.user?.id)!==session.principal.owner){this.revoke(token);throw new UnauthorizedException('站点账号已变化，请重新登录');}
      session.siteToken=linked.token;if(session.principal.rememberMe)this.remembered?.save(token,session,session.expires);
    }
    await this.verifySiteToken(session.siteToken);return session.principal;
  }
  async createSiteSession(siteToken:string,market:MarketId,name:string,gameSubject?:string,rememberMe=false):Promise<{token:string;principal:Principal}> {
    if(!MARKETS.includes(market)) throw new UnauthorizedException('请选择有效区服');
    const claims=await this.verifySiteToken(siteToken);const token=randomBytes(32).toString('base64url');
    const principal:Principal={owner:this.resolveOwner('site:'+claims.sub,market,gameSubject),name,market,mode:'site',rememberMe};
    const entry={principal,siteToken,expires:Date.now()+(rememberMe?REMEMBER_SECONDS:86400)*1000};this.siteSessions.set(token,entry);if(rememberMe)this.remembered?.save(token,entry,entry.expires);return {token,principal};
  }
  async createGameSession(gameToken:string,market:MarketId,rememberMe=false):Promise<{token:string;principal:Principal}> {
    if(!MARKETS.includes(market)||typeof gameToken!=='string'||gameToken.length>8192) throw new UnauthorizedException('游戏会话无效');
    const profile=await this.request('/api/auth/game-profile',undefined,undefined,gameToken);
    if(typeof profile.subject!=='string'||!profile.subject.match(/^(game|site):[A-Za-z0-9_-]{1,128}$/)||typeof profile.user?.username!=='string'||profile.user.isActive===false) throw new UnauthorizedException('游戏账号不可用');
    const token=randomBytes(32).toString('base64url');const principal:Principal={owner:this.resolveOwner(profile.subject,market,'game:'+profile.user.id),name:profile.user.username,market,mode:'game',rememberMe};
    const entry={principal,gameToken,expires:Date.now()+(rememberMe?REMEMBER_SECONDS:86400)*1000};this.gameSessions.set(token,entry);if(rememberMe)this.remembered?.save(token,entry,entry.expires);return {token,principal};
  }
  async verifySiteToken(token: string): Promise<Record<string,any>> {
    try {
      const parts=token.split('.');if(parts.length!==3||parts.some(part=>!/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));const now=Date.now()/1000;
      if(header.alg!=='EdDSA'||claims.iss!=='https://bobbycn.cc'||claims.aud!=='bobbycn.cc'||typeof claims.sub!=='string'||typeof claims.sid!=='string'||claims.client_id||!Number.isInteger(claims.exp)||!Number.isInteger(claims.iat)||claims.exp<=now||claims.iat>now+60||claims.exp-claims.iat>600) throw new Error();
      const jwks=await this.request('/api/auth/identity/.well-known/jwks.json');const key=jwks.keys?.find((item:any)=>item.kid===header.kid&&item.kty==='OKP'&&item.crv==='Ed25519'&&item.alg==='EdDSA');
      if(!key||!verify(null,Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url'))) throw new Error();
      const active=await this.request('/api/auth/identity/introspect',{token});
      if(active.active!==true||active.sub!==claims.sub||active.sid!==claims.sid) throw new Error();return claims;
    } catch(error) {if(error instanceof HttpException&&(error.getStatus()===429||error.getStatus()>=500)) throw error;throw new UnauthorizedException('站点会话已失效');}
  }
  async request(path: string, body?: unknown, cookie?: string, authorization?:string,clientIp?:string): Promise<any> {
    const headers:Record<string,string>={'Content-Type':'application/json',Origin:this.config.origin};if(cookie) headers.Cookie=cookie;
    if(authorization)headers.Authorization='Bearer '+authorization;
    if(clientIp)headers['X-Forwarded-For']=clientIp;
    try {
      const response=await fetch(new URL(path,this.config.identityBaseUrl),{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000),redirect:'error'});
      const result=await response.json().catch(()=>({}));
      if([400,401,409,429].includes(response.status)) throw new HttpException({message:typeof result.message==='string'?result.message:Array.isArray(result.message)?result.message[0]:'账号认证失败'},response.status);
      if(!response.ok) throw new ServiceUnavailableException('账号服务暂不可用');return result;
    } catch(error) {if(error instanceof HttpException) throw error;throw new ServiceUnavailableException('无法连接账号服务');}
  }
  revoke(token: string): void {this.remembered?.remove(token);this.demos.delete(token);this.siteSessions.delete(token);this.gameSessions.delete(token);}

  // Backend credentials stay on the server; the browser receives only an opaque role session.
  backendToken(token:string):string {
    const value=this.gameSessions.get(token)?.gameToken??this.siteSessions.get(token)?.siteToken;
    if(!value)throw new UnauthorizedException('正式角色会话已失效');return value;
  }
  async forward(token:string,path:string,method='GET',body?:unknown):Promise<any> {
    try {
      const response=await fetch(new URL(path,this.config.identityBaseUrl),{method,
        headers:{'Content-Type':'application/json',Origin:this.config.origin,Authorization:'Bearer '+this.backendToken(token)},
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new HttpException({message:typeof result.message==='string'?result.message:Array.isArray(result.message)?result.message.join('；'):'交易服务暂不可用'},response.status);
      return result;
    }catch(error){if(error instanceof HttpException)throw error;throw new ServiceUnavailableException('交易服务暂不可用，请核对原操作结果后重试');}
  }
}
export function tokenFrom(request: {headers:Record<string,any>}): string {
  const bearer=String(request.headers.authorization??'');if(bearer.startsWith('Bearer ')) return bearer.slice(7);
  const realm=String(request.headers['x-game-realm']??'CN');const name=['CN','HK','US'].includes(realm)?'rgp-role-'+realm:'rgp-demo';
  const cookies=String(request.headers.cookie??'').split(';').map(item=>item.trim());const cookie=cookies.find(item=>item.startsWith(name+'='))??cookies.find(item=>item.startsWith('rgp-demo='));return cookie?decodeURIComponent(cookie.slice(cookie.indexOf('=')+1)):'';
}
