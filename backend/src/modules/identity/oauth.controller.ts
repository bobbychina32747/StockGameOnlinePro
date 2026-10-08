import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';

import { mergeBody, readOAuthForm } from './oauth-form';
import { OAUTH_SCOPES, OauthService } from './oauth.service';
import { CurrentIdentity, SessionAuthGuard, extractSessionToken } from './session-auth.guard';
import { IdentityService } from './identity.service';

/**
 * 授权系统 HTTP 层（2026-10-08）
 *
 * 路径：`/api/auth/identity/oauth/*`（全局前缀 `api` + IdentityController 的 `auth/identity` 口径）。
 * 为什么不另开 `/api/oauth/*`：nginx 现在只把 `^~ /api/auth/identity/` 反代到本机 NestJS
 * （见 /etc/nginx/snippets/blog.conf）。挂在这个前缀下**零 nginx 改动**就能上线；
 * 将来要做标准短路径，只需在 nginx 加一条 location 并把这里的常量换掉。
 *
 * 这一层只做 HTTP 与 HTML：所有判断都在 OauthService 里，便于单测（与 identity 模块同一风格）。
 */
@Controller('auth/identity/oauth')
export class OauthController {
    constructor(
        private readonly oauth: OauthService,
        private readonly identityService: IdentityService,
    ) {}

    // ───────────────────────── 小工具 ─────────────────────────

