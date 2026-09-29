import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { IdentityService } from './identity.service';

// 会话鉴权：Bearer <明文会话令牌> → sha256 → 查 sessions（库里只有哈希，见 C10）。
// 独立于既有 jwt-auth.guard（JWT 体系）：两套鉴权并存，身份模块不接管既有 /api/auth 的 JWT 会话。
//
// 2026-09-28 追加：支持**域级 Cookie** `sid`（Domain=.bobbycn.cc）。
// 目的：登录态要"整个站点"共用（主页 / 博客 / 游戏厅 / game. 子域），子域之间无法共享 localStorage，
// 但能共享一个域级 Cookie；Bearer 仍然保留（脚本/移动端/写作台都能用）。
// 手写 Cookie 解析（不引 cookie-parser）：只需要读一个键，避免为一行代码加依赖。
export const SESSION_COOKIE = 'sid';

export function extractSessionToken(req: any): string {
    const header = String((req && req.headers && req.headers.authorization) || '');
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
    const raw = String((req && req.headers && req.headers.cookie) || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        if (part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return '';
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
    constructor(private readonly identityService: IdentityService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const token = extractSessionToken(req);
        if (!token)
            throw new UnauthorizedException('缺少会话令牌');
        const session = await this.identityService.resolveSession(token);
        // 挂到请求上供 @CurrentIdentity / @CurrentSession 取用；不返回给客户端
        req.identity = session.identity;
        req.session = session;
        return true;
    }
}

export const CurrentIdentity = createParamDecorator((data: string, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const identity = req.identity;
    return data ? identity?.[data] : identity;
});

export const CurrentSession = createParamDecorator((data: string, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const session = req.session;
    return data ? session?.[data] : session;
});
