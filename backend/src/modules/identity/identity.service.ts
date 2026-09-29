import {
    BadRequestException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotImplementedException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import { Repository } from 'typeorm';

import { Identity, IdentityProvider, IdentityStatus } from '../../infrastructure/database/entities/identity.entity';
import { Credential } from '../../infrastructure/database/entities/credential.entity';
import { Session } from '../../infrastructure/database/entities/session.entity';
import { IdentityToken, IdentityTokenPurpose } from '../../infrastructure/database/entities/identity-token.entity';

import { MAILER, Mailer } from './mailer.service';
import { PasswordService } from './password.service';
import { RateLimitService, sleep } from './rate-limit.service';
import { IDENTITY_TOKEN_TTL_MS, SESSION_TTL_MS, TokenService } from './token.service';

// 邮件里链接的前缀（前端页面地址）；只从环境变量读，默认值仅用于本机开发
const APP_BASE_URL_FALLBACK = 'http://localhost:5173';

@Injectable()
export class IdentityService {
    private readonly logger = new Logger(IdentityService.name);

    // pending 身份存活 24h：足够用户去邮箱点链接；过期即回收（释放 email 与 username）。
    // 做成实例字段便于单测覆写成极小值（与既有 auth.service 常量风格一致）。
    PENDING_TTL_MS = 24 * 60 * 60 * 1000;
    /** 一次回收的 pending 行数上限（避免注册高峰期长事务） */
    SWEEP_BATCH = 500;

    constructor(
        @InjectRepository(Identity) private readonly identityRepo: Repository<Identity>,
        @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
        @InjectRepository(Session) private readonly sessionRepo: Repository<Session>,
        @InjectRepository(IdentityToken) private readonly tokenRepo: Repository<IdentityToken>,
        private readonly password: PasswordService,
        private readonly tokens: TokenService,
        private readonly rateLimit: RateLimitService,
        @Inject(MAILER) private readonly mailer: Mailer,
        private readonly config: ConfigService,
    ) {}

    // ───────────────────────── 对外序列化 ─────────────────────────

    /** 出参白名单：口令哈希、令牌哈希、pending 过期时间等内部字段一律不外泄 */
    toSafeIdentity(identity: Identity) {
        if (!identity)
            return identity;
        return {
            id: identity.id,
            email: identity.email,
            emailVerified: !!identity.emailVerifiedAt,
            username: identity.username,
            provider: identity.provider,
            status: identity.status,
            createdAt: identity.createdAt,
        };
    }

    // ───────────────────────── 归一化 ─────────────────────────

    normalizeEmail(email: string): string {
        // 邮箱统一小写去空格：否则 A@X.com 与 a@x.com 会被当成两个账号
        return String(email || '').trim().toLowerCase();
    }

    /** 登录标识归一化：邮箱走小写，用户名同样小写（注册时用户名即小写化存储） */
    normalizeIdentifier(input: { email?: string; username?: string }): string {
        const email = this.normalizeEmail(input?.email || '');
        if (email)
            return email;
        return String(input?.username || '').trim().toLowerCase();
    }

    private appBaseUrl(): string {
        return this.config?.get?.('APP_BASE_URL') || APP_BASE_URL_FALLBACK;
    }

    // ───────────────────────── 注册 / 验证 ─────────────────────────

    /**
     * 注册：建 pending 身份 + 发验证邮件，**不签发会话**（规格 4-1）。
     * 响应恒定，不区分「新建 / 重复注册 / 邮箱已激活」，避免成为账号枚举面。
     */
    async register(email: string, password: string, ip?: string) {
        const mail = this.normalizeEmail(email);
        // 体量限流（IP + 目标邮箱双维度）：拦批量试探某邮箱是否已注册
        this.rateLimit.assertAllowed('register', ip, mail);
        await this.sweepExpiredPendings();

        const existing = await this.identityRepo.findOne({ where: { email: mail } });
        if (existing) {
            if (existing.status === IdentityStatus.PENDING) {
                // 幂等重发：旧的验证链接立即作废，保证「同一时间只有一条可用链接」
                await this.invalidateTokens(existing.id, IdentityTokenPurpose.VERIFY_EMAIL);
                const token = await this.issueIdentityToken(existing.id, IdentityTokenPurpose.VERIFY_EMAIL);
                await this.sendVerifyMail(mail, token);
            }
            // active/disabled：静默受理（不发信、不报错、不透露存在性）
            return this.registerAccepted();
        }

        let identity: Identity;
        try {
            identity = await this.createPendingIdentity(mail, password);
        }
        catch (e) {
            // 并发注册同一邮箱：唯一索引兜底，按幂等语义返回（不外抛数据库错误细节）
            this.logger.warn('注册写入冲突（并发同邮箱），已按幂等受理处理');
            return this.registerAccepted();
        }
        const token = await this.issueIdentityToken(identity.id, IdentityTokenPurpose.VERIFY_EMAIL);
        await this.sendVerifyMail(mail, token);
        return this.registerAccepted();
    }

    private registerAccepted() {
        return { success: true, message: '注册已受理，请查收邮箱完成验证' };
    }

    private async createPendingIdentity(email: string, password: string): Promise<Identity> {
        const identity = this.identityRepo.create({
            email,
            username: await this.deriveUsername(email),
            provider: IdentityProvider.EMAIL,
            providerUid: null,
            status: IdentityStatus.PENDING,
            emailVerifiedAt: null,
            pendingExpiresAt: new Date(Date.now() + this.PENDING_TTL_MS),
        });
        const saved = await this.identityRepo.save(identity);
        await this.credentialRepo.save(this.credentialRepo.create({
            identityId: saved.id,
            passwordHash: await this.password.hash(password),
            totpSecretEnc: null,
            recoveryCodes: '[]',
        }));
        return saved;
    }

    /**
     * 用户名由邮箱 local part 派生（MVP 注册只收 {email,password}）。
     * 冲突时依次追加序号，极端情况加随机后缀，避免同名邮箱反复注册时死循环。
     */
    private async deriveUsername(email: string): Promise<string> {
        const local = String(email).split('@')[0] || 'user';
        const base = (local.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user').slice(0, 40);
        for (let i = 0; i < 20; i++) {
            const candidate = i === 0 ? base : `${base}${i + 1}`;
            const taken = await this.identityRepo.findOne({ where: { username: candidate } });
            if (!taken)
                return candidate;
        }
        return `${base}${randomBytes(3).toString('hex')}`.slice(0, 50);
    }

    /**
     * 回收过期 pending 身份：**释放 email 与 username**（规格：未验证邮箱不得占用账号名）。
     * 不删行——保留为 disabled 审计痕迹（谁在什么时候注册过、从未验证）。
     */
    async sweepExpiredPendings(now = new Date()): Promise<number> {
        const pendings = await this.identityRepo.find({ where: { status: IdentityStatus.PENDING }, take: this.SWEEP_BATCH });
        let released = 0;
        for (const identity of pendings) {
            if (!identity.pendingExpiresAt || new Date(identity.pendingExpiresAt).getTime() > now.getTime())
                continue;
            identity.status = IdentityStatus.DISABLED;
            identity.username = null;
            identity.email = null;
            await this.identityRepo.save(identity);
            // 老链接一并作废：回收后即使邮件被翻出来也不能再激活
            await this.invalidateTokens(identity.id);
            released += 1;
        }
        if (released > 0)
            this.logger.log(`已回收 ${released} 个过期未验证身份（用户名与邮箱已释放）`);
        return released;
    }

    /** 验证邮箱：激活身份 + 签发会话 + 写 emailVerifiedAt（规格 4-2） */
    async verify(token: string, ip?: string, ua?: string) {
        const row = await this.consumeIdentityToken(token, IdentityTokenPurpose.VERIFY_EMAIL);
        const identity = row.identity || await this.identityRepo.findOne({ where: { id: row.identityId } });
        if (!identity)
            throw new BadRequestException('链接无效或已过期，请重新发起');
        if (identity.status === IdentityStatus.DISABLED)
            throw new BadRequestException('该注册已失效，请重新注册');
        if (identity.status === IdentityStatus.PENDING) {
            this.assertPendingNotExpired(identity);
            identity.status = IdentityStatus.ACTIVE;
            identity.emailVerifiedAt = new Date();
            identity.pendingExpiresAt = null; // 已验证：账号名转为长期持有
            await this.identityRepo.save(identity);
        }
        // 已激活状态下重复点击链接也签发新会话（令牌本身已一次性，属于「重新打开链接」的正常诉求）
        const session = await this.issueSession(identity, ip, ua);
        return { ...session, identity: this.toSafeIdentity(identity) };
    }

    // ───────────────────────── 登录 / 会话 ─────────────────────────

    /**
     * 登录：argon2 校验 + 邮箱已验证才签发会话（规格 4-3）。
     * 校验顺序固定为「限流 → 查库 → 口令 → 状态」：邮箱未验证只在口令正确后才会被提示（不构成枚举面）。
     */
    async login(input: { email?: string; username?: string; password: string }, ip?: string, ua?: string) {
        const account = this.normalizeIdentifier(input);
        if (!account)
            throw new BadRequestException('请提供邮箱或用户名');
        // 锁定检查先于一切查库与哈希：锁定期内不跑 argon2（省 CPU 且不可被计时旁路）
        this.rateLimit.assertAllowed('login', ip, account);

        const identity = await this.findByIdentifier(account);
        if (!identity)
            await this.failLogin(ip, account); // 不存在的账号同样计数（防枚举）

        const credential = await this.credentialRepo.findOne({ where: { identityId: identity.id } });
        const ok = credential ? await this.password.verify(credential.passwordHash, String(input?.password || '')) : false;
        if (!ok)
            await this.failLogin(ip, account);

        if (identity.status === IdentityStatus.PENDING) {
            // 规格：未验证邮箱不发会话
            this.assertPendingNotExpired(identity);
            throw new ForbiddenException('邮箱尚未验证，请先完成邮箱验证');
        }
        if (identity.status !== IdentityStatus.ACTIVE)
            throw new ForbiddenException('账号不可用，请联系管理员');

        this.rateLimit.recordSuccess('login', account);
        const session = await this.issueSession(identity, ip, ua);
        return { ...session, identity: this.toSafeIdentity(identity) };
    }

    private assertPendingNotExpired(identity: Identity): void {
        if (identity.pendingExpiresAt && new Date(identity.pendingExpiresAt).getTime() <= Date.now())
            throw new ForbiddenException('注册已过期，请重新注册');
    }

    /** 失败路径统一出口：递增延迟 + 计数（一旦锁定，下一次 assertAllowed 直接 429） */
    private async failLogin(ip: string | undefined, account: string): Promise<never> {
        const delay = this.rateLimit.recordFailure('login', ip, account);
        if (delay > 0)
            await sleep(delay);
        throw new UnauthorizedException('邮箱或密码错误');
    }

    private async findByIdentifier(identifier: string): Promise<Identity | null> {
        const value = String(identifier || '').trim();
        if (!value)
            return null;
        const lower = value.toLowerCase();
        // 邮箱大小写不敏感；用户名按归一化（小写）与原始值各试一次，兼容历史数据
        return this.identityRepo.findOne({
            where: [
                { email: lower },
                { username: lower },
                { username: value },
            ],
        });
    }

    private async issueSession(identity: Identity, ip?: string, ua?: string) {
        const token = this.tokens.newToken();
        const expiresAt = this.tokens.expiryFromNow(SESSION_TTL_MS);
        const saved = await this.sessionRepo.save(this.sessionRepo.create({
            identityId: identity.id,
            tokenHash: this.tokens.sha256(token),
            expiresAt,
            revokedAt: null,
            ua: ua ? String(ua).slice(0, 255) : null,
            ip: ip ? String(ip).slice(0, 64) : null,
        }));
        // 明文令牌只在本次响应出现一次；库里只有 sha256（C10）
        return { token, expiresAt, sessionId: saved.id };
    }

    /** 会话解析（守卫用）：哈希查表 → 未撤销未过期 → 身份仍 active */
    async resolveSession(token: string): Promise<Session> {
        const invalid = new UnauthorizedException('会话已失效，请重新登录');
        if (!token)
            throw invalid;
        const session = await this.sessionRepo.findOne({
            where: { tokenHash: this.tokens.sha256(token) },
            relations: ['identity'],
        });
        if (!session || !this.tokens.isUsable(session))
            throw invalid;
        const identity = session.identity || await this.identityRepo.findOne({ where: { id: session.identityId } });
        if (!identity || identity.status !== IdentityStatus.ACTIVE)
            throw invalid;
        session.identity = identity;
        return session;
    }

    /** 登出：撤销当前会话（幂等——重复登出不再报错） */
    async logout(session: Session) {
        if (session && !session.revokedAt) {
            session.revokedAt = new Date();
            await this.sessionRepo.save(session);
        }
        return { success: true };
    }

    // ───────────────────────── 口令重置 / 修改 ─────────────────────────

    /** 请求重置：无论邮箱是否存在都返回同一响应（规格：不泄露邮箱是否注册） */
    async requestPasswordReset(email: string, ip?: string) {
        const mail = this.normalizeEmail(email);
        this.rateLimit.assertAllowed('reset', ip, mail);
        const identity = await this.identityRepo.findOne({ where: { email: mail, status: IdentityStatus.ACTIVE } });
        if (identity) {
            await this.invalidateTokens(identity.id, IdentityTokenPurpose.RESET_PASSWORD);
            const token = await this.issueIdentityToken(identity.id, IdentityTokenPurpose.RESET_PASSWORD);
            await this.sendResetMail(mail, token);
        }
        return { success: true, message: '如果该邮箱已注册，我们已发送重置邮件' };
    }

    /** 重置口令：改密 + 撤销该账号**全部**会话（规格 4-6） */
    async resetPassword(token: string, password: string, ip?: string) {
        this.rateLimit.assertAllowed('reset-confirm', ip);
        const row = await this.consumeIdentityToken(token, IdentityTokenPurpose.RESET_PASSWORD);
        const identity = row.identity || await this.identityRepo.findOne({ where: { id: row.identityId } });
        const credential = identity ? await this.credentialRepo.findOne({ where: { identityId: identity.id } }) : null;
        if (!identity || !credential || identity.status !== IdentityStatus.ACTIVE)
            throw new BadRequestException('链接无效或已过期，请重新发起');
        credential.passwordHash = await this.password.hash(password);
        await this.credentialRepo.save(credential);
        // 攻击者可能已持有会话，重置必须把它们全部作废
        const revokedSessions = await this.revokeSessions(identity.id);
        return { success: true, revokedSessions };
    }

    /** 已登录改密：要求原口令正确，改完撤销**其它**会话（当前会话保留，避免当场被踢） */
    async changePassword(identityId: string, currentSessionId: string | undefined, oldPassword: string, newPassword: string) {
        const credential = await this.credentialRepo.findOne({ where: { identityId } });
        if (!credential)
            throw new UnauthorizedException('账号状态异常，请重新登录');
        const ok = await this.password.verify(credential.passwordHash, String(oldPassword || ''));
        if (!ok)
            throw new UnauthorizedException('原密码错误');
        credential.passwordHash = await this.password.hash(newPassword);
        await this.credentialRepo.save(credential);
        const revokedSessions = await this.revokeSessions(identityId, currentSessionId);
        return { success: true, revokedSessions };
    }

    private async revokeSessions(identityId: string, exceptSessionId?: string): Promise<number> {
        // 批量 UPDATE 而非逐条 save：撤销是安全动作，必须一次落库（避免中途失败留下活会话）
        const qb = this.sessionRepo.createQueryBuilder()
            .update()
            .set({ revokedAt: new Date() })
            .where('identityId = :identityId AND revokedAt IS NULL', { identityId });
        if (exceptSessionId)
            qb.andWhere('id != :exceptSessionId', { exceptSessionId });
        const res = await qb.execute();
        return res.affected || 0;
    }

    // ───────────────────────── 令牌 ─────────────────────────

    /** 签发一次性身份令牌：明文只返回给调用方（进邮件），库里存 sha256 */
    async issueIdentityToken(identityId: string, purpose: IdentityTokenPurpose, ttlMs = IDENTITY_TOKEN_TTL_MS): Promise<string> {
        const token = this.tokens.newToken();
        await this.tokenRepo.save(this.tokenRepo.create({
            identityId,
            purpose,
            tokenHash: this.tokens.sha256(token),
            expiresAt: this.tokens.expiryFromNow(ttlMs),
            usedAt: null,
        }));
        return token;
    }

    /** 作废某身份未消费的令牌（可只针对某用途）：重发邮件时保证只有最新链接可用 */
    async invalidateTokens(identityId: string, purpose?: IdentityTokenPurpose): Promise<number> {
        const qb = this.tokenRepo.createQueryBuilder()
            .update()
            .set({ usedAt: new Date() })
            .where('identityId = :identityId AND usedAt IS NULL', { identityId });
        if (purpose)
            qb.andWhere('purpose = :purpose', { purpose });
        const res = await qb.execute();
        return res.affected || 0;
    }

    /**
     * 消费令牌（一次性）：不存在 / 用途不符 / 过期 / 已用过 → 统一文案。
     * 先标记 usedAt 再执行业务：并发双击时后到者必然被拒（宁可多烧一个令牌，也不放两次）。
     */
    private async consumeIdentityToken(token: string, purpose: IdentityTokenPurpose): Promise<IdentityToken> {
        const invalid = new BadRequestException('链接无效或已过期，请重新发起');
        const plain = String(token || '');
        if (!plain)
            throw invalid;
        const row = await this.tokenRepo.findOne({
            where: { tokenHash: this.tokens.sha256(plain) },
            relations: ['identity'],
        });
        if (!row || row.purpose !== purpose)
            throw invalid;
        if (row.usedAt) {
            this.logger.warn(`身份令牌被二次使用（已拒绝）：purpose=${row.purpose}`);
            throw invalid;
        }
        if (!this.tokens.isUsable(row))
            throw invalid;
        row.usedAt = new Date();
        await this.tokenRepo.save(row);
        return row;
    }

    // ───────────────────────── 邮件 ─────────────────────────

    private async sendVerifyMail(email: string, token: string): Promise<void> {
        const link = `${this.appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
        await this.safeSend({
            to: email,
            // 品牌是**站点**而不是股票游戏：这个身份系统现在覆盖博客/游戏厅/炒股等全部子站（2026-09-29 改）
            subject: '【bobbycn.cc】验证你的邮箱',
            html: `<p>欢迎注册 bobbycn.cc。</p>`
                + `<p>一个账号走全站：博客、游戏厅、模拟炒股，以及以后的任何东西。</p>`
                + `<p>请点击下面的链接完成邮箱验证（30 分钟内有效，仅可使用一次）：</p>`
                + `<p><a href="${link}">${link}</a></p>`
                + `<p style="color:#8a8a8a;font-size:12px">如果这不是你本人的操作，忽略本邮件即可；这封邮件由系统自动发出，不用回复。</p>`,
        });
    }

    private async sendResetMail(email: string, token: string): Promise<void> {
        const link = `${this.appBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
        await this.safeSend({
            to: email,
            subject: '【bobbycn.cc】重置密码',
            html: `<p>我们收到了重置 bobbycn.cc 账号密码的请求。</p>`
                + `<p>请点击下面的链接设置新密码（30 分钟内有效，仅可使用一次）：</p>`
                + `<p><a href="${link}">${link}</a></p>`
                + `<p style="color:#8a8a8a;font-size:12px">重置后该账号的其它登录状态会全部失效。如果这不是你本人的操作，请忽略本邮件。</p>`,
        });
    }

    private async safeSend(message: { to: string; subject: string; html: string }): Promise<void> {
        try {
            await this.mailer.send(message);
        }
        catch (e) {
            // 发信通道故障不该让注册/重置整体失败（用户可稍后重发），但必须留痕
            this.logger.error(`邮件发送失败（to 已脱敏）：${e && e.message ? e.message : e}`);
        }
    }

    // ───────────────────────── GitHub OAuth（占位） ─────────────────────────

    /**
     * 占位实现：正式接入需要 GH_CLIENT_ID / GH_CLIENT_SECRET 与已注册的回调地址
     * （回调须与 identities(provider=github, providerUid) 的绑定流程配套，见 README 待办）。
     */
    githubStart(ip?: string) {
        this.rateLimit.assertAllowed('claim', ip);
        throw new NotImplementedException('GitHub 登录尚未上线：需配置 GH_CLIENT_ID / GH_CLIENT_SECRET 与回调地址');
    }

    githubCallback(code: string | undefined, ip?: string) {
        this.rateLimit.assertAllowed('claim', ip);
        throw new NotImplementedException('GitHub 回调尚未上线：需配置 GH_CLIENT_ID / GH_CLIENT_SECRET 与回调地址');
    }
}
