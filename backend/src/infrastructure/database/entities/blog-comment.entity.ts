import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** published = 对外可见；hidden = 站长在后台藏起来（保留原文与时间，便于复核）；
 *  pending = 机器人审核觉得可疑（带外链 / 重复度异常），先挂着等站长过一眼（2026-09-29 加） */
export enum CommentStatus {
    PUBLISHED = 'published',
    HIDDEN = 'hidden',
    PENDING = 'pending',
}

/**
 * 博客评论（2026-09-29 上线）
 * 设计取舍：
 *   · **必须登录才能发**——本站已有统一身份（邮箱验证 + 会话），评论复用同一套，不引第三方评论服务，
 *     也不开放匿名（匿名必然要额外对付垃圾评论，成本远高于收益）；
 *   · 正文存原文，前端一律用 textContent 渲染（不用 innerHTML），从源头避免 XSS；
 *   · identityId 只用于「这条是不是我发的」与后台追溯，公开接口不返回；
 *   · ipHash 只留哈希用于限流与滥用排查，不落原始 IP。
 */
@Entity('blog_comments')
export class BlogComment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ length: 120 })
    slug: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    identityId: string | null;

    /** 显示名（发帖人可改，默认取身份的用户名/邮箱前缀） */
    @Column({ length: 40 })
    author: string;

    @Column({ type: 'text' })
    body: string;

    @Column({ type: 'simple-enum', enum: CommentStatus, default: CommentStatus.PUBLISHED })
    status: CommentStatus;

    @Column({ type: 'varchar', length: 32, nullable: true })
    ipHash: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
