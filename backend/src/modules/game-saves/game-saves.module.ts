import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppSecret } from '../../infrastructure/database/entities/app-secret.entity';
import { GameSave } from '../../infrastructure/database/entities/game-save.entity';
import { IdentitySecret } from '../../infrastructure/database/entities/identity-secret.entity';

// 授权系统复用：存档读写要验「access_token + saves scope」，故依赖 IdentityModule 导出的 OauthService
import { IdentityModule } from '../identity/identity.module';
import { GameSavesController, SaveTokenGuard } from './game-saves.controller';
import { GameSavesService } from './game-saves.service';

/**
 * 云存档模块（2026-10-08）：把存档从「用户自己的 Gist + 口令派生密钥」搬到「站点账号 + 服务端托管密钥」。
 * 端点：/api/auth/identity/saves/*（与授权端点同一 nginx 前缀，零配置上线）。
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([GameSave, IdentitySecret, AppSecret]),
        IdentityModule,
    ],
    controllers: [GameSavesController],
    providers: [GameSavesService, SaveTokenGuard],
    exports: [GameSavesService],
})
export class GameSavesModule {}
