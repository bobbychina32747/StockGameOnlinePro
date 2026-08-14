var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import config_1 = require("@nestjs/config");

import typeorm_1 = require("@nestjs/typeorm");

import market_data_module_1 = require("./core/market-data/market-data.module");

import trading_engine_module_1 = require("./core/trading-engine/trading-engine.module");

import risk_manager_module_1 = require("./core/risk-manager/risk-manager.module");

import auth_module_1 = require("./modules/auth/auth.module");

import user_module_1 = require("./modules/user/user.module");

import account_module_1 = require("./modules/account/account.module");

import trading_module_1 = require("./modules/trading/trading.module");

import debug_mode_module_1 = require("./common/debug-mode/debug-mode.module");

import market_module_1 = require("./modules/market/market.module");

import fund_module_1 = require("./modules/fund/fund.module");

import ranking_module_1 = require("./modules/ranking/ranking.module");

import admin_module_1 = require("./modules/admin/admin.module");

let AppModule = class AppModule {
    [key: string]: any;
};

export { AppModule };

AppModule = __decorate(
[
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                envFilePath: '.env',
            }),
            typeorm_1.TypeOrmModule.forRootAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (config) => {
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
            market_data_module_1.MarketDataModule,
            trading_engine_module_1.TradingEngineModule,
            risk_manager_module_1.RiskManagerModule,
            auth_module_1.AuthModule,
            user_module_1.UserModule,
            account_module_1.AccountModule,
            trading_module_1.TradingModule,
            debug_mode_module_1.DebugModeModule,
            market_module_1.MarketModule,
            fund_module_1.FundModule,
            ranking_module_1.RankingModule,
            admin_module_1.AdminModule,
        ],
    })
],
AppModule
);

