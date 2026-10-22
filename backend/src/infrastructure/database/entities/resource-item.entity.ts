import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** 条目类型：link = 普通链接，file = 服务器托管的文件（有 fileKey 即 file） */
export enum ResourceKind {
    LINK = 'link',
    FILE = 'file',
}

/**
 * 共享资源条目（站主维护的「资源」列表；公开页 /resources/ 与写作台资源面板共用）
 *
 * 契约见 docs/RESOURCES-20261021.md：
 *   · 表中一行 = 一条资源；`url` 对文件类条目固定为 `/api/resources/file/<fileKey>`；
 *   · `fileKey` 是服务器上的实际文件名（32 hex + 扩展名），`fileName` 才是给用户看的原始文件名；
 *   · `published=false` 时公开接口不可见（后台仍能看到）；
 *   · 排序：sortOrder 大的在前，同值按 id 倒序。
 * 文件本体落盘在 RESOURCE_DIR（默认 <cwd>/data/resources），不存库（避免 SQLite 体积膨胀）。
 */
@Entity('resource_items')
export class ResourceItem {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ length: 120 })
    title: string;

    @Column({ type: 'text', nullable: true })
    description: string | null;

    /** 链接地址；文件类条目 = /api/resources/file/<fileKey> */
    @Column({ type: 'text', nullable: true })
    url: string | null;

    /** 标签，JSON 数组文本（与 blog_posts.tags 同一存法） */
    @Column({ type: 'text', default: '[]' })
    tags: string;

    @Column({ type: 'simple-enum', enum: ResourceKind, default: ResourceKind.LINK })
    kind: ResourceKind;

    /** 服务器文件名（随机 32 hex + 扩展名）；有值即文件类条目 */
    @Index()
    @Column({ length: 64, nullable: true })
    fileKey: string | null;

    /** 下载时的原始文件名（用户可见） */
    @Column({ length: 200, nullable: true })
    fileName: string | null;

    @Column({ type: 'int', nullable: true })
    fileSize: number | null;

    @Column({ length: 120, nullable: true })
    mimeType: string | null;

    /** false = 隐藏（公开接口不返回） */
    @Column({ default: true })
    published: boolean;

    /** 排序权重：大的在前，同值按 id 倒序 */
    @Column({ default: 0 })
    sortOrder: number;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
