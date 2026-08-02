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
    // S2 真实交易时段判断：周一至周五 9:30-11:30 / 13:00-15:00
    isTradingTime() {
        const now = new Date();
        const day = now.getDay();
        if (day === 0 || day === 6)
            return false; // 周末休市
        const minutes = now.getHours() * 60 + now.getMinutes();
        const morning = minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30;
        const afternoon = minutes >= 13 * 60 && minutes < 15 * 60;
        return morning || afternoon;
    }
    // S2 市场是否开市（供下单校验）
    isMarketOpen() {
        return this.isTradingTime();
    }
    async onModuleInit() {
        await this.marketData.init();
        // S2 启动校准：交易中启动时 tickCounter 对齐当前真实时段分钟数（避免误触发开盘/日终）
        const now = new Date();
        const minutes = now.getHours() * 60 + now.getMinutes();
        if (minutes >= 570 && minutes < 690) {
            this.tickCounter = minutes - 570;
        }
        else if (minutes >= 780 && minutes < 900) {
            this.tickCounter = 120 + (minutes - 780);
        }
        else {
            this.tickCounter = 0;
        }
        // B1 用户成交 → 行情引擎回调（价格冲击 + 成交量并入当前K线）
        this.engine.setUserFillHook((fill) => {
            try {
                this.marketData.applyUserFill(fill);
            }
            catch (e) { }
        });
        this.startTickLoop();
        this.logger.log('市场行情推送已启动（交易时段同步），tickCounter=' + this.tickCounter);
    }
    async startTickLoop() {
        const tick = async () => {
            if (this.processing) return;
            this.processing = true;
            try {
                // S2 交易时段同步：休市（非9:30-11:30/13:00-15:00或周末）不生成行情
                if (!this.isTradingTime()) {
                    return;
                }
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
                        // 玩法：热点/IPO/黑天鹅
                        this.marketData.startNewDay();
                        const events = this.marketData.getDayEvents();
                        if (events && events.ipo && events.ipo.listed) {
                            for (const n of events.ipo.listed) {
                                this.gateway.broadcastNews({
                                    title: `🚀 新股上市：${n.name}（${n.code}）`, description: `发行价 ${n.initialPrice} 元，所属行业 ${n.industry}，今日起可交易`, type: 'bullish', impact: {}, duration: 1,
                                });
                                this.logger.log(`🚀 新股上市: ${n.name}`);
                            }
                        }
                                                                        if (events && events.swan) {
                            // C1 利好型（政策红包）→ bullish；利空型（黑天鹅）→ bearish
                            const good = events.swan.direction === 'good';
                            this.gateway.broadcastNews({
                                title: good ? `🎉 利好：${events.swan.desc}` : `🦊 黑天鹅：${events.swan.desc}`, description: `影响：${events.swan.type === 'market' ? '全市场' : events.swan.type === 'industry' ? events.swan.industry + '板块' : events.swan.name} 约 ${events.swan.impact}%`, type: good ? 'bullish' : 'bearish', impact: {}, duration: 2,
                            });
                            if (good)
                                this.logger.log(`🎉 政策红包: ${events.swan.desc}`);
                            else
                                this.logger.warn(`🦊 黑天鹅: ${events.swan.desc}`);
                        }
                        this.engine.setDayOpen(prices);
                        await this.engine.resetBoughtToday();
                        const state = this.marketData.getState();
                        // 财报季（每 20 个交易日）
                        if (this.marketData.gameDay > 0 && this.marketData.gameDay % 7 === 0) { // S2 节奏：财报季每周一次
                            const n = this.marketData.generateReports();
                            if (n > 0)
                                this.logger.log(`📊 财报季: ${n} 家公司披露季度财报`);
                        }
                        const news = this.newsService.generateDailyNews(state.marketRegime, this.marketData.gameDay);
                        if (news) {
                            this.logger.log(`📰 ${news.title}`);
                        }
                    }
                    if (this.tickCounter === 239) { // 分红/夜间事件
                        // 玩法：分红到账（当日财报季产生的分红）
                        try {
                            await this.engine.payDividends(this.marketData.getDividends(this.marketData.gameDay));
                        }
                        catch (e) {
                            this.logger.error(`分红发放失败: ${e.message}`);
                        }
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
                    if (this.tickCounter === 239) { // 日终结算(最后tick)
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
                    this.tickCounter = (this.tickCounter + 1) % 240;
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
    getState() {
        return this.marketData.getState();
    }
    getReports(symbol) {
        return this.marketData.getReports(symbol);
    }
    // ─── B2 回测：MA 交叉策略（返回结果 + 收益曲线抽样 40 点） ───
    backtest(symbol, fast = 5, slow = 20, timeframe = '1min') {
        const klines = this.marketData.getKlines(symbol, timeframe);
        const closes = klines.map((k) => Number(k.close));
        const fastN = Number(fast) || 5;
        const slowN = Number(slow) || 20;
        if (closes.length < slowN + 5) {
            return { error: '历史数据不足，请稍后再试' };
        }
        const sma = (closes, period) => {
            const out = new Array(closes.length).fill(null);
            let sum = 0;
            for (let i = 0; i < closes.length; i++) {
                sum += closes[i];
                if (i >= period) sum -= closes[i - period];
                if (i >= period - 1) out[i] = sum / period;
            }
            return out;
        };
        const maF = sma(closes, fastN);
        const maS = sma(closes, slowN);
        let cash = 100000, shares = 0, buyPrice = 0, trades = 0, wins = 0;
        const equityCurve = [];
        for (let i = slowN; i < closes.length; i++) {
            const pf = maF[i - 1], ps = maS[i - 1], f = maF[i], sl = maS[i];
            if (pf == null || ps == null) continue;
            if (pf <= ps && f > sl && shares === 0) {
                shares = Math.floor(cash / closes[i] / 100) * 100;
                if (shares > 0) { cash -= shares * closes[i]; buyPrice = closes[i]; }
            }
            else if (pf >= ps && f < sl && shares > 0) {
                if (closes[i] > buyPrice) wins++;
                trades++;
                cash += shares * closes[i];
                shares = 0;
            }
            if (i % Math.max(1, Math.floor(closes.length / 40)) === 0) {
                equityCurve.push(Number((cash + shares * closes[i]).toFixed(0)));
            }
        }
        if (shares > 0) { cash += shares * closes[closes.length - 1]; trades++; }
        const finalEquity = cash;
        const totalReturn = (finalEquity - 100000) / 100000 * 100;
        return {
            symbol,
            timeframe,
            bars: closes.length,
            finalEquity: Number(finalEquity.toFixed(2)),
            totalReturn: Number(totalReturn.toFixed(2)),
            trades,
            winRate: trades ? Number((wins / trades * 100).toFixed(0)) : 0,
            equityCurve,
        };
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

