import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketDataModule } from './core/market-data/market-data.module';
import { TradingEngineModule } from './core/trading-engine/trading-engine.module';
import { RiskManagerModule } from './core/risk-manager/risk-manager.module';

import { AuthModule } from './modules/auth/auth.module';
// 2026-09-28：统一身份模块（与既有 auth 并存，端点暂挂 /api/auth/identity/* 以避免路由遮蔽）
import { IdentityModule } from './modules/identity/identity.module';
// 2026-09-28：站内写作台（博客）—— /api/admin/blog/*
import { BlogAdminModule } from './modules/blog-admin/blog-admin.module';
// 2026-09-29：博客对外能力—— /api/blog/*（浏览量 + 评论；nginx 需把该前缀反代到本机）
import { BlogPublicModule } from './modules/blog-public/blog-public.module';
// 2026-09-29：游戏厅凭据桥—— /api/games/*（站点身份登录后免二次登录游戏厅）
import { ArcadeModule } from './modules/arcade/arcade.module';
// 2026-09-30：站内发信—— /api/admin/mail/*（站主以 contact@bobbycn.cc 回信）
import { WebmailModule } from './modules/webmail/webmail.module';
import { UserModule } from './modules/user/user.module';
import { AccountModule } from './modules/account/account.module';
import { TradingModule } from './modules/trading/trading.module';
import { DebugModeModule } from './common/debug-mode/debug-mode.module';
import { MarketModule } from './modules/market/market.module';
import { FundModule } from './modules/fund/fund.module';
import { RankingModule } from './modules/ranking/ranking.module';
import { AdminModule } from './modules/admin/admin.module';

// Phase C: 模拟大赛 V1
import { SeasonModule } from './modules/season/season.module';

// R5-⑩: 模块文件没有类实例，装配期告警用静态 Logger（与 Nest 启动日志同源，便于运维检索）
const logger = new Logger('AppModule');

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            envFilePath: '.env',
        }),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const dbType = config.get('DB_TYPE', 'sqlite');
                // R5-⑩: synchronize 统一由 DB_SYNCHRONIZE 控制（三个分支共用）。原实现三处硬编码
                // synchronize: true，生产环境会随代码自动改表结构（丢列/改类型的不可逆风险）。
                // 默认仍为 true 保持向后兼容；置 false 后需自行建表/跑迁移，库表不会自动创建。
                const synchronize = String(config.get('DB_SYNCHRONIZE', 'true')) !== 'false';
                // 仅告警不抛错：避免既有部署（未设置该变量）在升级后直接启动失败
                if (synchronize && config.get('NODE_ENV') === 'production') {
                    logger.warn('生产环境 DB_SYNCHRONIZE=true：表结构会随代码自动同步，建议改为 false 并用迁移管理');
                }
                if (dbType === 'postgres') {
                    const dbPassword = config.get('DB_PASSWORD');
                    // SECURITY(G): 移除默认密码 stockgame_dev_2024，缺失时直接失败并提示配置
                    if (!dbPassword) {
                        throw new Error('postgres 模式必须配置 DB_PASSWORD 环境变量（已移除内置默认密码）');
                    }
                    return {
                        type: 'postgres',
                        host: config.get('DB_HOST', 'localhost'),
                        port: config.get('DB_PORT', 5432),
                        username: config.get('DB_USERNAME', 'stockgame'),
                        password: dbPassword,
                        database: config.get('DB_DATABASE', 'stockgame'),
                        autoLoadEntities: true,
                        // R5-⑩: 由 DB_SYNCHRONIZE 控制（生产建议 false + 迁移管理）
                        synchronize,
                        logging: config.get('NODE_ENV') === 'development',
                    };
                }
                // P0 数据库持久化改造：默认 sqlite 走 better-sqlite3（原生驱动，WAL 增量写盘，
                // 消除 sql.js 定时全库导出导致的秒级主线程阻塞）；sql.js 文件格式与
                // better-sqlite3 完全兼容，现有 data/stockgame.db 可直接复用（见 scripts/migrate-sqljs-to-better-sqlite3.mjs）
                if (dbType === 'sqlite' || dbType === 'better-sqlite3') {
                    return {
                        type: 'better-sqlite3',
                        database: config.get('SQLITE_PATH', './data/stockgame.db'),
                        autoLoadEntities: true,
                        // R5-⑩: 由 DB_SYNCHRONIZE 控制
                        synchronize,
                        logging: false,
                    };
                }
                // 兼容旧驱动：DB_TYPE=sqljs（内存库 + main.ts 定时全库导出）
                return {
                    type: 'sqljs',
                    location: config.get('SQLITE_PATH', './data/stockgame.db'),
                    autoLoadEntities: true,
                    // R5-⑩: 由 DB_SYNCHRONIZE 控制
                    synchronize,
                    // FIX(G): 关闭每次写盘全库序列化（性能），改由 main.ts 定时原子持久化
                    autoSave: false,
                    logging: false,
                };
            },
        }),
        MarketDataModule,
        TradingEngineModule,
        RiskManagerModule,
        AuthModule,
        // 统一身份模块：端点挂在 /api/auth/identity/*（避开与既有 AuthController 的路由遮蔽）
        IdentityModule,
        // 站内写作台：/api/admin/blog/*
        BlogAdminModule,
        // 博客对外：/api/blog/*（浏览量、评论）
        BlogPublicModule,
        // 游戏厅凭据桥：/api/games/*（站点身份 → 游戏厅免二次登录）
        ArcadeModule,
        // 站内发信：/api/admin/mail/*（以 contact@bobbycn.cc 发信）
        WebmailModule,
        UserModule,
        AccountModule,
        TradingModule,
        DebugModeModule,
        MarketModule,
        FundModule,
        RankingModule,
        AdminModule,
        SeasonModule,
    ],
})
export class AppModule {}
