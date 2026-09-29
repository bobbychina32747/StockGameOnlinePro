import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppSecret } from '../../infrastructure/database/entities/app-secret.entity';
import { ArcadeLink } from '../../infrastructure/database/entities/arcade-link.entity';
import { IdentityModule } from '../identity/identity.module';
import { ArcadeController } from './arcade.controller';
import { ArcadeService } from './arcade.service';

/**
 * 游戏厅凭据桥（2026-09-29）：站点身份登录后免二次登录游戏厅。
 * 依赖 IdentityModule 的 SessionAuthGuard（域级会话）。
 * 表：arcade_links（身份 ↔ 游戏厅账号名）、app_secrets（派生密钥，随数据库备份走）。
 */
@Module({
    imports: [TypeOrmModule.forFeature([ArcadeLink, AppSecret]), IdentityModule],
    controllers: [ArcadeController],
    providers: [ArcadeService],
    exports: [ArcadeService],
})
export class ArcadeModule {}
