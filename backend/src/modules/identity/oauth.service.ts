import { Inject, Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';

import { Identity, IdentityProvider, IdentityStatus } from '../../infrastructure/database/entities/identity.entity';
import { OAuthClient, OAuthClientType } from '../../infrastructure/database/entities/oauth-client.entity';
import { OAuthCode } from '../../infrastructure/database/entities/oauth-code.entity';
import { OAuthGrant } from '../../infrastructure/database/entities/oauth-grant.entity';
import { OAuthRefreshToken } from '../../infrastructure/database/entities/oauth-refresh-token.entity';
import { Session } from '../../infrastructure/database/entities/session.entity';

import { IdentityService } from './identity.service';
import { IdentityJwtService, TokenSigningUnavailableError } from './jwt.service';
import { TokenService } from './token.service';

// ───────────────────────── 常量 ─────────────────────────

/** 授权码 TTL：够浏览器跳回来就行，越短越安全（RFC 6749 建议 ≤ 10 分钟） */
export const OAUTH_CODE_TTL_MS = 120 * 1000;
/** 刷新令牌 TTL：30 天。游戏存档/长期登录态的寿命由它决定，access token 只活 10 分钟 */
export const OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 授权关系默认有效期（免二次确认窗口）：同样 30 天，和刷新令牌对齐 */
export const OAUTH_GRANT_TTL_MS = OAUTH_REFRESH_TTL_MS;

/** 站点支持的 scope 全集（未知 scope 一律 invalid_scope，不做静默降级） */
export const OAUTH_SCOPES: Record<string, string> = {
    openid: '你的站点身份标识（sub）',
    profile: '用户名与昵称',
    email: '邮箱地址与验证状态',
    saves: '云存档（读写你的游戏存档）',
    arcade: '游戏厅统一登录（站点账号授权进游戏厅）',
};

/** 站点登录页（未登录时 authorize 把浏览器送到这里，并带上 next 回跳） */
const SITE_LOGIN_PATH = '/login/';
/** 未登录时 next 参数允许回跳的路径前缀（只管本站相对路径，杜绝开放重定向） */
const NEXT_ALLOWED_PREFIXES = ['/api/auth/identity/oauth/', '/games/', '/admin/', '/secret/'];

interface ClientSpec {
    clientId: string;
    name: string;
    redirectUris: string[];
    scopes: string[];
    firstParty: boolean;
}

/**
 * 第一方客户端种子：**加一个站内游戏 = 在这里加一行 + 前端引 SDK**。
 * 回调地址按「路径」登记（同源不限域名）：bobbycn.cc / bobbychina.github.io / staging 都能用同一份代码，
 * 而**跨源**回调不在种子里 —— 那是第三方应用走的手工注册流程，不该由代码自动放行。
 */
export function builtinClients(): ClientSpec[] {
    const paths: Record<string, { name: string; dir: string }> = {
        'bobbycn-games': { name: 'bobbycn.cc 游戏厅', dir: '/games/' },
        'zombie-survival': { name: '僵尸生存（bobbycn.cc）', dir: '/games/zombie-survival/' },
        'dreamcore-walk': { name: 'Dreamcore Walk（bobbycn.cc）', dir: '/games/dreamcore/' },
        'vampire-survivors': { name: '吸血鬼幸存者（bobbycn.cc）', dir: '/games/vampire-survivors/' },
        'racing3d': { name: '3D 赛车（bobbycn.cc）', dir: '/games/racing3d/' },
    };
    const origins = [
        'https://bobbycn.cc',
        'https://www.bobbycn.cc',
        'https://staging.bobbycn.cc',
        'https://bobbychina.github.io',
        // 本机开发：门户静态站 + 同源预览服务器（tools/_local-site.mjs 把 /api 反代到后端）
        'http://localhost:5180',
        'http://127.0.0.1:5180',
        'http://localhost:5199',
        'http://127.0.0.1:5199',
        'http://localhost:5200',
        'http://127.0.0.1:5200',
        'http://localhost:8080',
    ];
    const redirect = (dir: string) => origins.map((o) => o + dir + 'oauth-callback.html');
    return Object.entries(paths).map(([clientId, meta]) => ({
        clientId,
        name: meta.name,
        // One callback page owns routing back to every game; retain old URIs for compatibility.
        redirectUris: Array.from(new Set([...redirect(meta.dir), ...redirect('/games/')])),
        scopes: ['openid', 'profile', 'email', 'saves', 'arcade'],
        firstParty: true,
    }));
}

// ───────────────────────── 内部类型 ─────────────────────────

export interface AuthorizeParams {
    clientId?: string;
    redirectUri?: string;
    responseType?: string;
    scope?: string;
    state?: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
}

export type AuthorizeResolution =
    /** 直接 302 回客户端（出错时带 error/error_description，成功时带 code） */
    | { kind: 'redirect'; location: string; code?: string }
    /** 参数没问题、需要用户点「同意」（或需要先登录）→ 由 controller 渲染页面 */
    | { kind: 'page'; client: OAuthClient; scopes: string[]; params: Required<Pick<AuthorizeParams, 'clientId' | 'redirectUri' | 'scope'>> & AuthorizeParams; state?: string }
    /** 请求本身无法受理（连回调地址都不可信）→ 400 纯文本，绝不跳转 */
    | { kind: 'error'; status: number; message: string };

export interface TokenResult {
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token?: string;
    scope: string;
    id_token?: string;
}

/**
 * OAuth 错误（RFC 6749 §5.2 的 error / error_description 形状）。
 * 直接实现 HttpException 接口而不是继承 BadRequestException：状态码因错误类型而不同
 * （invalid_client=401、temporarily_unavailable=503、其余 400），继承某个具体子类会把状态码写死。
 * 与 statusCode 一样，`message` 也带上可读文案 —— Nest 的默认 message 是 "Auth Error"，
 * 排障时完全看不出发生了什么。
 */
export class OAuthError extends Error {
    readonly statusCode: number;
    readonly response: { error: string; error_description: string; statusCode: number };

    constructor(public readonly error: string, description: string, status = 400) {
        super(`${error}: ${description}`);
        this.name = 'OAuthError';
        this.statusCode = status;
        this.response = { error, error_description: description, statusCode: status };
    }

    getStatus(): number {
        return this.statusCode;
    }

    getResponse(): { error: string; error_description: string; statusCode: number } {
        return this.response;
    }
}

@Injectable()
export class OauthService implements OnModuleInit {
    private readonly logger = new Logger('Oauth');

    constructor(
        @InjectRepository(OAuthClient) private readonly clients: Repository<OAuthClient>,
        @InjectRepository(OAuthCode) private readonly codes: Repository<OAuthCode>,
        @InjectRepository(OAuthGrant) private readonly grants: Repository<OAuthGrant>,
        @InjectRepository(OAuthRefreshToken) private readonly refresh: Repository<OAuthRefreshToken>,
        @InjectRepository(Identity) private readonly identities: Repository<Identity>,
        @InjectRepository(Session) private readonly sessions: Repository<Session>,
        private readonly identityService: IdentityService,
        private readonly jwt: IdentityJwtService,
        private readonly tokens: TokenService,
    ) {}

    async onModuleInit(): Promise<void> {
        try {
            await this.seedBuiltinClients();
        }
        catch (e: any) {
            // 种子失败不该拦住启动：授权流程会以 invalid_client 报错，是可见且可排查的
            this.logger.error(`第一方客户端种子写入失败：${e && e.message ? e.message : String(e)}`);
        }
    }

    /** 幂等写入第一方客户端：已存在则只补齐回调地址/scope（不覆盖 name 之外的手工改动） */
    async seedBuiltinClients(): Promise<number> {
        let written = 0;
        for (const spec of builtinClients()) {
            const existing = await this.clients.findOne({ where: { clientId: spec.clientId } });
            if (existing) {
                const before = JSON.stringify([existing.redirectUris, existing.scopes, existing.name]);
                existing.redirectUris = spec.redirectUris;
                existing.scopes = spec.scopes;
                existing.name = spec.name;
                if (JSON.stringify([spec.redirectUris, spec.scopes, spec.name]) !== before) {
                    await this.clients.save(existing);
                    written += 1;
                }
                continue;
            }
            await this.clients.save(this.clients.create({
                clientId: spec.clientId,
                name: spec.name,
                type: OAuthClientType.PUBLIC,
                clientSecretHash: null,
                redirectUris: spec.redirectUris,
                scopes: spec.scopes,
                requirePkce: true,
                active: true,
                firstParty: spec.firstParty,
            }));
            written += 1;
            this.logger.log(`已注册第一方客户端：${spec.clientId}（${spec.name}）`);
        }
        return written;
    }

    // ───────────────────────── 客户端与回调校验 ─────────────────────────

    async findClient(clientId: string): Promise<OAuthClient | null> {
        const id = String(clientId || '').trim();
        if (!id)
            return null;
        const row = await this.clients.findOne({ where: { clientId: id } });
        return row && row.active ? row : null;
    }

    /** 公开信息（同意页用；不含 secret 与哈希） */
    toPublicClient(client: OAuthClient) {
        return {
            clientId: client.clientId,
            name: client.name,
            firstParty: !!client.firstParty,
            scopes: Array.isArray(client.scopes) ? [...client.scopes] : [],
        };
    }

    /**
     * 回调地址**精确匹配**（大小写敏感、不容许额外参数）。
     * 开放重定向是授权系统里最容易被利用的一环：宁可让接入方多登记一条，也不做前缀/通配匹配。
     */
    resolveRedirectUri(client: OAuthClient, requested?: string): string {
        const list = Array.isArray(client.redirectUris) ? client.redirectUris.map((x) => String(x)) : [];
        const want = String(requested || '').trim();
        if (!want)
            throw new OAuthError('invalid_request', '缺少 redirect_uri（该客户端登记了多个回调地址，必须明确指定）');
        if (!list.includes(want))
            throw new OAuthError('invalid_request', 'redirect_uri 未在客户端登记的回调地址列表中');
        return want;
    }

    /** 只保留客户端被允许的 scope；未登记/未支持的 scope 直接报错（不静默缩小） */
    resolveScopes(client: OAuthClient, requested?: string): string[] {
        const allowed = new Set((Array.isArray(client.scopes) ? client.scopes : []).map((s) => String(s)));
        const asked = String(requested || '').trim()
            ? String(requested).trim().split(/\s+/).filter(Boolean)
            : ['openid', 'profile'];
        const out: string[] = [];
        for (const scope of asked) {
            if (!OAUTH_SCOPES[scope] || !allowed.has(scope))
                throw new OAuthError('invalid_scope', `不支持的 scope：${scope}`);
            if (!out.includes(scope))
                out.push(scope);
        }
        if (!out.length)
            throw new OAuthError('invalid_scope', '至少要申请一个 scope');
        return out;
    }

    // ───────────────────────── /authorize ─────────────────────────

    /**
     * 校验授权请求。
     * 关键分别：**客户端与回调地址都可信之后**才允许用 302 回客户端报错（RFC 6749 §4.1.2.1）；
     * 一旦这两者有问题，只能是 400 页面 —— 否则攻击者可以拿我们的域名做跳板。
     */
    async resolveAuthorize(params: AuthorizeParams, session: Session | null): Promise<AuthorizeResolution> {
        const client = await this.findClient(String(params.clientId || ''));
        if (!client)
            return { kind: 'error', status: 400, message: 'invalid_client：客户端未注册或已停用' };

        let redirectUri: string;
        try {
            redirectUri = this.resolveRedirectUri(client, params.redirectUri);
        }
        catch (e: any) {
            return { kind: 'error', status: 400, message: e?.message || 'redirect_uri 不合法' };
        }

        const fail = (error: string, description: string): AuthorizeResolution =>
            ({ kind: 'redirect', location: this.redirectWith(redirectUri, { error, error_description: description, state: params.state }) });

        if (String(params.responseType || '') !== 'code')
            return fail('unsupported_response_type', '本站只支持 response_type=code');

        let scopes: string[];
        try {
            scopes = this.resolveScopes(client, params.scope);
        }
        catch (e: any) {
            return fail('invalid_scope', '申请的 scope 不被该客户端允许');
        }

        const requirePkce = client.requirePkce || client.type === OAuthClientType.PUBLIC;
        const method = String(params.codeChallengeMethod || '').trim();
        const challenge = String(params.codeChallenge || '').trim();
        if (requirePkce) {
            if (!challenge)
                return fail('invalid_request', '公开客户端必须使用 PKCE（缺少 code_challenge）');
            if (method !== 'S256')
                return fail('invalid_request', '只接受 code_challenge_method=S256');
            if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
                return fail('invalid_request', 'code_challenge 格式不合法');
        }
        else if (challenge && (method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))) {
            return fail('invalid_request', 'code_challenge 格式不合法（只接受 S256）');
        }

        // 没登录 → 交给 controller 渲染/跳转登录页（带上 next 回跳）
        if (!session)
            return { kind: 'page', client, scopes, params: { ...params, clientId: client.clientId, redirectUri, scope: scopes.join(' ') }, state: params.state };

        // 已登录且之前同意过同一组 scope → 直接发码，不再打扰用户（GitHub/微软同款体验）
        const grant = await this.grants.findOne({ where: { identityId: session.identityId, clientId: client.clientId } });
        const granted = grant && !grant.revokedAt ? new Set(String(grant.scopes || '').split(/\s+/).filter(Boolean)) : new Set<string>();
        const fresh = grant && !grant.revokedAt && Date.now() - new Date(grant.grantedAt).getTime() < OAUTH_GRANT_TTL_MS;
        if (fresh && scopes.every((s) => granted.has(s))) {
            const code = await this.issueCode(client, session, redirectUri, scopes, challenge || null, method || null);
            return { kind: 'redirect', location: this.redirectWith(redirectUri, { code, state: params.state }), code };
        }

        return { kind: 'page', client, scopes, params: { ...params, clientId: client.clientId, redirectUri, scope: scopes.join(' ') }, state: params.state };
    }

    private redirectWith(base: string, params: Record<string, string | undefined>): string {
        const url = new URL(base);
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || value === '')
                continue;
            url.searchParams.set(key, String(value));
        }
        return url.toString();
    }

    /**
     * 站点登录页地址（未登录时把人送去登录，登录后按 next 回到授权流程）。
     *
     * 只允许回跳到白名单前缀，杜绝拿 next 做开放重定向。
     * `SITE_LOGIN_BASE` 可覆盖登录页所在源：本机开发时页面在门户静态站（另一个端口），
     * 线上默认与授权端点同源，不需要配。
     */
    loginUrlFor(next: string, origin?: string): string {
        const target = String(next || '');
        const ok = target.startsWith('/') && !target.startsWith('//') && NEXT_ALLOWED_PREFIXES.some((p) => target.startsWith(p));
        const base = String(process.env.SITE_LOGIN_BASE || '').replace(/\/+$/, '') || String(origin || '').replace(/\/+$/, '');
        const path = ok ? `${SITE_LOGIN_PATH}?next=${encodeURIComponent(target)}` : SITE_LOGIN_PATH;
        return base ? `${base}${path}` : path;
    }

    // ───────────────────────── 授权码 ─────────────────────────

    async issueCode(client: OAuthClient, session: Session, redirectUri: string, scopes: string[], challenge: string | null, method: string | null): Promise<string> {
        const plain = this.tokens.newToken();
        await this.codes.save(this.codes.create({
            codeHash: this.tokens.sha256(plain),
            clientId: client.clientId,
            identityId: session.identityId,
            sessionId: session.id,
            redirectUri,
            codeChallenge: challenge,
            codeChallengeMethod: challenge ? (method || 'S256') : null,
            scope: scopes.join(' '),
            expiresAt: this.tokens.expiryFromNow(OAUTH_CODE_TTL_MS),
            usedAt: null,
        }));
        return plain;
    }

    /** 同意页点「允许」：确认会话仍然有效 → 写授权关系 → 发码 */
    async approve(params: AuthorizeParams, session: Session): Promise<{ location: string }> {
        const client = await this.findClient(String(params.clientId || ''));
        if (!client)
            throw new OAuthError('invalid_client', '客户端未注册或已停用');
        const redirectUri = this.resolveRedirectUri(client, params.redirectUri);
        const scopes = this.resolveScopes(client, params.scope);
        const challenge = String(params.codeChallenge || '').trim() || null;
        const method = challenge ? String(params.codeChallengeMethod || 'S256') : null;

        await this.upsertGrant(session.identityId, client.clientId, scopes);
        const code = await this.issueCode(client, session, redirectUri, scopes, challenge, method);
        return { location: this.redirectWith(redirectUri, { code, state: params.state }) };
    }

    /** 同意页点「拒绝」：按 RFC 6749 §4.1.2.1 用 error=access_denied 回客户端 */
    async deny(params: AuthorizeParams): Promise<{ location: string }> {
        const client = await this.findClient(String(params.clientId || ''));
        if (!client)
            throw new OAuthError('invalid_client', '客户端未注册或已停用');
        const redirectUri = this.resolveRedirectUri(client, params.redirectUri);
        return { location: this.redirectWith(redirectUri, { error: 'access_denied', error_description: '用户拒绝了本次授权', state: params.state }) };
    }

    /**
     * 写授权关系（同意后调用）。
     *
     * ⚠️ 这里刻意用 `update()` 而不是 `save()`：SQLite 下 datetime 列读回来是**字符串**，
     * 而 `save()` 的变化检测会把「字符串 ↔ Date」判成"没变"从而**跳过 UPDATE** ——
     * 同一坑在 revokeGrantFor 上已经实测踩到过（撤销写不进库 = 撤销无效）。
     */
    private async upsertGrant(identityId: string, clientId: string, scopes: string[]): Promise<OAuthGrant> {
        const grant = await this.grants.findOne({ where: { identityId, clientId } });
        const now = new Date();
        if (grant) {
            await this.grants.update({ id: grant.id }, { scopes: scopes.join(' '), grantedAt: now, revokedAt: null });
            grant.scopes = scopes.join(' ');
            grant.grantedAt = now;
            grant.revokedAt = null;
            return grant;
        }
        return this.grants.save(this.grants.create({
            identityId, clientId, scopes: scopes.join(' '), grantedAt: now, revokedAt: null,
        }));
    }

    // ───────────────────────── /token ─────────────────────────

    /**
     * 授权码换令牌（grant_type=authorization_code）。
     * 校验顺序（任一不过即 invalid_grant，不区分原因）：码存在 → 未用过未过期 → client 一致 →
     * redirect_uri 逐字一致 → PKCE verifier 对得上 → 会话仍然有效。
     */
    async exchangeCode(input: {
        clientId?: string;
        clientSecret?: string;
        code?: string;
        redirectUri?: string;
        codeVerifier?: string;
    }): Promise<TokenResult> {
        const client = await this.authenticateClient(input.clientId, input.clientSecret);
        const plain = String(input.code || '').trim();
        if (!plain)
            throw new OAuthError('invalid_request', '缺少 code');

        const row = await this.codes.findOne({ where: { codeHash: this.tokens.sha256(plain) } });
        if (!row || row.clientId !== client.clientId)
            throw new OAuthError('invalid_grant', '授权码无效或已过期');
        if (row.usedAt)
            throw new OAuthError('invalid_grant', '授权码已被使用');
        if (new Date(row.expiresAt).getTime() <= Date.now())
            throw new OAuthError('invalid_grant', '授权码无效或已过期');

        const redirectUri = String(input.redirectUri || '').trim();
        if (redirectUri !== row.redirectUri)
            throw new OAuthError('invalid_grant', 'redirect_uri 与授权时不一致');

        if (row.codeChallenge) {
            const verifier = String(input.codeVerifier || '').trim();
            if (!verifier)
                throw new OAuthError('invalid_grant', '缺少 code_verifier');
            if (!this.pkceMatches(verifier, row.codeChallenge, row.codeChallengeMethod || 'S256'))
                throw new OAuthError('invalid_grant', 'code_verifier 校验失败');
        }

        // 先烧码再发令牌：并发双击时后到者必被拒
        const consumed = await this.codes.createQueryBuilder().update()
            .set({ usedAt: new Date() }).where('codeHash = :hash', { hash: row.codeHash })
            .andWhere('usedAt IS NULL').execute();
        if (consumed.affected !== 1) throw new OAuthError('invalid_grant', '授权码已被使用');

        const session = await this.loadUsableSession(row.sessionId, row.identityId);
        if (!session)
            throw new OAuthError('invalid_grant', '登录会话已失效，请重新授权');

        const scopes = String(row.scope || '').split(/\s+/).filter(Boolean);
        const grant = await this.upsertGrant(row.identityId, client.clientId, scopes);
        return this.issueTokens(client, row.identityId, session, scopes, grant);
    }

    /**
     * 刷新令牌（grant_type=refresh_token）：**一次性轮换** + 重放检测。
     * 拿一张用过的刷新令牌来换 → 视为泄露 → 同一 grant 下全部刷新令牌作废。
     */
    async refreshTokens(input: { clientId?: string; clientSecret?: string; refreshToken?: string }): Promise<TokenResult> {
        const client = await this.authenticateClient(input.clientId, input.clientSecret);
        const plain = String(input.refreshToken || '').trim();
        if (!plain)
            throw new OAuthError('invalid_request', '缺少 refresh_token');

        const row = await this.refresh.findOne({ where: { tokenHash: this.tokens.sha256(plain) } });
        if (!row || row.clientId !== client.clientId)
            throw new OAuthError('invalid_grant', '刷新令牌无效');
        if (row.revokedAt)
            throw new OAuthError('invalid_grant', '刷新令牌已失效');
        if (row.usedAt) {
            // 重放：同一 grant 的令牌全部作废，用户需重新授权（宁可让用户重登一次，也不让被复制的令牌继续换）
            this.logger.warn(`检测到刷新令牌重放（client=${client.clientId}），已作废该授权下全部刷新令牌`);
            await this.revokeGrantTokens(row.grantId);
            throw new OAuthError('invalid_grant', '刷新令牌已被使用过，请重新授权');
        }
        if (new Date(row.expiresAt).getTime() <= Date.now())
            throw new OAuthError('invalid_grant', '刷新令牌已过期，请重新授权');

        const grant = await this.grants.findOne({ where: { id: row.grantId } });
        if (!grant || grant.revokedAt)
            throw new OAuthError('invalid_grant', '授权已被撤销，请重新授权');

        const consumed = await this.refresh.createQueryBuilder().update()
            .set({ usedAt: new Date() }).where('tokenHash = :hash', { hash: row.tokenHash })
            .andWhere('usedAt IS NULL').andWhere('revokedAt IS NULL').execute();
        if (consumed.affected !== 1) {
            await this.revokeGrantTokens(row.grantId);
            throw new OAuthError('invalid_grant', '刷新令牌已被使用过，请重新授权');
        }

        const session = await this.loadUsableSessionForIdentity(row.identityId);
        if (!session)
            throw new OAuthError('invalid_grant', '登录会话已失效，请重新登录');

        const scopes = String(row.scope || '').split(/\s+/).filter(Boolean);
        return this.issueTokens(client, row.identityId, session, scopes, grant);
    }

    private async issueTokens(client: OAuthClient, identityId: string, session: Session, scopes: string[], grant: OAuthGrant): Promise<TokenResult> {
        const scope = scopes.join(' ');
        let access: { token: string; expiresIn: number };
        try {
            access = this.jwt.issue(identityId, session.id, Date.now(), { client_id: client.clientId, scope });
        }
        catch (e) {
            if (e instanceof TokenSigningUnavailableError) {
                // 私钥缺失是部署态问题：按 OAuth 规范回 503 + temporarily_unavailable，让客户端知道可以重试
                throw new OAuthError('temporarily_unavailable', e.message, 503);
            }
            throw e;
        }

        const refreshPlain = this.tokens.newToken();
        await this.refresh.save(this.refresh.create({
            tokenHash: this.tokens.sha256(refreshPlain),
            clientId: client.clientId,
            identityId,
            grantId: grant.id,
            scope,
            expiresAt: this.tokens.expiryFromNow(OAUTH_REFRESH_TTL_MS),
            usedAt: null,
            revokedAt: null,
        }));

        const out: TokenResult = {
            access_token: access.token,
            token_type: 'Bearer',
            expires_in: access.expiresIn,
            refresh_token: refreshPlain,
            scope,
        };
        // openid（OIDC 风味）：id_token 与 access_token 同构，额外带身份快照 —— 客户端一次验签就能显示用户名
        if (scopes.includes('openid')) {
            const identity = await this.identities.findOne({ where: { id: identityId } });
            out.id_token = access.token;
            if (identity)
                (out as any).user = this.publicProfile(identity, scopes);
        }
        return out;
    }

    /**
     * 撤销刷新令牌（RFC 7009 的 token_type_hint=refresh_token）。
     * 语义选择：撤销一张刷新令牌 = **解除该客户端的整条授权**（授权关系 + 该 grant 下全部刷新令牌）。
     * 理由：客户端调这个接口的场景就是"用户要断开这个应用"；只废一张令牌会留下一个
     * "看起来还连着、其实换不出令牌"的僵尸授权，反而更容易出问题。
     */
    async revoke(input: { clientId?: string; clientSecret?: string; token?: string }): Promise<{ revoked: boolean }> {
        const client = await this.authenticateClient(input.clientId, input.clientSecret);
        const plain = String(input.token || '').trim();
        if (!plain)
            return { revoked: false };
        const row = await this.refresh.findOne({ where: { tokenHash: this.tokens.sha256(plain) } });
        if (!row || row.clientId !== client.clientId)
            return { revoked: false };
        return this.revokeGrantFor(row.identityId, row.clientId);
    }

    /** 用户主动解除某客户端授权：授权关系 + 该 grant 下所有刷新令牌一并作废（幂等） */
    async revokeGrantFor(identityId: string, clientId: string): Promise<{ revoked: boolean }> {
        const grant = await this.grants.findOne({ where: { identityId, clientId } });
        if (!grant || grant.revokedAt)
            return { revoked: false };
        // 与 upsertGrant 同因：必须用 update() —— save() 会因"字符串 vs Date"判定未变化而跳过写库
        await this.grants.update({ id: grant.id }, { revokedAt: new Date() });
        await this.revokeGrantTokens(grant.id);
        this.logger.log(`已解除授权：identity=${identityId} client=${clientId}`);
        return { revoked: true };
    }

    private async revokeGrantTokens(grantId: string): Promise<void> {
        // Persist revocation on the grant too: a concurrent issuer may insert after
        // the token UPDATE, but that late token must still be unusable.
        await this.grants.update({ id: grantId }, { revokedAt: new Date() });
        await this.refresh.createQueryBuilder()
            .update()
            .set({ revokedAt: new Date() })
            .where('grantId = :grantId AND revokedAt IS NULL', { grantId })
            .execute();
    }

    // ───────────────────────── 客户端鉴权 / PKCE / 会话 ─────────────────────────

    private async authenticateClient(clientId?: string, clientSecret?: string): Promise<OAuthClient> {
        const client = await this.findClient(String(clientId || ''));
        if (!client)
            throw new OAuthError('invalid_client', '客户端未注册或已停用', 401);
        const secret = String(clientSecret || '');
        if (client.type === OAuthClientType.CONFIDENTIAL) {
            const expected = String(client.clientSecretHash || '');
            const got = secret ? createHash('sha256').update(secret, 'utf8').digest('hex') : '';
            if (!expected || !got || !this.safeEqualHex(expected, got))
                throw new OAuthError('invalid_client', 'client_secret 不正确', 401);
        }
        else if (secret && !client.clientSecretHash) {
            // public 客户端不该带 secret：带了就忽略（不报错，兼容某些 SDK 的默认行为）
        }
        else if (client.clientSecretHash && !this.safeEqualHex(String(client.clientSecretHash), createHash('sha256').update(secret, 'utf8').digest('hex'))) {
            throw new OAuthError('invalid_client', 'client_secret 不正确', 401);
        }
        return client;
    }

    private safeEqualHex(a: string, b: string): boolean {
        const ba = Buffer.from(String(a), 'utf8');
        const bb = Buffer.from(String(b), 'utf8');
        if (ba.length !== bb.length)
            return false;
        return timingSafeEqual(ba, bb);
    }

    /** PKCE S256：base64url(sha256(verifier)) === challenge（定长比较，避免计时旁路） */
    pkceMatches(verifier: string, challenge: string | null, method: string): boolean {
        if (!challenge)
            return false;
        if (String(method || 'S256') !== 'S256')
            return false;
        const v = String(verifier || '');
        if (v.length < 43 || v.length > 128)
            return false;
        const computed = createHash('sha256').update(v, 'utf8').digest('base64url');
        return this.safeEqualHex(computed, challenge);
    }

    private async loadUsableSession(sessionId: string, identityId: string): Promise<Session | null> {
        const session = await this.sessions.findOne({ where: { id: sessionId } });
        if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now())
            return null;
        if (session.identityId !== identityId)
            return null;
        const identity = await this.identities.findOne({ where: { id: identityId } });
        if (!identity || identity.status !== IdentityStatus.ACTIVE)
            return null;
        return session;
    }

    /** 刷新时原会话可能已过期：退化为「该身份最近一个有效会话」——只要有它，说明登录态还在 */
    private async loadUsableSessionForIdentity(identityId: string): Promise<Session | null> {
        const identity = await this.identities.findOne({ where: { id: identityId } });
        if (!identity || identity.status !== IdentityStatus.ACTIVE)
            return null;
        const rows = await this.sessions.find({ where: { identityId }, order: { expiresAt: 'DESC' }, take: 5 });
        for (const row of rows) {
            if (!row.revokedAt && new Date(row.expiresAt).getTime() > Date.now())
                return row;
        }
        return null;
    }

    // ───────────────────────── /userinfo ─────────────────────────

    /**
     * 访问令牌 → 身份信息（等价于 OIDC 的 /userinfo）。
     * 下游也可以完全不调这个接口：拉一次 JWKS 本地验签即可（见 keys.service）。
     */
    async userInfo(accessToken: string) {
        const claims = await this.verifyAccessToken(accessToken);
        const identity = await this.identities.findOne({ where: { id: claims.sub } });
        if (!identity || identity.status !== IdentityStatus.ACTIVE)
            throw new UnauthorizedException('令牌无效');
        return this.publicProfile(identity, String(claims.scope || '').split(/\s+/).filter(Boolean));
    }

    /** 验签 +（有 sid 时）确认会话未撤销；返回 claims 供 userinfo / 资源服务复用 */
    async verifyAccessToken(accessToken: string) {
        const token = String(accessToken || '').trim();
        if (!token)
            throw new UnauthorizedException('缺少访问令牌');
        let claims;
        try {
            claims = this.jwt.verify(token);
        }
        catch {
            throw new UnauthorizedException('令牌无效');
        }
        const session = await this.sessions.findOne({ where: { id: claims.sid } });
        // 会话必须存在且未被撤销：我们是唯一签发方，签出来的令牌一定带 sid，
        // "查不到会话"只可能是库被人改过（或令牌自造）—— 一律拒绝，不放行。
        if (!session || session.revokedAt || new Date(session.expiresAt).getTime() <= Date.now())
            throw new UnauthorizedException('令牌无效');
        // 授权被用户撤销后，已发出的短时令牌最多再活 10 分钟 —— 与既有 introspect 语义一致（见 README）
        if (claims.client_id) {
            const grant = await this.grants.findOne({ where: { identityId: claims.sub, clientId: claims.client_id } });
            if (grant && grant.revokedAt)
                throw new UnauthorizedException('授权已被撤销');
        }
        return claims;
    }

    /** 要求令牌带某个 scope（资源服务用；缺失即 403 语义的 Unauthorized） */
    async requireScope(accessToken: string, scope: string) {
        const claims = await this.verifyAccessToken(accessToken);
        const scopes = String(claims.scope || '').split(/\s+/).filter(Boolean);
        if (!scopes.includes(scope))
            throw new UnauthorizedException(`令牌缺少 ${scope} 权限`);
        return claims;
    }

    /** 出参白名单：按 scope 裁剪（email 未授权时不返回邮箱） */
    publicProfile(identity: Identity, scopes: string[]) {
        const has = (s: string) => scopes.includes(s);
        const out: Record<string, any> = { sub: identity.id };
        if (has('profile')) {
            out.username = identity.username || null;
            out.name = identity.username || null;
            out.picture = null;                       // 站点账号暂无头像；GitHub provider 有则回填（见下）
            out.provider = identity.provider;
        }
        if (has('email')) {
            out.email = identity.email || null;
            out.email_verified = !!identity.emailVerifiedAt;
        }
        if (identity.provider === IdentityProvider.GITHUB && has('profile'))
            out.providerUid = identity.providerUid || null;
        return out;
    }

    /** 用户可见的授权列表（未来的「已授权的应用」页用；现在也作为排障端点） */
    async listGrants(identityId: string) {
        const rows = await this.grants.find({ where: { identityId } });
        return rows.map((g) => ({
            clientId: g.clientId,
            scopes: String(g.scopes || '').split(/\s+/).filter(Boolean),
            grantedAt: g.grantedAt,
            revoked: !!g.revokedAt,
        }));
    }

    /** 客户端目录（公开只读）：便于前端/排障确认"这个游戏该用哪个 client_id" */
    async listClients() {
        const rows = await this.clients.find({ order: { clientId: 'ASC' } });
        return rows.filter((c) => c.active).map((c) => this.toPublicClient(c));
    }

    /** 站点登录页用：把 identityId 换算成同意页要显示的名字（邮箱/用户名） */
    async displayNameOf(identityId: string): Promise<string> {
        const identity = await this.identities.findOne({ where: { id: identityId } });
        if (!identity)
            return '';
        return identity.username || identity.email || '';
    }
}
