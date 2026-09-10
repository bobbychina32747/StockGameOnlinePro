import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MarketDataModule } from './core/market-data/market-data.module';
import { TradingEngineModule } from './core/trading-engine/trading-engine.module';
import { RiskManagerModule } from './core/risk-manager/risk-manager.module';

import { AuthModule } from './modules/auth/auth.module';
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
                        // TODO: 生产环境改用迁移（migrations），禁止长期使用 synchronize: true
                        synchronize: true,
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
                        synchronize: true,
                        logging: false,
                    };
                }
                // 兼容旧驱动：DB_TYPE=sqljs（内存库 + main.ts 定时全库导出）
                return {
                    type: 'sqljs',
                    location: config.get('SQLITE_PATH', './data/stockgame.db'),
                    autoLoadEntities: true,
                    synchronize: true,
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
