import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { BlogPost } from '../../infrastructure/database/entities/blog-post.entity';
import { BlogPublicModule } from '../blog-public/blog-public.module';
import { IdentityModule } from '../identity/identity.module';
import { BlogAdminController } from './blog-admin.controller';
import { BlogAdminGuard } from './blog-admin.guard';
import { BlogAdminService } from './blog-admin.service';

/**
 * 站内写作台（博客）
 * 依赖：同一个 SQLite 库（blog_posts 表由 TypeORM synchronize 自动建，与其他表一致）
 *     宿主挂载 BLOG_DIR（含 build.mjs 与 content/）→ 容器 /blog，渲染产物写 BLOG_DIST → /blog-dist
 * 2026-09-29：并入 BlogPublicModule —— 评论的审核（隐藏/删除）在后台做，但评论表与查询逻辑在 blog-public 里。
 *            鉴权换成 BlogAdminGuard（站点身份优先 + 旧 JWT 兜底），所以也要 IdentityModule。
 */
@Module({
    imports: [TypeOrmModule.forFeature([BlogPost]), BlogPublicModule, IdentityModule],
    controllers: [BlogAdminController],
    providers: [BlogAdminService, BlogAdminGuard, JwtAuthGuard],
    // 导出 guard 供别的模块复用（站内发信 /api/admin/mail/* 用它）。不导出的话，
    // 那些模块里的 @UseGuards(BlogAdminGuard) 启动期解析不到 provider，容器会直接 Restarting（2026-09-30 踩过）。
    exports: [BlogAdminService, BlogAdminGuard, JwtAuthGuard],
})
export class BlogAdminModule {}
