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

import debug_mode_service_1 = require("../../common/debug-mode/debug-mode.service");

import risk_manager_service_1 = require("../../core/risk-manager/risk-manager.service");

import market_gateway_1 = require("./market.gateway");

import news_service_1 = require("./news.service");

import config_1 = require("@nestjs/config");

import constants_1 = require("../../common/constants");

let MarketService = class MarketService {
    [key: string]: any;
    constructor(marketData, engine, gateway, newsService, riskManager, marketDataHK, marketDataUS, debugMode, config) {
        this.debugMode = debugMode;
        this.marketData = marketData;
        this.marketDataHK = marketDataHK;
        this.marketDataUS = marketDataUS;
        // 三服务器：全局价格聚合（riskManager 需全部市场价格）
        this.allPrices = {};
        this.tickCounterHK = 0;
        this.tickCounterUS = 0;
        this.engine = engine;
        this.gateway = gateway;
        this.newsService = newsService;
        this.riskManager = riskManager;
        this.logger = new common_1.Logger(MarketService.name);
        this.tickCounter = 0;
        this.processing = false;
        // P1 开盘竞价：各市场最近一次竞价开盘价（dayOpen 基准合并用）+ 每市场当日竞价已执行标记
        this.lastAuctionPrices = {};
        this.lastAuctionDay = {};
        // P4 新闻错峰队列：开盘/收盘生成的新闻按 tick 逐条播报，避免同一时刻扎堆
        this.newsQueue = { CN: [], HK: [], US: [] };
        // P0 时间尺度：TICK_INTERVAL_MS 控制每个行情 tick 的真实间隔（1000=高速回放 1秒1分钟，60000=实时分钟级），钳制 200~60000
        const rawInterval = Number(config && config.get ? config.get('TICK_INTERVAL_MS', 1000) : 1000);
        this.tickIntervalMs = Math.min(Math.max(Number.isFinite(rawInterval) ? rawInterval : 1000, 200), 60000);
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
    // S2 市场是否开市（供下单校验）；P1 支持按市场判断独立时段
    isMarketOpen(mode) {
        return (0, constants_1.isTradingTimeFor)(mode || 'CN');
    }
    async onModuleInit() {
        await this.marketData.init();
        // 三服务器：HK/US 实例手动初始化（factory 创建不触发生命周期钩子）
        if (this.marketDataHK) {
            await this.marketDataHK.init();
        }
        if (this.marketDataUS) {
            await this.marketDataUS.init();
        }
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
                this.marketDataFor(fill.symbol).applyUserFill(fill);
            }
            catch (e) { }
        });
        this.startTickLoop();
        this.logger.log('市场行情推送已启动（交易时段同步），tickCounter=' + this.tickCounter);
    }
    // 三服务器：单市场 tick 处理（行情生成/开盘事件/日终结算/挂单触发）
    async processMarket(market, marketData, counterKey) {
        let advanceCounter = false;
        try {
            // P1 三阶段集合竞价（仅 A 股 9:15-9:30）：整个窗口不生成连续行情
            // 9:15-9:20 可申报可撤单 / 9:20-9:25 可申报不可撤 / 9:25-9:30 撮合（每天仅一次，9:25 起执行）
            const auctionStage = (0, constants_1.auctionStageFor)(market);
            if (!this.debugMode.isMarketActive() && auctionStage) {
                if (auctionStage === 'matching') {
                    const todayKey = new Date().toDateString();
                    if (this.lastAuctionDay[market] !== todayKey) {
                        this.lastAuctionDay[market] = todayKey;
                        await this.runOpeningAuctions(market, marketData);
                    }
                }
                return;
            }
            // P1: 各市场独立时段——非本市场交易时段（且非调试模式）直接跳过，不生成行情
            if (!this.debugMode.isMarketActive() && !(0, constants_1.isTradingTimeFor)(market)) {
                return;
            }
            const ticks = await marketData.generateTick();
            if (ticks.length === 0) return;
            advanceCounter = true;
            const prices = {};
            ticks.forEach((t) => { prices[t.symbol] = t.price; });
            // 聚合到全局（风控需全市场价格）
            Object.assign(this.allPrices, prices);
            this.engine.updatePrices(prices);
            this.engine.refreshOrderBooks(prices);
            this.gateway.broadcastTick(ticks);
            const counter = this[counterKey] || 0;
            if (counter === 0) {
                // SECURITY: 日初先重置 T+1 再撮合挂单，避免首 tick 触发卖单被误判 T+1 取消
                await this.engine.resetBoughtToday();
                // P1 开盘集合竞价：按最大成交量原则形成开盘价并撮合交叉挂单（早于连续竞价）
                // P2: 当日已在盘前窗口竞价过则跳过（每天仅一次）
                const todayKey = new Date().toDateString();
                if (this.lastAuctionDay[market] !== todayKey) {
                    this.lastAuctionDay[market] = todayKey;
                    await this.runOpeningAuctions(market, marketData);
                }
            }
            const fills = await this.engine.checkPendingOrders();
            fills.forEach((f) => { this.gateway.broadcastFill(f); });
            // 经济泡沫破灭广播
            const bursts = marketData.getBurstEvents();
            for (const b of bursts) {
                this.gateway.broadcastNews({
                    title: `💥 泡沫破灭：${b.industry} 板块崩盘`, description: `${b.reason}，板块股价向内在价值剧烈回归，谨防踩踏`, type: 'bearish', impact: {}, duration: 2,
                });
                this.logger.warn(`💥 [${market}] 泡沫破灭: ${b.industry}（${b.reason}）`);
                // 复盘：泡沫破灭教育卡
                if (this.riskManager) {
                    this.riskManager.addGlobalReview({
                        type: '泡沫破灭',
                        title: `💥 ${b.industry} 板块泡沫破灭`, desc: `${b.reason}。板块股价正在向内在价值剧烈回归`, lesson: '泡沫破灭的教训：板块连续暴涨（涨幅远超基本面）时，任何细小抛售都可能引发连锁崩盘。识别泡沫：关注涨幅是否离谱、回调时是否放量下跌。破灭期不要抄底，等价格回归价值企稳后再介入',
                    });
                }
            }
            if (counter === 0) {
                // 玩法：热点/IPO/黑天鹅（各市场独立）
                await marketData.startNewDay();
                const events = marketData.getDayEvents();
                if (events && events.ipo && events.ipo.listed) {
                    for (const n of events.ipo.listed) {
                        // P4 错峰播报：入队而非立即广播
                        this.enqueueNews(market, {
                            title: `🚀 新股上市：${n.name}（${n.code}）`, description: `发行价 ${n.initialPrice} 元，所属行业 ${n.industry}，今日起可交易`, type: 'bullish', impact: {}, duration: 1,
                        });
                        this.logger.log(`🚀 新股上市: ${n.name}`);
                    }
                }
                if (events && events.swan) {
                    const good = events.swan.direction === 'good';
                    this.enqueueNews(market, {
                        title: good ? `🎉 利好：${events.swan.desc}` : `🦊 黑天鹅：${events.swan.desc}`, description: `影响：${events.swan.type === 'market' ? '全市场' : events.swan.type === 'industry' ? events.swan.industry + '板块' : events.swan.name} 约 ${events.swan.impact}%`, type: good ? 'bullish' : 'bearish', impact: {}, duration: 2,
                    });
                    if (good) this.logger.log(`🎉 政策红包: ${events.swan.desc}`);
                    else this.logger.warn(`🦊 黑天鹅: ${events.swan.desc}`);
                }
                // P1: dayOpen 基准 = 竞价开盘价（有竞价的股票），其余用首 tick 价格
                const openBase = { ...prices };
                Object.assign(openBase, this.lastAuctionPrices[market] || {});
                this.engine.setDayOpen(openBase);
                const state = marketData.getState();
                // 财报季
                if (marketData.gameDay > 0 && marketData.gameDay % 7 === 0) {
                    const n = marketData.generateReports();
                    if (n > 0) {
                        this.logger.log(`📊 [` + market + `] 财报季: ${n} 家公司披露季度财报`);
                        this.enqueueNews(market, {
                            title: `📊 财报季：${n} 家公司披露季度财报`, description: '业绩预期差将影响相关个股走势，注意持仓基本面变化', type: 'neutral', impact: {}, duration: 2,
                        });
                    }
                }
                // P4 日间新闻错峰播报（generateDailyNews 不再内部即时广播）
                const news = this.newsService.generateDailyNews(state.marketRegime, marketData.gameDay);
                if (news) {
                    this.logger.log(`📰 [` + market + `] ${news.title}`);
                    this.enqueueNews(market, news);
                    if (news.insiderNews)
                        this.enqueueNews(market, news.insiderNews);
                }
            }
            if (counter === 239) { // 分红/夜间事件
                try {
                    await this.engine.payDividends(marketData.getDividends(marketData.gameDay));
                } catch (e) {
                    this.logger.error(`分红发放失败: ${e.message}`);
                }
                const nightEvent = this.newsService.processNightEvent();
                if (nightEvent && nightEvent.impact !== 0) {
                    // SECURITY: 冲击必须写回行情引擎内部价格（原实现只改返回副本，下一 tick 被覆盖失效）
                    marketData.applyMarketwideShock(nightEvent.impact);
                    this.engine.updatePrices(marketData.getPrices());
                    this.enqueueNews(market, {
                        title: `🌙 ${nightEvent.name}`, description: `隔夜影响: ${(nightEvent.impact * 100).toFixed(1)}%`, type: 'night', impact: {}, duration: 1,
                    });
                }
                // P4 错峰播报：每 tick 播报一条排队中的新闻（全天均匀铺开）
                this.flushNewsQueue(market);
            }
            if (counter === 239) { // 日终结算
                await marketData.endOfDay();
                const day = marketData.gameDay;
                // FIX(H1): 全局账户日终结算只执行一次（三市场同 tick 到达日终，避免重复扣息/记快照/强平）
                if (market === 'CN') {
                    if (this.riskManager) {
                        await this.riskManager.settleAllAccounts(day);
                    }
                    const liquidated = await this.engine.forceLiquidateMarginalAccounts();
                    // 复盘：强平教训卡
                    if (this.riskManager && liquidated && liquidated.length > 0) {
                        for (const l of liquidated) {
                            const acct = await this.engine.getAccountById(l.accountId);
                            if (acct) {
                                this.riskManager.addReview(acct.userId, {
                                    type: '强平',
                                    title: '💔 账户被强制平仓', desc: `保证金率跌破阈值（${(l.marginLevel * 100).toFixed(1)}%），所有持仓被强平`, lesson: '强平的教训：做空/融资仓位要预留充足保证金，保证金率跌破 100% 就会被强平。建议：①控制杠杆 ≤2x ②单边行情别满仓做空 ③及时补足保证金',
                                });
                            }
                        }
                        this.riskManager.addGlobalReview({
                            type: '市场警示',
                            title: '💔 有玩家被强制平仓', desc: '高杠杆玩家因保证金不足被强平，市场风险释放', lesson: '杠杆是把双刃剑：暴涨时放大收益，回调时直接出局。新手建议从无杠杆开始',
                        });
                    }
                }
                this.logger.log(`📅 [` + market + `] 第 ${day} 个交易日结束`);
            }
        } catch (e) {
            this.logger.error(`[` + market + `] Tick处理异常: ${e.message}`);
        } finally {
            // SECURITY: tick 已生成时无论成功失败都推进计数，防止异常后重复触发日终结算/分红
            if (advanceCounter) {
                const c = this[counterKey] || 0;
                this[counterKey] = (c + 1) % 240;
            }
        }
    }
    async startTickLoop() {
        const tick = async () => {
            if (this.processing) return;
            this.processing = true;
            try {
                // P1: 全局不再统一门控，由 processMarket 按各市场独立时段判断
                // 三服务器：轮流处理 CN/HK/US（各自独立 gameDay/因子/事件/时段）
                await this.processMarket('CN', this.marketData, 'tickCounter');
                await this.processMarket('HK', this.marketDataHK, 'tickCounterHK');
                await this.processMarket('US', this.marketDataUS, 'tickCounterUS');
                // 全局价格聚合 → 风控/保证金
                if (this.riskManager) {
                    this.riskManager.setMarketPrices(this.allPrices);
                }
            }
            catch (e) {
                this.logger.error('Tick处理异常', e);
            }
            finally {
                this.processing = false;
                // 递归必须在 finally 内：try 内 return（休市）会跳过其后的 setTimeout
                setTimeout(tick, this.tickIntervalMs);
            }
        };
        setTimeout(tick, this.tickIntervalMs);
    }
    // P4 新闻错峰：入队 + 每 tick 播报一条
    enqueueNews(market, item) {
        if (!item)
            return;
        const q = this.newsQueue[market] || (this.newsQueue[market] = []);
        q.push(item);
    }
    flushNewsQueue(market) {
        const q = this.newsQueue[market];
        if (!q || q.length === 0)
            return;
        const item = q.shift();
        try {
            this.gateway.broadcastNews(item);
        }
        catch (e) {
            this.logger.warn('新闻播报失败: ' + ((e && e.message) || e));
        }
    }
    // P1 开盘集合竞价：对每只有挂单的股票按最大成交量原则定价并撮合，用户成交走真实结算
    async runOpeningAuctions(market, marketData) {
        const prevCloses = marketData.getPrevCloses();
        const auctionPrices = {};
        const realFills = [];
        for (const symbol of Object.keys(prevCloses)) {
            let result;
            try {
                result = this.engine.runOpeningAuction(symbol, prevCloses[symbol]);
            }
            catch (e) {
                this.logger.warn('集合竞价失败 ' + symbol + ': ' + ((e && e.message) || e));
                continue;
            }
            if (!result || result.fills.length === 0)
                continue;
            auctionPrices[symbol] = result.auctionPrice;
            for (const f of result.fills) {
                if (!f.virtual && f.orderId) {
                    realFills.push(f);
                }
            }
            this.logger.log('🔔 [' + market + '] 开盘竞价: ' + symbol + ' @ ' + result.auctionPrice + '（成交 ' + Math.floor(result.fills.length / 2) + ' 对）');
        }
        if (realFills.length > 0) {
            try {
                await this.engine.settleCounterFills(market, realFills);
            }
            catch (e) {
                this.logger.warn('集合竞价结算失败: ' + ((e && e.message) || e));
            }
        }
        this.lastAuctionPrices[market] = auctionPrices;
        if (Object.keys(auctionPrices).length > 0) {
            marketData.setAuctionDayOpens(auctionPrices);
        }
    }
    // 三服务器路由：按股票代码前缀选择对应市场实例（H→HK，U→US，其他→CN）
    marketDataFor(symbol) {
        if (/^H/.test(symbol || ''))
            return this.marketDataHK;
        if (/^U/.test(symbol || ''))
            return this.marketDataUS;
        return this.marketData;
    }
    getKlines(symbol, timeframe) {
        return this.marketDataFor(symbol).getKlines(symbol, timeframe);
    }
    getOrderBook(symbol) {
        return this.engine.getOrderBook(symbol);
    }
    getPrices() {
        // 三服务器合并
        const all = {};
        for (const md of [this.marketData, this.marketDataHK, this.marketDataUS]) {
            if (md)
                Object.assign(all, md.getPrices());
        }
        return all;
    }
    getStocks() {
        // 三服务器合并（前端按市场过滤）
        const all = [];
        for (const md of [this.marketData, this.marketDataHK, this.marketDataUS]) {
            if (md)
                all.push(...md.getStockList());
        }
        return all;
    }
    getIndices() {
        // 三服务器合并（前端按市场过滤显示）
        const all = [];
        for (const md of [this.marketData, this.marketDataHK, this.marketDataUS]) {
            if (md)
                all.push(...md.getIndices());
        }
        return all;
    }
    getState() {
        // 合并：当前市场用 CN（前端市场切换时按各自 state 展示）
        const cn = this.marketData.getState();
        // P0: 暴露 tick 间隔，前端据此标注「高速回放」或「实时行情」
        cn.tickIntervalMs = this.tickIntervalMs;
        // P6: 全服休市交易状态（所有客户端据此解锁休市下单）
        cn.offHoursTrading = !!this.debugMode.getGlobalBypass();
        // 浅拷贝避免循环引用（markets.CN 不能引用 cn 自身）
        cn.markets = {
            CN: { ...cn },
            HK: this.marketDataHK ? this.marketDataHK.getState() : null,
            US: this.marketDataUS ? this.marketDataUS.getState() : null,
        };
        return cn;
    }
    getReports(symbol) {
        return this.marketDataFor(symbol).getReports(symbol);
    }
    // ─── B2 回测：MA 交叉策略（返回结果 + 收益曲线抽样 40 点） ───
    backtest(symbol, fast = 5, slow = 20, timeframe = '1min') {
        const klines = this.marketDataFor(symbol).getKlines(symbol, timeframe);
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
    __param(5, (0, common_1.Inject)('MarketDataHK')),
    __param(6, (0, common_1.Inject)('MarketDataUS')),
    __metadata("design:paramtypes", [market_data_service_1.MarketDataService,
        trading_engine_service_1.TradingEngineService,
        market_gateway_1.MarketGateway,
        news_service_1.NewsService,
        risk_manager_service_1.RiskManagerService,
        market_data_service_1.MarketDataService,
        market_data_service_1.MarketDataService,
        debug_mode_service_1.DebugModeService,
        config_1.ConfigService])
],
MarketService
);

