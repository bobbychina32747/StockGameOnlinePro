import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { In, Repository } from 'typeorm';

import { BlogComment, CommentStatus } from '../../infrastructure/database/entities/blog-comment.entity';
import { BlogPost } from '../../infrastructure/database/entities/blog-post.entity';
import { BlogView } from '../../infrastructure/database/entities/blog-view.entity';

// 博客公开接口的两个能力：浏览量 + 评论。
//
// 为什么单独一个 service / 模块，而不是塞进 blog-admin：
//   · blog-admin 整个控制器都挂 JwtAuthGuard + ADMIN，公开读接口混进去必然要么漏鉴权、要么结构别扭；
//   · 这两块是**对外**能力（任何人可读、登录用户可写），与写作台（只有站长）的信任级别不同；
//   · 但两者共用同一张库、同一套 slug 契约，所以管理端通过 BlogPublicModule 导出的本 service 复用逻辑。

/** slug 形状与应用发布口径一致：小写字母数字与连字符 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
/** 单条评论长度上限（前端也会拦，这里是最后一道） */
export const COMMENT_MAX_LEN = 2000;
/** 同一 IP 看同一篇文章的去重窗口 */
const VIEW_COOLDOWN_MS = 30 * 60 * 1000;
/** 同一身份两次评论的最小间隔 */
const COMMENT_MIN_GAP_MS = 20 * 1000;
/** 同一 IP 每小时评论上限（防刷；正常读者远远用不到） */
const COMMENT_IP_PER_HOUR = 12;

export interface PublicComment {
    id: string;
    author: string;
    body: string;
    createdAt: string;
}

@Injectable()
export class BlogPublicService {
    private readonly logger = new Logger('BlogPublic');

    /** slug|ipHash → 上次计数时间（进程内即可：重启丢一次去重窗口无伤大雅） */
    private readonly viewSeen = new Map<string, number>();
    private readonly lastCommentAt = new Map<string, number>();
    private readonly ipCommentLog = new Map<string, number[]>();

    constructor(
        @InjectRepository(BlogView) private readonly views: Repository<BlogView>,
        @InjectRepository(BlogComment) private readonly comments: Repository<BlogComment>,
        @InjectRepository(BlogPost) private readonly posts: Repository<BlogPost>,
    ) {}

    /** IP 只以哈希形式参与去重/限流，不落原始值（日志里也不打） */
    private hashIp(ip?: string): string {
        const raw = String(ip || 'unknown');
        return createHash('sha256').update(`${raw}|bobbycn.cc`).digest('hex').slice(0, 32);
    }

    private assertSlug(slug: string): string {
        const s = String(slug || '').trim();
        if (!SLUG_RE.test(s))
            throw new BadRequestException('slug 不合法');
        return s;
    }

    /** 计数 +1（带冷却去重），返回最新值。冷却期内重复调用只回读不累加。 */
    async hit(slug: string, ip?: string): Promise<number> {
        const s = this.assertSlug(slug);
        const key = `${s}|${this.hashIp(ip)}`;
        const now = Date.now();
        const last = this.viewSeen.get(key) || 0;
        const fresh = now - last >= VIEW_COOLDOWN_MS;

        if (fresh) {
            this.viewSeen.set(key, now);
            // 清理：地图别无限长（只在写入路径顺手做，够用且零开销）
            if (this.viewSeen.size > 5000) {
                for (const [k, t] of this.viewSeen)
                    if (now - t > VIEW_COOLDOWN_MS)
                        this.viewSeen.delete(k);
            }
            const row = await this.views.findOne({ where: { slug: s } });
            if (!row) {
                try {
                    await this.views.insert({ slug: s, count: 1 });
                    return 1;
                }
                catch {
                    // 并发首访：两个请求同时 insert，失败的那个退化成自增
                }
            }
            await this.views.increment({ slug: s }, 'count', 1);
        }
        const after = await this.views.findOne({ where: { slug: s } });
        return after ? Number(after.count) : 0;
    }

    /** 批量读计数（文章列表用，一次请求拿全） */
    async viewsFor(slugs: string[]): Promise<Record<string, number>> {
        const list = (slugs || []).map((s) => String(s || '').trim()).filter((s) => SLUG_RE.test(s)).slice(0, 200);
        const out: Record<string, number> = {};
        if (!list.length)
            return out;
        for (const row of await this.views.find({ where: { slug: In(list) } }))
            out[row.slug] = Number(row.count);
        return out;
    }

