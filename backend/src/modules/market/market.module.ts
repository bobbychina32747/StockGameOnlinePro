var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import market_controller_1 = require("./market.controller");

import market_gateway_1 = require("./market.gateway");

import market_service_1 = require("./market.service");

import news_service_1 = require("./news.service");

let MarketModule = class MarketModule {
    [key: string]: any;
};

export { MarketModule };

MarketModule = __decorate(
[
    (0, common_1.Module)({
        controllers: [market_controller_1.MarketController],
        providers: [market_gateway_1.MarketGateway, market_service_1.MarketService, news_service_1.NewsService],
        exports: [market_service_1.MarketService, news_service_1.NewsService],
    })
],
MarketModule
);

