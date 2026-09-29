import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';

import { ChangePasswordDto, LoginDto, RegisterDto, ResetPasswordDto, ResetRequestDto, VerifyDto } from './dto/identity.dto';
import { IdentityService } from './identity.service';
import { KeysService } from './keys.service';
import { CurrentIdentity, CurrentSession, SESSION_COOKIE, SessionAuthGuard } from './session-auth.guard';
import { TokenExchangeService } from './token-exchange.service';
import { TurnstileService } from './turnstile.service';

/**
 * 统一身份模块 HTTP 层（全局前缀在 main.ts: app.setGlobalPrefix('api')）。
 *
 * 路由位置（2026-09-28 集成决策）：**暂挂 `/api/auth/identity/*`**，而不是 `/api/auth/*`。
 * 原因：既有 AuthModule 已占用 `POST /api/auth/register` 与 `/api/auth/login`（JWT 体系），Express 由先注册者胜出，
 * 若两者同路径，本模块的 register/login 在 HTTP 层根本摸不到（等于上线了但用不了）。
 * 挂到子路径后：本模块**全端点可达**（可在真机验证注册→验证→登录全链路），老前端一行不受影响。
 * 正式切换（统一账号那一步）：把下面的 'auth/identity' 改回 'auth'，同时从 AuthModule 摘掉那两个路由。
 */
export const IDENTITY_ROUTE_BASE = 'auth/identity';

@Controller(IDENTITY_ROUTE_BASE)
export class IdentityController {
    constructor(
        private readonly identityService: IdentityService,
        private readonly exchange: TokenExchangeService,
        private readonly keys: KeysService,
        private readonly turnstile: TurnstileService,
    ) {}

    /** 写入/清除域级会话 Cookie（全站共用登录态；Bearer 保留给脚本与移动端） */
    private cookieHeader(value: string, maxAgeSec: number): string {
        const domain = process.env.COOKIE_DOMAIN || '';
        const secure = !!domain || process.env.COOKIE_SECURE === '1';
        return [
            `${SESSION_COOKIE}=${value}`,
            'Path=/',
            domain ? `Domain=${domain}` : '',
            `Max-Age=${maxAgeSec}`,
            'HttpOnly',
            'SameSite=Lax',
            secure ? 'Secure' : '',
        ].filter(Boolean).join('; ');
    }

    private setSessionCookie(res: any, out: any) {
        if (!res || !out || !out.token) return;
        const secs = out.expiresAt ? Math.max(0, Math.floor((new Date(out.expiresAt).getTime() - Date.now()) / 1000)) : 2592000;
        res.append?.('Set-Cookie', this.cookieHeader(encodeURIComponent(out.token), secs));
    }

    private clearSessionCookie(res: any) {
        res.append?.('Set-Cookie', this.cookieHeader('', 0));
    }

    /** 注册：建 pending 身份 + 发验证邮件，**不发会话** */
    @Post('register')
    @HttpCode(HttpStatus.OK)
    async register(@Body() dto: RegisterDto, @Req() req: any) {
        // 人机验证先于人机之外的任何查库/发信：机器人不该消耗邮件配额
        await this.turnstile.assertHuman(dto.cfToken, req && req.ip, 'register');
        return this.identityService.register(dto.email, dto.password, req && req.ip);
    }

    /** 验证邮箱：激活 + 签发会话（同时下发域级 Cookie，之后全站都是登录态） */
    @Post('verify')
    @HttpCode(HttpStatus.OK)
    async verify(@Body() dto: VerifyDto, @Req() req: any, @Res({ passthrough: true }) res: any) {
        const out = await this.identityService.verify(dto.token, req && req.ip, req && req.headers && req.headers['user-agent']);
        this.setSessionCookie(res, out);
        return out;
    }

    /** 登录：邮箱或用户名 + 口令（下发域级 Cookie） */
    @Post('login')
    @HttpCode(HttpStatus.OK)
    async login(@Body() dto: LoginDto, @Req() req: any, @Res({ passthrough: true }) res: any) {
        // TODO(人机验证): 登录暂不强制 Turnstile——先把已注册的老用户放进来（他们的前端还没挂 widget），
        // 等前端全量上线后再按 login 的失败率与撞库量决定是否开启（DTO 已能接收 cfToken，无需前端改动）。
        const out = await this.identityService.login(
            { email: dto.email, username: dto.username, password: dto.password },
            req && req.ip,
            req && req.headers && req.headers['user-agent'],
        );
        this.setSessionCookie(res, out);
        return out;
    }

