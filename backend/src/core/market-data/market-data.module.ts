var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import stock_entity_1 = require("../../infrastructure/database/entities/stock.entity");

import kline_entity_1 = require("../../infrastructure/database/entities/kline.entity");

import trading_engine_service_1 = require("../trading-engine/trading-engine.service");

import market_data_service_1 = require("./market-data.service");

let MarketDataModule = class MarketDataModule {
    [key: string]: any;
};

export { MarketDataModule };

MarketDataModule = __decorate(
[
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([stock_entity_1.Stock, kline_entity_1.Kline])],
        providers: [
            market_data_service_1.MarketDataService,
            // 三服务器：HK/US 独立 MarketDataService 实例（CN 用默认）
            {
                provide: 'MarketDataHK',
                useFactory: (stockRepo, klineRepo, engine) => new market_data_service_1.MarketDataService(stockRepo, klineRepo, engine, 'HK'),
                inject: [
                    (0, typeorm_1.getRepositoryToken)(stock_entity_1.Stock),
                    (0, typeorm_1.getRepositoryToken)(kline_entity_1.Kline),
                    trading_engine_service_1.TradingEngineService,
                ],
            },
            {
                provide: 'MarketDataUS',
                useFactory: (stockRepo, klineRepo, engine) => new market_data_service_1.MarketDataService(stockRepo, klineRepo, engine, 'US'),
                inject: [
                    (0, typeorm_1.getRepositoryToken)(stock_entity_1.Stock),
                    (0, typeorm_1.getRepositoryToken)(kline_entity_1.Kline),
                    trading_engine_service_1.TradingEngineService,
                ],
            },
        ],
        exports: [market_data_service_1.MarketDataService, 'MarketDataHK', 'MarketDataUS'],
    })
],
MarketDataModule
);

