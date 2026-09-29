import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 博客浏览量（每篇一行，按 slug 累计）
 * 2026-09-29 站主要求"博客添加浏览量"，走本机计数而不是第三方统计：
 *   · 不存 Cookie、不存原始 IP（去重只用 sha256(ip) 的前缀，见 BlogPublicService.hashIp）；
 *   · 客户端每次进文章页发一次 POST，服务端按 (slug, ipHash) 做 30 分钟冷却去重；
 *   · 文章删了计数行留着无妨（重新发同 slug 会接着涨，符合直觉）。
 */
@Entity('blog_views')
export class BlogView {
    /** 与 blog_posts.slug 同口径（发布后不改，改 = 断链，所以直接当主键） */
    @PrimaryColumn({ length: 120 })
    slug: string;

    @Column({ type: 'integer', default: 0 })
    count: number;

    @UpdateDateColumn()
    updatedAt: Date;
}