    private originOf(req: any): string {
        const proto = String((req && req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim() || 'https';
        const host = String((req && req.headers && req.headers.host) || 'bobbycn.cc');
        return `${proto}://${host}`;
    }

    /** 会话（软）：没有会话返回 null，而不是抛 401 —— authorize 要把人送去登录页而不是报错 */
    private async softSession(req: any) {
        const token = extractSessionToken(req);
        if (!token)
            return null;
        try {
            return await this.identityService.resolveSession(token);
        }
        catch {
            return null;
        }
    }

    // ───────────────────────── /authorize ─────────────────────────

    /**
     * 授权入口。三种结果：
     *   ① 302 回客户端（发码 / 报错）；② 渲染同意页；③ 未登录 → 302 到站点登录页（带 next 回跳）。
     * `Accept: application/json` 时未登录回 401 + login_url（给纯 JS 客户端用，避免整页跳转）。
     */
    @Get('authorize')
    async authorize(@Query() q: any, @Req() req: any, @Res() res: any) {
        const params = {
            clientId: q && q.client_id,
            redirectUri: q && q.redirect_uri,
            responseType: q && q.response_type,
            scope: q && q.scope,
            state: q && q.state,
            codeChallenge: q && q.code_challenge,
            codeChallengeMethod: q && q.code_challenge_method,
        };
        const session = await this.softSession(req);
        const result = await this.oauth.resolveAuthorize(params, session);

        if (result.kind === 'error') {
            res.status(result.status).type('text/plain; charset=utf-8').send(result.message);
            return;
        }
        if (result.kind === 'redirect') {
            // 授权码/错误务必不被任何中间层缓存
            res.setHeader('Cache-Control', 'no-store');
            res.redirect(302, result.location);
            return;
        }

        if (!session) {
            // 登录页：线上与授权端点同源；本机开发由 SITE_LOGIN_BASE 指到门户静态站
            const absolute = this.oauth.loginUrlFor(req.originalUrl || req.url || '', this.originOf(req));
            if (String(req.headers && req.headers.accept || '').includes('application/json')) {
                res.status(401).json({ error: 'login_required', login_url: absolute, next: absolute });
                return;
            }
            res.setHeader('Cache-Control', 'no-store');
            res.redirect(302, absolute);
            return;
        }

        const name = await this.oauth.displayNameOf(session.identityId);
        res.setHeader('Cache-Control', 'no-store');
        res.type('text/html; charset=utf-8').send(this.consentPage(result, name, req));
    }

    /** 同意页提交（表单 POST）：approve / deny。表单体由 oauthFormMiddleware 收成 Buffer */
    @Post('authorize')
    @HttpCode(HttpStatus.OK)
    async authorizeSubmit(@Req() req: any, @Res() res: any) {
        const body: Record<string, any> = await readOAuthForm(req);
        const session = await this.softSession(req);
        if (!session) {
            const back = `${this.originOf(req)}/api/auth/identity/oauth/authorize?${new URLSearchParams({
                client_id: String(body.client_id || ''),
                redirect_uri: String(body.redirect_uri || ''),
                response_type: 'code',
                scope: String(body.scope || ''),
                ...(body.state ? { state: String(body.state) } : {}),
                ...(body.code_challenge ? { code_challenge: String(body.code_challenge), code_challenge_method: String(body.code_challenge_method || 'S256') } : {}),
            }).toString()}`;
            const loginUrl = this.oauth.loginUrlFor(new URL(back).pathname + new URL(back).search, this.originOf(req));
            res.setHeader('Cache-Control', 'no-store');
            res.redirect(302, loginUrl);
            return;
        }

        const params = {
            clientId: body.client_id,
            redirectUri: body.redirect_uri,
            responseType: 'code',
            scope: body.scope,
            state: body.state,
            codeChallenge: body.code_challenge,
            codeChallengeMethod: body.code_challenge_method,
        };
        try {
            const out = String(body.decision || '') === 'deny'
                ? await this.oauth.deny(params)
                : await this.oauth.approve(params, session);
            res.setHeader('Cache-Control', 'no-store');
            res.redirect(302, out.location);
        }
        catch (e: any) {
            const err = e && e.getResponse ? e.getResponse() : null;
            const message = err && err.error_description ? `${err.error}：${err.error_description}` : (e?.message || '授权请求无法受理');
            res.status(err && err.statusCode ? err.statusCode : 400).type('text/html; charset=utf-8').send(this.errorPage(message));
        }
    }

    // ───────────────────────── /token ─────────────────────────

    /**
     * 令牌端点：`authorization_code` 与 `refresh_token` 两种 grant。
     * 同时接受 `application/x-www-form-urlencoded`（RFC 6749 要求）与 JSON（方便本机调试与前端）。
     */
    @Post('token')
    @HttpCode(HttpStatus.OK)
    async token(@Req() req: any, @Res() res: any) {
        const input = await readOAuthForm(req);
        const grantType = String(input.grant_type || '');
        // RFC 6749 §5.1：令牌响应绝不能被缓存
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        try {
            const out = grantType === 'refresh_token'
                ? await this.oauth.refreshTokens({
                    clientId: input.client_id, clientSecret: input.client_secret, refreshToken: input.refresh_token,
                })
                : grantType === 'authorization_code'
                    ? await this.oauth.exchangeCode({
                        clientId: input.client_id,
                        clientSecret: input.client_secret,
                        code: input.code,
                        redirectUri: input.redirect_uri,
                        codeVerifier: input.code_verifier,
                    })
                    : null;
            if (!out)
                throw Object.assign(new Error('unsupported_grant_type'), { oauthError: 'unsupported_grant_type' });
            res.status(200).json(out);
        }
        catch (e: any) {
            const payload = e && e.getResponse ? e.getResponse() : null;
            const status = payload && payload.statusCode ? payload.statusCode : (e?.oauthError === 'unsupported_grant_type' ? 400 : 400);
            const error = payload && payload.error ? payload.error : (e?.oauthError || 'invalid_request');
            const description = payload && payload.error_description ? payload.error_description : (e?.message || '请求无法受理');
            res.status(status).json({ error, error_description: description });
        }
    }

    // ───────────────────────── /userinfo ─────────────────────────

    /** 访问令牌 → 身份信息（Bearer；与下游直接验 JWT 等价，这里多一层"授权是否被撤销"的判断） */
    @Get('userinfo')
    async userinfo(@Req() req: any, @Res() res: any) {
        const header = String((req && req.headers && req.headers.authorization) || '');
        const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : String((req && req.query && req.query.access_token) || '');
        res.setHeader('Cache-Control', 'no-store');
        try {
            res.status(200).json(await this.oauth.userInfo(token));
        }
        catch {
            res.status(401).json({ error: 'invalid_token' });
        }
    }

    /** 撤销刷新令牌（RFC 7009）：成功恒 200（不泄露令牌是否存在） */
    @Post('revoke')
    @HttpCode(HttpStatus.OK)
    async revoke(@Req() req: any) {
        const input = await readOAuthForm(req);
        await this.oauth.revoke({ clientId: input.client_id, clientSecret: input.client_secret, token: input.token || input.refresh_token });
        return { revoked: true };
    }

    // ───────────────────────── 授权管理（站点账号维度） ─────────────────────────

    /** 我授权过哪些应用（已登录站点身份才能看） */
    @Get('grants')
    @UseGuards(SessionAuthGuard)
    async grants(@CurrentIdentity('id') identityId: string) {
        return { grants: await this.oauth.listGrants(identityId) };
    }

    /** 解除某个应用的授权（授权关系 + 该应用的刷新令牌一并作废） */
    @Post('revoke-grant')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async revokeGrant(@CurrentIdentity('id') identityId: string, @Body() body: any) {
        const clientId = String((body && body.client_id) || '').trim();
        return this.oauth.revokeGrantFor(identityId, clientId);
    }

    /** 客户端目录（公开只读）：谁可以接入、能申请哪些 scope */
    @Get('clients')
    async clients() {
        return { clients: await this.oauth.listClients(), scopes: OAUTH_SCOPES };
    }

    // ───────────────────────── HTML ─────────────────────────

    private escapeHtml(value: unknown): string {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    private hidden(name: string, value: unknown): string {
        return `<input type="hidden" name="${this.escapeHtml(name)}" value="${this.escapeHtml(value)}">`;
    }

    /**
     * 同意页：**自己渲染**，不引前端框架、不依赖门户页面 —— 授权页是最敏感的一屏，
     * 少一个依赖就少一处可以偷改跳转目标的地方。
     */
    private consentPage(result: Extract<Awaited<ReturnType<OauthService['resolveAuthorize']>>, { kind: 'page' }>, displayName: string, req: any): string {
        const p = result.params;
        const scopeRows = result.scopes.map((s) => `<li><code>${this.escapeHtml(s)}</code><span>${this.escapeHtml(OAUTH_SCOPES[s] || '')}</span></li>`).join('');
        const clientLabel = result.client.firstParty ? '站内应用' : '第三方应用';
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 · bobbycn.cc</title>
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
   background:radial-gradient(1200px 600px at 20% -10%,#1d2a4a 0%,#0b0f1a 60%),#0b0f1a;color:#e8ecf4;
   font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif}
 .card{width:min(560px,100%);background:rgba(19,25,40,.86);border:1px solid #26314b;border-radius:18px;
   padding:28px 26px;box-shadow:0 24px 60px rgba(0,0,0,.45);backdrop-filter:blur(8px)}
 .brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.3px;color:#9fb3d9;font-size:13px;text-transform:uppercase}
 .dot{width:9px;height:9px;border-radius:50%;background:#4ea1ff;box-shadow:0 0 12px #4ea1ff}
 h1{font-size:21px;margin:14px 0 6px}
 .who{color:#9fb3d9;font-size:13px;margin-bottom:18px}
 .who b{color:#e8ecf4}
 ul{list-style:none;padding:0;margin:0 0 22px}
 li{display:flex;gap:12px;align-items:baseline;padding:10px 12px;border:1px solid #26314b;border-radius:10px;margin-bottom:8px;background:#121a2b}
 li code{color:#7fd1ff;font-size:12px;min-width:74px}
 li span{color:#b9c6dd;font-size:13px}
 .row{display:flex;gap:10px}
 button{flex:1;padding:12px 16px;border-radius:11px;border:1px solid #2d3a58;background:#1a2337;color:#e8ecf4;
   font-size:15px;font-weight:600;cursor:pointer;transition:transform .06s ease,filter .15s ease}
 button:hover{filter:brightness(1.15)}
 button:active{transform:translateY(1px)}
 button.primary{background:linear-gradient(180deg,#3d7ff0,#2f66cc);border-color:#4b86ee}
 .foot{margin-top:16px;color:#7b89a6;font-size:12px;text-align:center}
 .foot a{color:#9fb3d9}
</style>
</head>
<body>
<form class="card" method="post" action="/api/auth/identity/oauth/authorize">
  <div class="brand"><span class="dot"></span> bobbycn.cc 统一授权</div>
  <h1>${this.escapeHtml(result.client.name)} 想访问你的账号</h1>
  <div class="who">当前登录：<b>${this.escapeHtml(displayName || '站点账号')}</b> · ${this.escapeHtml(clientLabel)}</div>
  <ul>${scopeRows}</ul>
  ${this.hidden('client_id', p.clientId)}
  ${this.hidden('redirect_uri', p.redirectUri)}
  ${this.hidden('scope', p.scope)}
  ${this.hidden('state', p.state || '')}
  ${this.hidden('code_challenge', p.codeChallenge || '')}
  ${this.hidden('code_challenge_method', p.codeChallengeMethod || '')}
  <div class="row">
    <button type="submit" name="decision" value="deny">拒绝</button>
    <button type="submit" name="decision" value="allow" class="primary">允许</button>
  </div>
  <div class="foot">授权后你可以随时在 <a href="/account/">账号页</a> 解除。access token 只活 10 分钟，长期登录靠可撤销的刷新令牌。</div>
</form>
</body>
</html>`;
    }

    private errorPage(message: string): string {
        return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权失败 · bobbycn.cc</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f1a;color:#e8ecf4;
font:15px/1.6 system-ui,"Noto Sans SC",sans-serif}.c{max-width:520px;padding:26px;border:1px solid #3a2740;border-radius:16px;background:#161020}
h1{font-size:19px;margin:0 0 10px;color:#ff9aa2}p{color:#c9b8cc;word-break:break-all}</style></head>
<body><div class="c"><h1>授权请求无法受理</h1><p>${this.escapeHtml(message)}</p>
<p style="font-size:13px;color:#8d7f92">请回到应用重新发起授权；如果反复出现，请把这段文字发给站主。</p></div></body></html>`;
    }
}
