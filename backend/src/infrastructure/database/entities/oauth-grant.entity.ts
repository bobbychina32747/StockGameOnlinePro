import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 授权系统 · 授权关系（用户 × 客户端）
 *
 * 一行 = 「这个人同意过这个应用访问这些 scope」。用途有三：
 *   1. 免二次确认：同一客户端 + 同一组 scope 已授权且在有效期内，`/authorize` 直接发码不再弹同意页；
 *   2. 可撤销：用户在这里解除授权（`/oauth/revoke` 或以后的管理页），整条授权链（含 refresh token）一并作废；
 *   3. 可审计：谁在什么时候把什么权限给了哪个应用。
 *
 * 注意：`access_token` 是 10 分钟的短时 JWT，撤销后最长 10 分钟内仍然验签通过（与既有
 * `/introspect` 的语义一致）；需要即时撤销的调用方应带 `sid` 走 introspect —— 因为授权记录
 * 被撤销时，我们同时会**撤销当时的站点会话**（见 OauthService.revokeGrant）。
 */
@Entity('oauth_grants')
@Unique(['identityId', 'clientId'])
export class OAuthGrant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ length: 64 })
    identityId: string;

    @Index()
    @Column({ length: 64 })
    clientId: string;

    /** 当前这行授权覆盖的 scope（空格分隔，用户重新同意时整体替换） */
    @Column({ length: 255 })
    scopes: string;

    @Column('datetime')
    grantedAt: Date;

    @Column('datetime', { nullable: true })
    revokedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
