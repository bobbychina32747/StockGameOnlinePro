import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 授权系统 · 授权码（一次性，TTL 120 秒）
 *
 * 与 GitHub / 微软的授权码同构：`/oauth/authorize` 签发的短期凭证，
 * 只能被**同一个客户端**在**同一个 redirect_uri** 上兑换一次，且必须带上 PKCE 的 code_verifier。
 *
 * 安全口径（与 identity_tokens 一致，见 C10）：
 *   · 库里只存 `codeHash = sha256(明文)`；明文只在 302 的 Location 里出现一次，绝不落日志；
 *   · `usedAt` 在兑换时**先写再发令牌**：并发双击时后到者必被拒（宁可多烧一个码，也不放行两次）；
 *   · `identityId` + `sessionId` 一并记下：兑换时令牌直接绑定当时的会话，授权码本身不携带任何用户信息。
 */
@Entity('oauth_codes')
export class OAuthCode {
    @PrimaryColumn({ length: 64 })
    codeHash: string;

    @Index()
    @Column({ length: 64 })
    clientId: string;

    @Column({ length: 64 })
    identityId: string;

    @Column({ length: 64 })
    sessionId: string;

    /** 兑换时必须逐字相同的回调地址（防授权码被搬到别的回调上） */
    @Column({ length: 512 })
    redirectUri: string;

    /** PKCE：S256 的 code_challenge（base64url）；confidential 客户端不带 PKCE 时为 NULL */
    @Column({ type: 'varchar', length: 128, nullable: true })
    codeChallenge: string | null;

    /** 只允许 'S256'（不接受 plain） */
    @Column({ type: 'varchar', length: 10, nullable: true })
    codeChallengeMethod: string | null;

    /** 授权时确定的 scope（空格分隔）——用户同意了什么就发什么，兑换时不再重新协商 */
    @Column({ length: 255 })
    scope: string;

    @Column('datetime')
    expiresAt: Date;

    /** 非空 = 已兑换（一次性） */
    @Column('datetime', { nullable: true })
    usedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
