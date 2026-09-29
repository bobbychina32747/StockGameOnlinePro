import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { BlogPost } from '../../infrastructure/database/entities/blog-post.entity';

export interface BlogPostDto {
    slug: string;
    title: string;
    date: string;
    tags: string[];
    summary: string;
    body: string;
    draft: boolean;
}

/**
 * 站内写作台的存储与渲染。
 * 渲染不重写 Markdown 逻辑：把库里的文章导出成 Markdown 文件，再跑同一份 build.mjs
 * （部署时挂在 /blog/build.mjs），保证「站内写作」与「本地构建」产物完全一致。
 */
@Injectable()
export class BlogAdminService {
    private readonly logger = new Logger(BlogAdminService.name);

    private get blogDir(): string {
        return process.env.BLOG_DIR || '/blog';
    }
    private get distDir(): string {
        return process.env.BLOG_DIST || '/blog-dist';
    }

    constructor(
        @InjectRepository(BlogPost)
        private readonly postRepo: Repository<BlogPost>,
    ) {}

    async list() {
        const rows = await this.postRepo.find({ order: { date: 'DESC', updatedAt: 'DESC' } });
        return rows.map((r) => this.toDto(r));
    }

    async findBySlug(slug: string) {
        const row = await this.postRepo.findOne({ where: { slug } });
        return row ? this.toDto(row) : null;
    }

    /** 新建或按 slug 覆盖（写作台只有一个作者，不做冲突合并） */
    async upsert(dto: BlogPostDto) {
        if (!dto.slug || !/^[a-z0-9][a-z0-9-]*$/i.test(dto.slug)) {
            // slug 会变成 URL 片段与文件名，先卡住格式（中文标题由前端/调用方转写成拼音或英文）
            throw new Error('slug 只能包含字母、数字与中划线');
        }
        let row = await this.postRepo.findOne({ where: { slug: dto.slug } });
        const published = !dto.draft;
        if (!row) {
            row = this.postRepo.create({ slug: dto.slug });
        }
        row.title = dto.title || dto.slug;
        row.date = (dto.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
        row.tags = JSON.stringify(Array.isArray(dto.tags) ? dto.tags : []);
        row.summary = dto.summary || '';
        row.body = dto.body || '';
        row.draft = !published;
        if (published && !row.publishedAt) row.publishedAt = new Date();
        await this.postRepo.save(row);

        // 只有"已发布"的内容需要重新出静态页；纯草稿保存不动线上产物
        const build = published ? await this.render() : { ok: true, skipped: true as const };
        return { post: this.toDto(row), build };
    }

    async remove(slug: string) {
        const row = await this.postRepo.findOne({ where: { slug } });
        if (!row) return { removed: false };
        await this.postRepo.remove(row);
        const build = await this.render();
        return { removed: true, build };
    }

    /**
     * 导出 Markdown → 跑 build.mjs → 产出 /blog-dist（posts/、feed.xml、sitemap.xml、media/）
     * 任何一步失败都返回 ok:false 与原因，不抛给上层（写作台要能把失败原因显示给作者）
     */
    async render(): Promise<{ ok: boolean; skipped?: boolean; output?: string; error?: string }> {
        const contentDir = path.join(this.blogDir, 'content', 'posts');
        const buildScript = path.join(this.blogDir, 'build.mjs');
        try {
            const posts = await this.postRepo.find({ where: { draft: false }, order: { date: 'ASC' } });
            await fs.mkdir(contentDir, { recursive: true });
            // 先清空再写：文件集 = 库里的已发布集，避免手工残留的旧文章一直挂在线上
            for (const f of await fs.readdir(contentDir)) {
                if (f.endsWith('.md')) await fs.unlink(path.join(contentDir, f));
            }
            for (const p of posts) {
                const tags = this.parseTags(p.tags);
                const fm = [
                    '---',
                    `title: ${p.title}`,
                    `slug: ${p.slug}`,
                    `date: ${p.date}`,
                    `summary: ${p.summary}`,
                    `tags: [${tags.join(', ')}]`,
                    'draft: false',
                    '---',
                    '',
                ].join('\n');
                await fs.writeFile(path.join(contentDir, `${p.date}-${p.slug}.md`), fm + p.body, 'utf8');
            }
            const output = await this.runNode(buildScript, ['--out', this.distDir]);
            this.logger.log(`博客渲染完成：${posts.length} 篇`);
            return { ok: true, output };
        } catch (e: any) {
            this.logger.error(`博客渲染失败：${e?.message || e}`);
            return { ok: false, error: String(e?.message || e) };
        }
    }

    private runNode(script: string, args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile('node', [script, ...args], { cwd: this.blogDir, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return reject(new Error(String(stderr || err.message).slice(0, 800)));
                resolve(String(stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 800));
            });
        });
    }

    private parseTags(raw: string): string[] {
        try {
            const v = JSON.parse(raw || '[]');
            return Array.isArray(v) ? v.map(String) : [];
        } catch {
            return [];
        }
    }

    private toDto(r: BlogPost) {
        return {
            slug: r.slug,
            title: r.title,
            date: r.date,
            tags: this.parseTags(r.tags),
            summary: r.summary,
            body: r.body,
            draft: r.draft,
            status: r.draft ? 'draft' : 'published',
            publishedAt: r.publishedAt,
            updatedAt: r.updatedAt,
        };
    }
}
