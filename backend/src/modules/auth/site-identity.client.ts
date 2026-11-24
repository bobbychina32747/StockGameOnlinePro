import { HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SiteAccess { token: string; tokenType: string; expiresIn: number; kid: string }
export interface SiteSession {
    id: string;
    identityId: string;
    expiresAt: string | Date;
    revokedAt?: string | Date | null;
    identity: { id: string; username: string | null; status: string };
    access: SiteAccess;
}
export interface SiteClaims { sub: string; sid: string; exp: number; iat: number; iss: string; aud: string; client_id?: string }

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** An HTTP client of the site's identity contract. No identity database or signing keys. */
@Injectable()
export class SiteIdentityClient {
    constructor(private readonly config: ConfigService) {}

    private async request(endpoint: string, body: unknown, sessionToken?: string): Promise<Record<string, unknown>> {
        let base: URL;
        try {
            const configured = this.config.get<string>('SITE_IDENTITY_URL');
            if (!configured) throw Error();
            base = new URL(configured);
            if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error();
        } catch { throw new ServiceUnavailableException('站点身份服务未配置或地址无效'); }
        try {
            const response = await fetch(new URL('/api/auth/identity/' + endpoint, base), {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
                headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}) },
                body: JSON.stringify(body),
            });
            if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new UnauthorizedException('站点会话已失效'); }
            if (response.status === 429) { await response.body?.cancel(); throw new HttpException('站点身份请求过于频繁，请稍后重试', 429); }
            if (!response.ok) { await response.body?.cancel(); throw new ServiceUnavailableException('站点身份服务暂不可用'); }
            const reader = response.body?.getReader();
            if (!reader) throw Error();
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                size += part.value.byteLength;
                if (size > 65536) { await reader.cancel(); throw Error(); }
                chunks.push(part.value);
            }
            return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw new ServiceUnavailableException('站点身份服务响应无效或连接超时');
        }
    }

    private claims(token: string): SiteClaims {
        try {
            if (typeof token !== 'string' || token.length > 8192) throw Error();
            const parts = token.split('.');
            if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw Error();
            const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
            const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
            const now = Date.now() / 1000;
            if (header.alg !== 'EdDSA' || claims.iss !== 'https://bobbycn.cc' || claims.aud !== 'bobbycn.cc' || claims.client_id !== undefined
                || typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sub) || typeof claims.sid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(claims.sid)
                || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || claims.exp <= now || claims.iat > now + 60
                || claims.exp <= claims.iat || claims.exp - claims.iat > 600) throw Error();
            return claims;
        } catch { throw new UnauthorizedException('站点访问令牌无效'); }
    }

    async verifyAccessToken(token: string): Promise<SiteClaims> {
        const claims = this.claims(token);
        // The authoritative issuer verifies the signature AND current session revocation.
        const active = await this.request('introspect', { token });
        if (active.active !== true || active.sub !== claims.sub || active.sid !== claims.sid || active.exp !== claims.exp) throw new UnauthorizedException('站点会话已失效');
        return claims;
    }

    async resolveSession(token: string): Promise<SiteSession> {
        if (!token || token.length > 8192 || /[\x00-\x1f\x7f]/.test(token)) throw new UnauthorizedException('缺少有效站点会话');
        const data = await this.request('session-context', {}, token);
        const identity = object(data.identity), access = object(data.access);
        const claims = this.claims(access.token as string);
        if (typeof data.id !== 'string' || typeof data.identityId !== 'string' || identity.id !== data.identityId || claims.sub !== data.identityId || claims.sid !== data.id
            || identity.status !== 'active' || (identity.username !== null && typeof identity.username !== 'string')
            || typeof data.expiresAt !== 'string' || !(Date.parse(data.expiresAt) > Date.now())
            || access.tokenType !== 'Bearer' || access.expiresIn !== claims.exp - claims.iat || typeof access.kid !== 'string') throw new UnauthorizedException('站点会话响应不一致');
        return data as unknown as SiteSession;
    }
}
