import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
export interface Principal {owner:string;name:string;token?:string;mode:'sandbox'|'site'}
export interface AuthConfig {sandbox:boolean;identityBaseUrl:string;origin:string;allowedOrigins:string[]}
export class AuthBridge {
  private demos=new Map<string,{principal:Principal;expires:number}>();
  constructor(readonly config:AuthConfig) {}
  assertOrigin(origin?: string): void {if(origin&&!this.config.allowedOrigins.includes(origin)) throw new UnauthorizedException('请求来源不受信任');}
  createDemo(name: string): {token:string;principal:Principal} {
    if(!this.config.sandbox) throw new UnauthorizedException('当前环境未开放沙盒账号');
    if(typeof name!=='string'||name.length<1||name.length>40) throw new UnauthorizedException('演示名称无效');
    const token=randomBytes(32).toString('base64url');const principal:Principal={owner:'demo:'+randomBytes(12).toString('hex'),name,mode:'sandbox'};
    this.demos.set(token,{principal,expires:Date.now()+86400000});return {token,principal};
  }
  async authenticate(token: string): Promise<Principal> {
    if(!token||token.length>8192) throw new UnauthorizedException('请先登录');
    if(this.config.sandbox) {const demo=this.demos.get(token);if(demo&&demo.expires>Date.now()) return demo.principal;throw new UnauthorizedException('沙盒会话已失效');}
    const claims=await this.verifySiteToken(token);
    return {owner:'site:'+claims.sub,name:'站点玩家',token,mode:'site'};
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
    } catch(error) {if(error instanceof ServiceUnavailableException) throw error;throw new UnauthorizedException('站点会话已失效');}
  }
  async request(path: string, body?: unknown, cookie?: string): Promise<any> {
    const headers:Record<string,string>={'Content-Type':'application/json',Origin:this.config.origin};if(cookie) headers.Cookie=cookie;
    try {
      const response=await fetch(new URL(path,this.config.identityBaseUrl),{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000),redirect:'error'});
      if(response.status===401) throw new UnauthorizedException('请登录站点账号');if(!response.ok) throw new ServiceUnavailableException('站点身份服务暂不可用');
      return await response.json();
    } catch(error) {if(error instanceof UnauthorizedException||error instanceof ServiceUnavailableException) throw error;throw new ServiceUnavailableException('无法连接站点身份服务');}
  }
  revoke(token: string): void {this.demos.delete(token);}
}
export function tokenFrom(request: {headers:Record<string,any>}): string {
  const bearer=String(request.headers.authorization??'');if(bearer.startsWith('Bearer ')) return bearer.slice(7);
  const cookie=String(request.headers.cookie??'').split(';').map(item=>item.trim()).find(item=>item.startsWith('rgp-demo='));return cookie?decodeURIComponent(cookie.slice(9)):'';
}
