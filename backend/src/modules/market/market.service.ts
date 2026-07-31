var __param = function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import common_1 = require("@nestjs/common");

import market_data_service_1 = require("../../core/market-data/market-data.service");

import trading_engine_service_1 = require("../../core/trading-engine/trading-engine.service");

import risk_manager_service_1 = require("../../core/risk-manager/risk-manager.service");

import market_gateway_1 = require("./market.gateway");

import news_service_1 = require("./news.service");

let MarketService = class MarketService {
    [key: string]: any;
    constructor(marketData, engine, gateway, newsService, riskManager) {
        this.marketData = marketData;
        this.engine = engine;
        this.gateway = gateway;
        this.newsService = newsService;
        this.riskManager = riskManager;
        this.logger = new common_1.Logger(MarketService.name);
        this.tickCounter = 0;
        this.processing = false;
    }
    async onModuleInit() {
        await this.marketData.init();
        this.startTickLoop();
        this.logger.log('市场行情推送已启动');
    }
    async startTickLoop() {
        const tick = async () => {
            if (this.processing) return;
            this.processing = true;
            try {
                const ticks = this.marketData.generateTick();
                if (ticks.length > 0) {
                    const prices = {};
                    ticks.forEach((t) => { prices[t.symbol] = t.price; });
                    this.engine.updatePrices(prices);
                    this.engine.refreshOrderBooks(prices);
                    if (this.riskManager) {
                        this.riskManager.setMarketPrices(prices);
                    }
                    this.gateway.broadcastTick(ticks);
                    const fills = await this.engine.checkPendingOrders();
                    fills.forEach((f) => { this.gateway.broadcastFill(f); });
                    if (this.tickCounter === 0) {
                        this.engine.setDayOpen(prices);
                        await this.engine.resetBoughtToday();
                        const state = this.marketData.getState();
                        const news = this.newsService.generateDailyNews(state.marketRegime, this.marketData.gameDay);
                        if (news) {
                            this.logger.log(`📰 ${news.title}`);
                        }
                    }
                    if (this.tickCounter === 385) {
                        const nightEvent = this.newsService.processNightEvent();
                        if (nightEvent && nightEvent.impact !== 0) {
                            const prices = this.marketData.getPrices();
                            for (const sym of Object.keys(prices)) {
                                prices[sym] *= (1 + nightEvent.impact);
                            }
                            this.engine.updatePrices(prices);
                        }
                    }
                    // 日终：第 389 tick 结束时执行结算
                    if (this.tickCounter === 389) {
                        await this.marketData.endOfDay();
                        const day = this.marketData.gameDay;
                        // F6 修复：日终结算所有账户（更新权益/峰值/快照，排行榜数据源）
                        if (this.riskManager) {
                            await this.riskManager.settleAllAccounts(day);
                        }
                        // F7 修复：爆仓账户强制平仓
                        await this.engine.forceLiquidateMarginalAccounts();
                        this.logger.log(`📅 第 ${day} 个交易日结束`);
                    }
                    this.tickCounter = (this.tickCounter + 1) % 390;
                }
            }
            catch (e) {
                this.logger.error('Tick处理异常', e);
            }
            finally {
                this.processing = false;
            }
            setTimeout(tick, 1000);
        };
        setTimeout(tick, 1000);
    }
    getKlines(symbol, timeframe) {
        return this.marketData.getKlines(symbol, timeframe);
    }
    getOrderBook(symbol) {
        return this.engine.getOrderBook(symbol);
    }
    getPrices() {
        return this.marketData.getPrices();
    }
    getStocks() {
        return this.marketData.getStockList();
    }
    getIndices() {
        return this.marketData.getIndices();
    }
};

export { MarketService };

MarketService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [market_data_service_1.MarketDataService,
        trading_engine_service_1.TradingEngineService,
        market_gateway_1.MarketGateway,
        news_service_1.NewsService,
        risk_manager_service_1.RiskManagerService])
],
MarketService
);

