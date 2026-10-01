import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/guards/jwt-auth.guard';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { BlogPublicService } from '../blog-public/blog-public.service';
import { BlogAdminGuard } from './blog-admin.guard';
import { BlogAdminService, BlogPostDto } from './blog-admin.service';

/**
 * 写作台保存入参。
 *
 * ⚠️ 每个字段都**必须**带 class-validator 装饰器：全局 ValidationPipe 开了
 *    `whitelist: true` + `forbidNonWhitelisted: true`，**没有装饰器的属性会被当成"未声明的字段"直接拒掉**，
 *    报错长这样：`property title should not exist, property slug should not exist, …`（2026-09-30 站主发帖时踩到）。
 *    slug 的格式与 BlogAdminService.upsert 里的判定保持一致（字母/数字/中划线），否则前端生成的中文 slug 会在服务层再抛一次。
 */
class SavePostDto implements BlogPostDto {
    @IsString()
    @MaxLength(120)
    @Matches(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, { message: 'slug 只能包含字母、数字与中划线（中文标题请自拟英文短链）' })
    slug: string;

    @IsString()
    @MaxLength(200)
    title: string;

    /** YYYY-MM-DD；空串也允许（服务层会兜底成今天） */
    @IsString()
    @MaxLength(10)
    date: string;

    // 注：类型上保持必填（与 BlogPostDto 接口一致），运行时用 @IsOptional() 放行缺省 ——
    // 前端 collect() 每次都会带上这些字段，但脚本/老客户端可能省略，别因此 400。
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(20)
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    tags: string[];

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    summary: string;

    @IsString()
    @MaxLength(200000)
    body: string;

    @IsOptional()
    @IsBoolean()
    draft: boolean;
}

/**
 * 站内写作台后端（/api/admin/blog/*）
 * 鉴权：BlogAdminGuard —— **站点身份（站主）优先**，旧的写作台管理员 JWT 继续可用。
 * 2026-09-29 改：站主统一账号后不该再记一套独立口令，"登录站点 → /admin/ 就能写"。
 */
@Controller('admin/blog')
@UseGuards(BlogAdminGuard)
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
