import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { BlogPublicService } from '../blog-public/blog-public.service';
import { BlogAdminService, BlogPostDto } from './blog-admin.service';

class SavePostDto implements BlogPostDto {
    slug: string;
    title: string;
    date: string;
    tags: string[];
    summary: string;
    body: string;
    draft: boolean;
}

/**
 * 站内写作台后端（/api/admin/blog/*）
 * 鉴权与现网一致：JwtAuthGuard + 显式 role 检查（写作台只给站长用）。
 * 注：identity 模块上线后，登录端点会统一到 /api/auth/*，本控制器只需换 guard，端点不变。
 */
@Controller('admin/blog')
@UseGuards(JwtAuthGuard)
export class BlogAdminController {
    constructor(
        private readonly blog: BlogAdminService,
        private readonly publicBlog: BlogPublicService,
    ) {}

    private assertAdmin(user: User) {
        if (!user || user.role !== UserRole.ADMIN) throw new ForbiddenException('无权限');
    }

    @Get('posts')
    async list(@CurrentUser() user: User) {
        this.assertAdmin(user);
        return { posts: await this.blog.list() };
    }

    @Get('posts/:slug')
    async one(@CurrentUser() user: User, @Param('slug') slug: string) {
        this.assertAdmin(user);
        const post = await this.blog.findBySlug(slug);
        if (!post) throw new NotFoundException('文章不存在');
        return { post };
    }

    /** 保存（草稿或发布）：发布状态下会重新渲染静态页 */
    @Post('posts')
    async save(@CurrentUser() user: User, @Body() dto: SavePostDto) {
        this.assertAdmin(user);
        try {
            return await this.blog.upsert({
                slug: String(dto.slug || '').trim(),
                title: String(dto.title || '').trim(),
                date: String(dto.date || '').trim(),
                tags: Array.isArray(dto.tags) ? dto.tags.map(String) : [],
                summary: String(dto.summary || '').trim(),
                body: String(dto.body || ''),
                draft: dto.draft !== false,
            });
        } catch (e: any) {
            throw new BadRequestException(String(e?.message || e));
        }
    }

    /** 只重跑一次渲染（修了模板 / 手工改过 content 目录后可用） */
    @Post('rebuild')
    async rebuild(@CurrentUser() user: User) {
        this.assertAdmin(user);
        return { build: await this.blog.render() };
    }

    @Delete('posts/:slug')
    async remove(@CurrentUser() user: User, @Param('slug') slug: string) {
        this.assertAdmin(user);
        const r = await this.blog.remove(slug);
        if (!r.removed) throw new NotFoundException('文章不存在');
        return r;
    }

    // ───────────────────────── 评论审核（2026-09-29） ─────────────────────────

    /** 评论列表：默认全部，可按 status=published|hidden 过滤 */
    @Get('comments')
    async comments(@CurrentUser() user: User, @Query('status') status?: string) {
        this.assertAdmin(user);
        return { comments: await this.publicBlog.listForAdmin(status) };
    }

    /** 隐藏 / 恢复（软处理：保留原文，随时可翻回来） */
    @Post('comments/:id/status')
    async commentStatus(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: { status?: string }) {
        this.assertAdmin(user);
        return this.publicBlog.setStatus(id, String(dto?.status || ''));
    }

    /** 彻底删除（不可逆，前端需二次确认） */
    @Delete('comments/:id')
    async commentRemove(@CurrentUser() user: User, @Param('id') id: string) {
        this.assertAdmin(user);
        return this.publicBlog.remove(id);
    }
}
