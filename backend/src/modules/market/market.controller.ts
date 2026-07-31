var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import common_1 = require("@nestjs/common");

import market_service_1 = require("./market.service");

let MarketController = class MarketController {
    [key: string]: any;
    constructor(marketService) {
        this.marketService = marketService;
    }
    getPrices() {
        return this.marketService.getPrices();
    }
    getStocks() {
        return this.marketService.getStocks();
    }
    getIndices() {
        return this.marketService.getIndices();
    }
    getKlines(symbol, timeframe) {
        return this.marketService.getKlines(symbol || 'A', timeframe || '1min');
    }
    getOrderBook(symbol) {
        return this.marketService.getOrderBook(symbol || 'A');
    }
};
__decorate([
    (0, common_1.Get)('prices'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], MarketController.prototype, "getPrices", null);
__decorate([
    (0, common_1.Get)('stocks'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], MarketController.prototype, "getStocks", null);
__decorate([
    (0, common_1.Get)('indices'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], MarketController.prototype, "getIndices", null);
__decorate([
    (0, common_1.Get)('klines'),
    __param(0, (0, common_1.Query)('symbol')),
    __param(1, (0, common_1.Query)('timeframe')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", void 0)
], MarketController.prototype, "getKlines", null);
__decorate([
    (0, common_1.Get)('orderbook'),
    __param(0, (0, common_1.Query)('symbol')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], MarketController.prototype, "getOrderBook", null);

export { MarketController };

MarketController = __decorate(
[
    (0, common_1.Controller)('market'),
    __metadata("design:paramtypes", [market_service_1.MarketService])
],
MarketController
);

