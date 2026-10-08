import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 授权系统 · 刷新令牌（不透明，TTL 30 天，**一次性轮换**）
 *
 * 为什么必须有：access_token 只能是 10 分钟的短 JWT（撤销延迟 = TTL），
 * 而游戏一玩就是半小时。没有刷新令牌，玩家会在游戏中途被踢回登录页。
 *
 * 轮换与重放检测（RFC 6819 §5.2.2.3 的做法）：
 *   · 每次刷新都签发**新的** refresh token 并把旧的标记 `usedAt`；
 *   · 有人拿一张**已经用过**的 refresh token 来换 → 说明令牌被复制过 → 同一 grant 下的
 *     全部刷新令牌立刻作废（`revokeGrantTokens`），用户需要重新授权。
 *
 * 落库口径与身份令牌一致：只存 `tokenHash = sha256(明文)`。
 */
@Entity('oauth_refresh_tokens')
export class OAuthRefreshToken {
    @PrimaryColumn({ length: 64 })
    tokenHash: string;

    @Index()
    @Column({ length: 64 })
    clientId: string;

    @Column({ length: 64 })
    identityId: string;

    /** 所属授权关系；授权被撤销时按 grantId 一把全撤 */
    @Index()
    @Column({ length: 64 })
    grantId: string;

    /** 本张刷新令牌能换出的 scope（不随刷新扩大） */
    @Column({ length: 255 })
    scope: string;

    @Column('datetime')
    expiresAt: Date;

    /** 非空 = 已用过（轮换实现 + 重放检测的依据） */
    @Column('datetime', { nullable: true })
    usedAt: Date | null;

    @Column('datetime', { nullable: true })
    revokedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