    /** 对外评论列表：只给已发布、只给必要字段 */
    async listComments(slug: string, take = 50, skip = 0): Promise<{ total: number; comments: PublicComment[] }> {
        const s = this.assertSlug(slug);
        const limit = Math.min(Math.max(Number(take) || 50, 1), 100);
        const offset = Math.max(Number(skip) || 0, 0);
        const [rows, total] = await this.comments.findAndCount({
            where: { slug: s, status: CommentStatus.PUBLISHED },
            order: { createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
        return { total, comments: rows.map((c) => this.toPublic(c)) };
    }

    /** 评论数（文章页侧栏用；与列表分开是为了列表能分页） */
    async countComments(slug: string): Promise<number> {
        const s = this.assertSlug(slug);
        return this.comments.count({ where: { slug: s, status: CommentStatus.PUBLISHED } });
    }

    private toPublic(c: BlogComment): PublicComment {
        return {
            id: c.id,
            author: c.author,
            body: c.body,
            createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
        };
    }

    /**
     * 发一条评论。校验顺序刻意从"最便宜的"到"最贵的"：
     * slug 合法性 → 文章存在且已发布 → 长度/频次 → 落库。
     * Turnstile 在 controller 里（那里才拿得到请求 IP 与上下文）。
     */
    async addComment(input: { slug: string; body: string; author: string; identityId: string; ip?: string }): Promise<PublicComment> {
        const slug = this.assertSlug(input.slug);
        const body = this.cleanBody(input.body);
        if (!body)
            throw new BadRequestException('评论内容不能为空');
        if (body.length > COMMENT_MAX_LEN)
            throw new BadRequestException(`评论太长（上限 ${COMMENT_MAX_LEN} 字）`);

        // 只允许给"确实存在且已发布"的文章评论：否则垃圾请求能往任意 slug 灌数据
        const post = await this.posts.findOne({ where: { slug, draft: false } });
        if (!post)
            throw new BadRequestException('文章不存在或未发布');

        const author = this.cleanAuthor(input.author, input.identityId);
        const ipHash = this.hashIp(input.ip);

        const now = Date.now();
        const last = this.lastCommentAt.get(input.identityId) || 0;
        if (now - last < COMMENT_MIN_GAP_MS)
            throw new BadRequestException('发得太快了，歇一会儿再发');
        const hits = (this.ipCommentLog.get(ipHash) || []).filter((t) => now - t < 3600_000);
        if (hits.length >= COMMENT_IP_PER_HOUR) {
            this.logger.warn('评论被限流（同 IP 一小时超限）');
            throw new BadRequestException('这个网络今天评论太多了，换个时间再来');
        }

        const saved = await this.comments.save(this.comments.create({
            slug, body, author, identityId: input.identityId, ipHash,
            status: CommentStatus.PUBLISHED,
        }));
        this.lastCommentAt.set(input.identityId, now);
        hits.push(now);
        this.ipCommentLog.set(ipHash, hits);
        return this.toPublic(saved);
    }

    /** 正文清洗：去掉控制字符、压掉 3 个以上连续空行、首尾留白清掉。**不做 HTML 转义**——前端用 textContent 渲染。 */
    private cleanBody(raw: string): string {
        return String(raw || '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .replace(/\r\n?/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    private cleanAuthor(raw: string, identityId: string): string {
        const s = String(raw || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
        return s || `用户${String(identityId).slice(0, 4)}`;
    }

    // ───────────────────────── 管理端 ─────────────────────────

    /** 后台列表：带 identityId 与状态，便于站长判断要不要处理 */
    async listForAdmin(status?: string, take = 100): Promise<any[]> {
        const where: any = {};
        if (status === 'published' || status === 'hidden')
            where.status = status;
        const rows = await this.comments.find({ where, order: { createdAt: 'DESC' }, take: Math.min(Number(take) || 100, 300) });
        return rows.map((c) => ({ ...this.toPublic(c), slug: c.slug, status: c.status, identityId: c.identityId }));
    }

    async setStatus(id: string, status: string): Promise<any> {
        if (status !== 'published' && status !== 'hidden')
            throw new BadRequestException('状态只能是 published / hidden');
        const row = await this.comments.findOne({ where: { id } });
        if (!row)
            throw new BadRequestException('评论不存在');
        row.status = status === 'hidden' ? CommentStatus.HIDDEN : CommentStatus.PUBLISHED;
        await this.comments.save(row);
        return { id: row.id, status: row.status };
    }

    async remove(id: string): Promise<{ removed: boolean }> {
        const r = await this.comments.delete({ id });
        return { removed: !!r.affected };
    }
}
