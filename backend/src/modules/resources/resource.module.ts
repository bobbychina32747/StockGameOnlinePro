import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourceItem } from '../../infrastructure/database/entities/resource-item.entity';
import { BlogAdminModule } from '../blog-admin/blog-admin.module';
import { IdentityModule } from '../identity/identity.module';
import { ResourceAdminController } from './resource-admin.controller';
import { ResourceController } from './resource.controller';
import { ResourceService } from './resource.service';

/**
 * 共享资源模块
 *   · 公开：GET /api/resources、GET /api/resources/file/:key
 *   · 后台：GET/POST/DELETE /api/admin/resources、POST /api/admin/resources/upload
 * 表 resource_items 由 TypeORM synchronize 自动建（与 blog_posts 同一套约定）。
 * 鉴权复用 BlogAdminModule 导出的 BlogAdminGuard（不要在自己模块里重复 provide，否则依赖解析不到）。
 * 依赖说明（同 webmail.module.ts 踩过的坑）：
 *   · BlogAdminModule 必须导出 BlogAdminGuard 与它注入的 JwtAuthGuard；
 *   · BlogAdminGuard 还注入 IdentityService，重导出不会自动传给导入方，所以这里再直接 import IdentityModule。
 */
@Module({
    imports: [TypeOrmModule.forFeature([ResourceItem]), BlogAdminModule, IdentityModule],
    controllers: [ResourceController, ResourceAdminController],
    providers: [ResourceService],
    exports: [ResourceService],
})
export class ResourceModule {}
