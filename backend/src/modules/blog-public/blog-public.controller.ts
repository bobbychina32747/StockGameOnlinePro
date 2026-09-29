import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { Identity } from '../../infrastructure/database/entities/identity.entity';
import { CurrentIdentity, SessionAuthGuard } from '../identity/session-auth.guard';
import { TurnstileService } from '../identity/turnstile.service';
import { BlogPublicService, COMMENT_MAX_LEN } from './blog-public.service';

/**
 * 博客公开接口（/api/blog/*）
 * nginx 侧必须把 /api/blog/ 也反代到本机 Nest（见 deploy/nginx/blog.conf 的 ^~ 列表）——
 * 否则会打到游戏厅 Worker，表现为一个莫名其妙的 401。
 */

/** DTO 必须声明每个字段：全局 ValidationPipe 开了 whitelist + forbidNonWhitelisted，未声明字段会被 400 拒掉 */
class ViewDto {
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    slug: string;
}

class CommentDto {
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    slug: string;

    @IsString()
    @MinLength(1)
    @MaxLength(COMMENT_MAX_LEN)
    body: string;

    /** 显示名（可选；不填则按身份推导） */
    @IsOptional()
    @IsString()
    @MaxLength(40)
    author?: string;

    /** Turnstile token（与注册/忘记口令同一套 widget 契约，action=comment） */
    @IsOptional()
    @IsString()
    @MaxLength(4096)
    cfToken?: string;
}

@Controller('blog')
export class BlogPublicController {
    constructor(
        private readonly blog: BlogPublicService,
        private readonly turnstile: TurnstileService,
    ) {}

    /** 记一次浏览：服务端按 (slug, ip) 30 分钟去重，返回最新计数 */
    @Post('view')
    @HttpCode(HttpStatus.OK)
    async view(@Body() dto: ViewDto, @Req() req: any) {
        const views = await this.blog.hit(dto.slug, req && req.ip);
        return { slug: dto.slug, views };
    }

    /** 批量读计数（文章列表页一次拿全） */
    @Get('views')
    async views(@Query('slugs') slugs: string) {
        return { views: await this.blog.viewsFor(String(slugs || '').split(',')) };
    }

    /** 评论列表 + 总数（只返回已发布） */
    @Get('comments')
    async comments(@Query('slug') slug: string, @Query('take') take?: string, @Query('skip') skip?: string) {
        const r = await this.blog.listComments(slug, Number(take) || 50, Number(skip) || 0);
        return { ...r, slug };
    }

    /**
     * 发评论：**必须登录**（域级 Cookie 会话），另外过一道 Turnstile。
     * 这里刻意返回 401 而不是静默失败，前端据此把表单换成"登录后评论"。
     */
    @Post('comments')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async comment(@CurrentIdentity() identity: Identity, @Body() dto: CommentDto, @Req() req: any) {
        // 评论用"软校验"：登录是硬门槛，Turnstile 带 token 就必过、没带也放行（CF 抖动不该锁死评论区）
        await this.turnstile.assertHumanOptional(dto.cfToken, req && req.ip, 'comment');
        const author = dto.author || this.defaultAuthor(identity);
        const comment = await this.blog.addComment({
            slug: dto.slug,
            body: dto.body,
            author,
            identityId: identity.id,
            ip: req && req.ip,
        });
        return { comment };
    }

    /** 默认显示名：优先用户名；没用户名就用邮箱前缀，中间打码（评论是对外可见的，别把邮箱直接露出去） */
    private defaultAuthor(identity: Identity): string {
        if (identity.username)
            return identity.username;
        const email = String(identity.email || '');
        const at = email.indexOf('@');
        if (at <= 0)
            return '匿名读者';
        const local = email.slice(0, at);
        if (local.length <= 3)
            return `${local.slice(0, 1)}**`;
        return `${local.slice(0, 3)}***${local.slice(-2)}`;
    }
}
