import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BlogPost } from '../../infrastructure/database/entities/blog-post.entity';
import { BlogPublicModule } from '../blog-public/blog-public.module';
import { BlogAdminController } from './blog-admin.controller';
import { BlogAdminService } from './blog-admin.service';

/**
 * 站内写作台（博客）
 * 依赖：同一个 SQLite 库（blog_posts 表由 TypeORM synchronize 自动建，与其他表一致）
 *     宿主挂载 BLOG_DIR（含 build.mjs 与 content/）→ 容器 /blog，渲染产物写 BLOG_DIST → /blog-dist
 * 2026-09-29：并入 BlogPublicModule —— 评论的审核（隐藏/删除）在后台做，但评论表与查询逻辑在 blog-public 里。
 */
@Module({
    imports: [TypeOrmModule.forFeature([BlogPost]), BlogPublicModule],
    controllers: [BlogAdminController],
    providers: [BlogAdminService],
    exports: [BlogAdminService],
})
export class BlogAdminModule {}
