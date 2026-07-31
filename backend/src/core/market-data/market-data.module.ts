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
        providers: [market_data_service_1.MarketDataService],
        exports: [market_data_service_1.MarketDataService],
    })
],
MarketDataModule
);

