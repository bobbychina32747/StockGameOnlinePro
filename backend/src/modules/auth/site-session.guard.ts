import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { SiteIdentityClient } from './site-identity.client';

export function extractSiteSessionToken(req: { headers?: { authorization?: unknown; cookie?: unknown } }): string {
    const authorization = String(req.headers?.authorization || '');
    if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
    const cookies = String(req.headers?.cookie || '');
    for (const part of cookies.split(';')) {
        const index = part.indexOf('=');
        if (part.slice(0, index).trim() !== 'sid') continue;
        try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
    }
    return '';
}

@Injectable()
export class SiteSessionGuard implements CanActivate {
    constructor(private readonly site: SiteIdentityClient) {}
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const token = extractSiteSessionToken(req);
        if (!token) throw new UnauthorizedException('缺少站点会话令牌');
        req.session = await this.site.resolveSession(token);
        return true;
    }
}
export const CurrentSiteSession = createParamDecorator((_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest().session);
