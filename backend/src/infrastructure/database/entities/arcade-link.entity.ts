import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 站点身份 ↔ 游戏厅账号 的绑定（2026-09-29）
 *
 * 背景：游戏厅那套账号（Cloudflare Worker + PBKDF2 零知识口令）承载着云存档、全站榜与 GitHub Gist 备份，
 * 存档在**浏览器侧加密**，密钥由游戏厅口令派生 —— 所以"只发一个 JWT 就免登录"走不通：
 * 客户端手里必须有那份口令，否则老存档解不开。
 *
 * 因此这里只存"这个站点身份用哪个游戏厅账号名"，口令由服务端按身份**稳定派生**
 * （HMAC(arcade-derive.key, identityId)），客户端拿它走原有的登录/改密流程，两端都不用改协议。
 *   · 没绑定的身份 → name = u_<sha256(identityId) 前 8 位>（首次自动开号）
 *   · 绑定了已有账号 → name = 那个老名字（老存档、榜单、Gist 全不动）
 */
@Entity('arcade_links')
export class ArcadeLink {
    @PrimaryColumn({ length: 64 })
    identityId: string;

    /** 游戏厅账号名（有效名，2~24 字） */
    @Column({ length: 40 })
    name: string;

    /** 是不是自动开的号（false = 绑定的已有账号），仅用于界面提示与排查 */
    @Column({ default: true })
    auto: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
