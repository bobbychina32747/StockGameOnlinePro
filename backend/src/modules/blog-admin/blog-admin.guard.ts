import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { extractSessionToken } from '../identity/session-auth.guard';
import { IdentityService } from '../identity/identity.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

/**
 * 写作台鉴权（2026-09-29）：**站点身份优先**，旧的管理员 JWT 继续可用。
 *
 * 背景：站主统一账号后问"我如何写博客"——原来的写作台要用一套独立的 ADMIN_USERNAME/ADMIN_PASSWORD，
 * 那个口令既不在他脑子里（在服务器 .env 里），又要多维护一套凭据。所以这里让**站主本人的站点身份**
 * 直接进写作台，同时保留旧路径（脚本/自动化还在用）。
 *
 * 谁是站主（不引入新配置，也不需要他记住任何东西）：
 *   ① 环境变量 ADMIN_EMAILS（逗号分隔）里列出的邮箱，或
 *   ② 数据库里**最早注册且已验证**的那个身份（个人站：第一次注册的就是站主本人）。
 * 判定结果缓存 60 秒，避免每个请求都查一次库。
 */
@Injectable()
export class BlogAdminGuard implements CanActivate {
    private ownerId: { id: string; at: number } | null = null;

    constructor(
        private readonly jwt: JwtAuthGuard,
        private readonly identity: IdentityService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();

        // ① 站点身份（域级 Cookie `sid`，或 Bearer 会话令牌）
        const token = extractSessionToken(req);
        if (token) {
            try {
                const session = await this.identity.resolveSession(token);
                if (await this.isOwner(session.identity)) {
                    req.identity = session.identity;
                    req.session = session;
                    // 让既有控制器里的 assertAdmin(user) 原样可用：把站主身份伪装成"ADMIN 用户"
                    req.user = {
                        id: session.identity.id,
                        username: session.identity.username || session.identity.email || 'site-owner',
                        role: UserRole.ADMIN,
                        viaSiteIdentity: true,
                    } as unknown as User;
                    return true;
                }
            }
            catch {
                // 站点会话无效 → 落到下面试旧 JWT，不在这里抛错
            }
        }

        // ② 旧的 JWT（写作台的独立管理员账号；脚本与自动化在用）
        try {
            const ok = await this.jwt.canActivate(context);
            return ok === true;         // canActivate 的返回类型含 Observable，这里只认同步/异步的 true
        }
        catch {
            throw new UnauthorizedException('需要站点账号（站主）或写作台管理员令牌');
        }
    }

    /** 站主 = ADMIN_EMAILS 命中，或最早注册且已验证的那个身份 */
    private async isOwner(identity: any): Promise<boolean> {
        if (!identity || !identity.id)
            return false;
        const listed = String(process.env.ADMIN_EMAILS || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
        const email = String(identity.email || '').toLowerCase();
        if (listed.length && email && listed.includes(email))
            return true;

        const now = Date.now();
        if (this.ownerId && now - this.ownerId.at < 60_000)
            return this.ownerId.id === identity.id;
        const oldest = await this.identity.findOldestActiveIdentityId();
        this.ownerId = { id: oldest, at: now };
        return !!oldest && oldest === identity.id;
    }
}