    /** 登出：撤销当前会话（Bearer 或 sid Cookie 都行），并清掉 Cookie */
    @Post('logout')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async logout(@CurrentSession() session: any, @Res({ passthrough: true }) res: any) {
        this.clearSessionCookie(res);
        return this.identityService.logout(session);
    }

    /** 当前身份信息（不含口令/令牌等内部字段） */
    @Get('me')
    @UseGuards(SessionAuthGuard)
    async me(@CurrentIdentity() identity: any) {
        return this.identityService.toSafeIdentity(identity);
    }

    // ───────────── 阶段一：跨服务统一身份（别的服务"一次登录、本地验签"） ─────────────

    /**
     * 公钥集：**公开**端点，不挂守卫、不读 sid Cookie（主域 Cookie 不参与）——
     * 别的服务与 Cloudflare Worker 直接拉这份 JWKS 就能本地验签，不需要任何凭据。
     * 用 @Res() 全手动响应：304 复用与 ETag 必须由我们自己控制，
     * 走 Nest 的 passthrough 会被框架的 json 回写覆盖掉状态码/空响应体。
     */
    @Get('.well-known/jwks.json')
    jwks(@Req() req: any, @Res() res: any) {
        const { body, etag } = this.keys.jwks();
        // 公钥是可公开的长效内容：允许中间缓存 5 分钟（下游也不必每请求都拉）
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('ETag', etag);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // 条件请求：内容哈希一致就 304，省一次传输（ETag 只做等值比较，不解析多值/弱校验）
        if (String(req?.headers?.['if-none-match'] || '') === etag)
            return res.status(304).end();
        return res.status(200).send(body);
    }

    /**
     * 冻结的令牌交换端点：带当前会话（Cookie `sid` 或 `Authorization: Bearer`）换一张 10 分钟的 EdDSA 令牌。
     * 契约已冻结（字段名/tokenType/TTL），后续阶段只允许新增字段，不允许改语义。
     */
    @Post('token')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async token(@CurrentIdentity('id') identityId: string, @CurrentSession('id') sessionId: string) {
        return this.exchange.exchange(identityId, sessionId);
    }

    /**
     * 内省：公开但需携带令牌（body.token），回答"这张令牌现在还有效吗"。
     * 与 jwks 同理，**不读主域 Cookie**：调用方是别的服务/Worker，凭令牌本身说话。
     * 令牌无效 / 已过期 / 会话已撤销 / 账号停用 → 一律 200 + active:false（不抛错、不泄露原因）。
     */
    @Post('introspect')
    @HttpCode(HttpStatus.OK)
    async introspect(@Body('token') token: string) {
        return this.exchange.introspect(String(token || ''));
    }

    /** 请求重置口令：邮箱是否存在都返回同一响应 */
    @Post('password/reset-request')
    @HttpCode(HttpStatus.OK)
    async resetRequest(@Body() dto: ResetRequestDto, @Req() req: any) {
        // 与注册同一道闸：重置邮件同样可被机器人用来轰炸他人邮箱
        await this.turnstile.assertHuman(dto.cfToken, req && req.ip, 'password-reset');
        return this.identityService.requestPasswordReset(dto.email, req && req.ip);
    }

    /** 重置口令：改密 + 撤销该账号全部会话 */
    @Post('password/reset')
    @HttpCode(HttpStatus.OK)
    async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: any) {
        return this.identityService.resetPassword(dto.token, dto.password, req && req.ip);
    }

    /** 修改口令（已登录）：改完撤销其它会话 */
    @Post('password/change')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async changePassword(@Body() dto: ChangePasswordDto, @CurrentIdentity('id') identityId: string, @CurrentSession('id') sessionId: string) {
        return this.identityService.changePassword(identityId, sessionId, dto.oldPassword, dto.newPassword);
    }

    /** GitHub OAuth 入口：占位（501），正式实现需 GH_CLIENT_ID / GH_CLIENT_SECRET 与回调地址 */
    @Get('github/start')
    githubStart(@Req() req: any) {
        return this.identityService.githubStart(req && req.ip);
    }

    /** GitHub OAuth 回调：占位（501）。provider=github 的实体约束与唯一索引已就绪，可直接接流程 */
    @Get('github/callback')
    githubCallback(@Query('code') code: string, @Req() req: any) {
        return this.identityService.githubCallback(code, req && req.ip);
    }
}
