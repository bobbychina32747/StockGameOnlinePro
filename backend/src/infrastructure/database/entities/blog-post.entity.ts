import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 博客文章（站内写作台的存储）
 * 2026-09-28：站主要求"登录就能在站上写、不用自己推 GitHub"，因此内容改由本站托管。
 * 取舍说明（相对选型会 C2「内容源在 git」的偏离与补偿）：
 *   · 本表在同一个 SQLite 库里 → 每日 .backup 自动覆盖，异地备份策略不变；
 *   · 渲染产物（静态 HTML/RSS/sitemap）由 build.mjs 生成，容器挂了文章照读（C2 的核心目的仍成立）；
 *   · 待办：发布后异步把 Markdown 镜像回 git（最小权限 GitHub App），补齐"git 即异地备份"这一条。
 */
@Entity('blog_posts')
export class BlogPost {
    @PrimaryGeneratedColumn()
    id: number;

    /** 永久链接片段：/posts/<slug>/，发布后不允许改（改 = 断链） */
    @Index({ unique: true })
    @Column({ length: 120 })
    slug: string;

    @Column({ length: 200 })
    title: string;

    /** 业务日期（YYYY-MM-DD），列表与 RSS 排序用 */
    @Column({ length: 10 })
    date: string;

    /** 标签，JSON 数组文本（SQLite 下用 text 存最省事） */
    @Column({ type: 'text', default: '[]' })
    tags: string;

    @Column({ type: 'text', default: '' })
    summary: string;

    /** 正文 Markdown 原文 */
    @Column({ type: 'text', default: '' })
    body: string;

    /** true = 草稿，不渲染、不出现在列表与 RSS */
    @Column({ default: true })
    draft: boolean;

    @Column({ type: 'datetime', nullable: true })
    publishedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
