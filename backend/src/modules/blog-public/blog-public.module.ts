import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BlogComment } from '../../infrastructure/database/entities/blog-comment.entity';
import { BlogPost } from '../../infrastructure/database/entities/blog-post.entity';
import { BlogView } from '../../infrastructure/database/entities/blog-view.entity';
import { IdentityModule } from '../identity/identity.module';
import { BlogModerationService } from './blog-moderation.service';
import { BlogPublicController } from './blog-public.controller';
import { BlogPublicService } from './blog-public.service';

/**
 * 博客对外能力：浏览量 + 评论（2026-09-29）
 * 依赖 IdentityModule：评论要会话鉴权（SessionAuthGuard 的 IdentityService）与人机验证（TurnstileService）。
 * 表由 TypeORM synchronize 自动建（与 blog_posts 同库同策略）。
 */
@Module({
    imports: [TypeOrmModule.forFeature([BlogView, BlogComment, BlogPost]), IdentityModule],
    controllers: [BlogPublicController],
    providers: [BlogPublicService, BlogModerationService],
    exports: [BlogPublicService, BlogModerationService],
})
export class BlogPublicModule {}
