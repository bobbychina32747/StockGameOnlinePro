import { Module } from '@nestjs/common';

import { BlogAdminModule } from '../blog-admin/blog-admin.module';
import { IdentityModule } from '../identity/identity.module';
import { WebmailController } from './webmail.controller';
import { WebmailService } from './webmail.service';

/**
 * 站内发信（2026-09-30）：站主以 contact@bobbycn.cc 回信，手机也能用。
 * 鉴权直接复用 BlogAdminGuard（站点身份=站主 或 写作台管理员 JWT）。
 * 依赖说明（都是启动期踩出来的）：
 *   · BlogAdminModule 必须**导出** BlogAdminGuard 与它注入的 JwtAuthGuard，否则本模块解析不到 provider；
 *   · BlogAdminGuard 还注入 IdentityService，而重导出不会自动传给导入方，所以这里再直接 import IdentityModule。
 */
@Module({
    imports: [BlogAdminModule, IdentityModule],
    controllers: [WebmailController],
    providers: [WebmailService],
    exports: [WebmailService],
})
export class WebmailModule {}
