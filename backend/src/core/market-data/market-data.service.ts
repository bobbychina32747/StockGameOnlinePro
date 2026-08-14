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

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import stock_entity_1 = require("../../infrastructure/database/entities/stock.entity");

import kline_entity_1 = require("../../infrastructure/database/entities/kline.entity");

import constants_1 = require("../../common/constants");

import trading_engine_service_1 = require("../trading-engine/trading-engine.service");

// SECURITY: K线启动去重只执行一次（三市场实例共享模块状态）
let klineDedupDone = false;

let MarketDataService = class MarketDataService {
    [key: string]: any;
    constructor(stockRepo, klineRepo, engine, market = 'CN') {
        this.stockRepo = stockRepo;
        this.market = market; // 三服务器：CN/HK/US 独立实例
        this.klineRepo = klineRepo;
        this.engine = engine;
        this.logger = new common_1.Logger(MarketDataService.name);
        this.stocks = new Map<string, any>();
        this.marketRegime = 'sideways';
        this.tickCount = 0;
        // 财报事件（真实化：按财报季生成并影响股价）
        this.reports = new Map<string, any[]>();
        // ─── 玩法引擎：热点题材 / IPO / 黑天鹅 / 分红 ───
        this.hotTopics = [];
        this.hotDay = -1;
        // IPO 池仅 A 股服务器使用（三服务器共用会重复上市同一新股 → UNIQUE 冲突）
        this.ipoQueue = this.market === 'CN' ? [...constants_1.IPO_POOL] : [];
        this.nextIpoDay = 30;
        // P1 复权：累计前复权因子与分红事件序列（历史价格 × 因子 = 前复权价）
        this.adjFactors = new Map<string, { factor: number, series: { day: number, factor: number }[] }>();
        this.dayEvents = null;
        this.dividends = new Map<string, any[]>();
        this.gameDay = 0;
        this.factors = {} as Record<string, number>;
        this.isRunning = false;
        // 经济泡沫机制：破灭中的行业 + 破灭事件广播队列
        this.burstingIndustries = new Set();
        this.burstEvents = [];
        this.industryBubbleMap = {};
        // AI 对手盘：机构/游资/散户市场参与者（每服务器独立）
        this.aiAgents = [
            { type: '机构', activity: 0.25, scale: 25000 },
            { type: '机构', activity: 0.2, scale: 30000 },
            { type: '游资', activity: 0.45, scale: 9000 },
            { type: '游资', activity: 0.4, scale: 7000 },
            { type: '游资', activity: 0.35, scale: 6000 },
            { type: '散户', activity: 0.7, scale: 2500 },
            { type: '散户', activity: 0.6, scale: 1800 },
            { type: '散户', activity: 0.55, scale: 1500 },
            { type: '散户', activity: 0.5, scale: 1200 },
            { type: '散户', activity: 0.45, scale: 900 },
        ];
        this.intervalHandle = null;
        // 性能优化：股票池配置缓存（消除每 tick 的 find O(n)）
        this.poolBySymbol = new Map<string, any>();
    }
    async init() {
        for (const f of constants_1.FACTOR_NAMES) {
            this.factors[f] = -0.02 + Math.random() * 0.04;
        }
        // 迁移：旧库补 industry/code/listDate/description 列（SQLite ALTER，幂等）
        const migrateCols = [
            ['market', 'varchar DEFAULT "CN"'],
            ['industry', 'varchar DEFAULT "综合"'],
            ['code', 'varchar DEFAULT ""'],
            ['listDate', 'varchar DEFAULT ""'],
            ['description', 'text DEFAULT ""'],
        ];
        for (const [col, def] of migrateCols) {
            try {
                await this.stockRepo.query(`ALTER TABLE stocks ADD COLUMN ${col} ${def}`);
            }
            catch (e) {
                // 列已存在时忽略
            }
        }
        // B1 多市场：统一池（init 按本服务器市场过滤）
        const ALL_POOL = [...constants_1.STOCK_POOL, ...constants_1.HK_POOL, ...constants_1.US_POOL];
        const POOL_FOR_THIS = this.market === 'HK' ? constants_1.HK_POOL : this.market === 'US' ? constants_1.US_POOL : ALL_POOL.filter((c) => !(c as any).market || (c as any).market === 'CN');
        // 迁移：按股票池补齐已存在股票的行业与 lore 字段
        try {
            for (const cfg of POOL_FOR_THIS) {
                await this.stockRepo.query(`UPDATE stocks SET market='${(((cfg as any).market || 'CN'))}', industry='${cfg.industry}', code='${cfg.code}', listDate='${cfg.listDate}', description='${(cfg.description || '').replace(/'/g, "''")}' WHERE symbol='${cfg.symbol}'`);
            }
        }
        catch (e) {
            // 表尚未就绪时忽略
        }
        let dbStocks = await this.stockRepo.find(); // 全部（含 inactive，避免重复创建 UNIQUE）
        // 迁移：只停用不在任何市场池的遗留股票（三服务器共用全池判断，避免互相误停）
        const ALL_SYMBOLS = new Set([...constants_1.STOCK_POOL, ...constants_1.HK_POOL, ...constants_1.US_POOL, ...constants_1.IPO_POOL].map((c) => c.symbol));
        for (const s of dbStocks) {
            if (!ALL_SYMBOLS.has(s.symbol)) {
                if (s.isActive) {
                    s.isActive = false;
                    await this.stockRepo.save(s);
                }
            }
            else if (!s.isActive) {
                // 池内 inactive（历史误停遗留）→ 重新激活
                s.isActive = true;
                await this.stockRepo.save(s);
            }
        }
        const poolSymbols = new Set(POOL_FOR_THIS.map((c) => c.symbol));
        dbStocks = dbStocks.filter((s) => poolSymbols.has(s.symbol));
        // 增量补齐：按 symbol 缺失创建（兼容旧库升级）
        const existingSymbols = new Set(dbStocks.map((s) => s.symbol));
        for (const cfg of POOL_FOR_THIS) {
            if (existingSymbols.has(cfg.symbol)) continue;
            const stock = this.stockRepo.create({
                symbol: cfg.symbol,
                name: cfg.name,
                initialPrice: cfg.initialPrice,
                mu: cfg.mu,
                sigma: cfg.sigma,
                theta: cfg.theta,
            });
            // 直接赋值（避免 create 对实例属性的过滤问题）
            stock.market = (((cfg as any).market || 'CN'));
            stock.industry = cfg.industry;
            stock.code = cfg.code;
            stock.listDate = cfg.listDate;
            stock.description = cfg.description || '';
            await this.stockRepo.save(stock);
            dbStocks.push(stock);
        }
        for (const cfg of POOL_FOR_THIS) {
            this.poolBySymbol.set(cfg.symbol, cfg);
        }
        // 加载已上市的 IPO 股票（DB 已有 → 仅内存，防重复创建 UNIQUE；独立查询不依赖已过滤的 dbStocks）
        // FIX(IPO重复): 已上市 IPO 仅 A 股服务器加载，避免 HK/US 实例重复持有（前端出现多个相同股票 + K线3倍落库）
        if (this.market === 'CN') {
            const ipoDbRows = await this.stockRepo.find({ where: { isActive: true } });
            for (const cfg of constants_1.IPO_POOL) {
                if (this.stocks.has(cfg.symbol))
                    continue;
                const dbRow = ipoDbRows.find((x) => x.symbol === cfg.symbol);
                if (!dbRow || !dbRow.isActive)
                    continue;
                const ipoPrice = Number(dbRow.initialPrice) || Number(cfg.initialPrice);
                this.poolBySymbol.set(cfg.symbol, cfg);
                const ipoBaseVol = Math.max(8000, Math.floor(ipoPrice * 120));
                this.stocks.set(cfg.symbol, {
                    symbol: cfg.symbol, name: cfg.name, industry: cfg.industry,
                    code: cfg.code || '', listDate: cfg.listDate || '', description: cfg.description || '',
                    price: ipoPrice, intrinsic: ipoPrice, volatility: Number(cfg.sigma) * 0.5, lastReturn: 0,
                    prevClose: ipoPrice, lastVolume: ipoBaseVol, avgVolume: ipoBaseVol, baseVolume: ipoBaseVol, prevVolume: ipoBaseVol,
                    dayOpen: ipoPrice, dayHigh: ipoPrice, dayLow: ipoPrice, dayVolume: 0, minuteCounter: 0,
                    kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
                    trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
                });
                this.logger.log('📌 已加载已上市 IPO: ' + cfg.name);
            }
        }
        for (const s of dbStocks) {
            const price = Number(s.initialPrice);
            // 根据初始价格动态计算基准成交量（价格越高流动性越好）
            const baseVol = Math.max(8000, Math.floor(price * 120));
            this.stocks.set(s.symbol, {
                symbol: s.symbol,
                name: s.name,
                market: s.market || 'CN',
                industry: s.industry || '综合',
                code: s.code || '',
                listDate: s.listDate || '',
                description: s.description || '',
                price,
                prevTickPrice: price,
                volatility: Number(s.sigma) * 0.5,
                lastReturn: 0,
                prevClose: price,
                lastVolume: baseVol,
                avgVolume: baseVol,
                baseVolume: baseVol,
                prevVolume: baseVol,
                dayOpen: price,
                dayHigh: price,
                dayLow: price,
                dayVolume: 0,
                minuteCounter: 0,
                kline1min: [],
                kline5min: [],
                klineDaily: [],
                current1min: null,
                current5min: null,
                currentDaily: null,
                trendCounter: 0,
                trendDirection: 0,
                trendAccumulated: 0,
                isTrending: false,
            });
        }
        // S1 历史持久化：若 klines 表已有历史则恢复，否则生成 30 天初始历史并落库
        // SECURITY: 启动一次性去重（保留每个 symbol/timeframe/time 中 id 最大的一行），防止旧库重复行继续膨胀
        if (!klineDedupDone) {
            klineDedupDone = true;
            try {
                const dupCheck = await this.klineRepo.manager.query('SELECT COUNT(*) AS c FROM (SELECT 1 FROM klines GROUP BY symbol, timeframe, time HAVING COUNT(*) > 1)');
                const dupCount = Number(dupCheck && dupCheck[0] && dupCheck[0].c) || 0;
                if (dupCount > 0) {
                    this.logger.warn('检测到 ' + dupCount + ' 组重复 K 线，开始去重（保留每组 id 最大行）...');
                    await this.klineRepo.manager.query('DELETE FROM klines WHERE id NOT IN (SELECT MAX(id) FROM klines GROUP BY symbol, timeframe, time)');
                    this.logger.log('K 线历史去重完成');
                }
            } catch (e) {
                this.logger.warn('K 线去重跳过: ' + (e && e.message ? e.message : e));
            }
        }
        // 三服务器：仅加载本市场的 K 线（原实现全表加载×3，277MB 库会产生数 GB 级瞬时内存峰值）
        const ownSymbols = [...this.stocks.keys()];
        const allHistory = ownSymbols.length > 0
            ? await this.klineRepo.find({ where: { symbol: typeorm_2.In(ownSymbols) }, order: { time: 'ASC' } })
            : [];
        const historyRows = allHistory.filter((r) => this.stocks.has(r.symbol));
        if (historyRows.length > 0) {
            this.restoreFromHistory(historyRows);
            // S1 补齐：恢复的天数不足 30 天则补生成（内存，不落库）
            const missingDays = Math.max(0, 30 - this.gameDay);
            for (let d = 0; d < missingDays; d++) {
                for (let t = 0; t < constants_1.MARKET.TICKS_PER_DAY; t++) {
                    await this.generateTick();
                }
                await this.endOfDay(true);
            }
            this.logger.log(`[S1] 已恢复历史K线 ${historyRows.length} 条, 从第 ${this.gameDay} 个交易日继续（补齐 ${missingDays} 天）`);
        } else {
            for (let d = 0; d < 30; d++) {
                for (let t = 0; t < constants_1.MARKET.TICKS_PER_DAY; t++) {
                    await this.generateTick();
                }
                await this.endOfDay(true); // skipPersist：初始30天仅内存生成(快速)
            }
            // 注意：不重置 gameDay，历史 30 天用 0..29，实时从 30 开始，避免 K 线时间戳重叠
            this.logger.log(`市场数据已初始化(首次): ${dbStocks.length} 只股票, 30天历史已生成并落库`);
        }
        // 恢复/生成后：确保最新价格作为开盘基准
        for (const st of this.stocks.values()) {
            const last = st.klineDaily[st.klineDaily.length - 1];
            if (last && st.dayOpen === st.price) {
                st.price = last.close;
                st.prevClose = st.klineDaily.length > 1 ? st.klineDaily[st.klineDaily.length - 2].close : last.close;
                st.dayOpen = last.close;
                st.dayHigh = last.close;
                st.dayLow = last.close;
            }
        }
    }
    start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.intervalHandle = setInterval(() => {
            this.generateTick().catch(() => { });
        }, constants_1.MARKET.TICK_INTERVAL_MS);
        this.logger.log('行情生成已启动');
    }
    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        this.isRunning = false;
        this.logger.log('行情生成已停止');
    }
    randn() {
        let u = 0, v = 0;
        while (u === 0)
            u = Math.random();
        while (v === 0)
            v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    clamp(val, min, max) {
        return Math.max(min, Math.min(max, val));
    }
    // ─── 私有辅助函数：GARCH波动率更新 ───
    updateVolatility(stock) {
        const prevVar = stock.volatility * stock.volatility;
        const leverageCoeff = stock.lastReturn < 0 ? 2.5 : 1.0;
        let newVar = constants_1.OU_PARAMS.garchOmega +
            constants_1.OU_PARAMS.garchAlpha * stock.lastReturn * stock.lastReturn * leverageCoeff +
            constants_1.OU_PARAMS.garchBeta * prevVar;
        if (isNaN(newVar) || !isFinite(newVar))
            newVar = 0.0001;
        newVar = Math.max(1e-8, newVar);
        stock.volatility = this.clamp(Math.sqrt(newVar), 0.008, 0.8);
    }
    // ─── 私有辅助函数：跳跃扩散 ───
    calcJump(dt) {
        if (Math.random() < constants_1.OU_PARAMS.jumpIntensity * dt * 240 * 1.5) {
            return (Math.random() > 0.5 ? 1 : -1) * constants_1.OU_PARAMS.jumpStd * 1.5 * this.randn();
        }
        return 0;
    }
    // ─── 私有辅助函数：因子影响 ───
    calcFactorImpact(stock) {
        let impact = 0;
        // 行业兜底：DB 无值时用股票池静态配置
        const industry = stock.industry
            || this.poolBySymbol.get(stock.symbol)?.industry
            || '综合';
        const sens = constants_1.INDUSTRY_SENSITIVITY[industry] || {};
        for (const [name, val] of Object.entries(this.factors)) {
            let weight = 1.0;
            if (name === '市场情绪') weight = 1.3;
            const industryWeight = sens[name];
            if (industryWeight) weight = industryWeight;
            impact += (val as number) * weight;
        }
        // 玩法：热点题材板块动量加成（持续数日）
        const hot = this.hotTopics.find((h) => h.industry === industry);
        if (hot)
            impact += hot.strength * 0.9;
        return impact;
    }
    // ─── 私有辅助函数：订单流不平衡影响 ───
    calcOFIImpact(stock) {
        if (!this.engine) return 0;
        try {
            const book = this.engine.getOrderBook(stock.symbol);
            if (book.asks.length > 0 && book.bids.length > 0) {
                const total = book.bids[0].size + book.asks[0].size;
                if (total > 0) {
                    const ofi = (book.bids[0].size - book.asks[0].size) / total;
                    return ofi * 0.002;
                }
            }
        } catch (e) { }
        return 0;
    }
    // ─── 私有辅助函数：趋势检测 ───
    updateTrend(stock, priceChange) {
        const threshold = constants_1.OU_PARAMS.trendDetectionThreshold;
        let direction = 0;
        if (priceChange > threshold) direction = 1;
        else if (priceChange < -threshold) direction = -1;
        if (direction !== 0) {
            if (direction === stock.trendDirection) {
                stock.trendCounter++;
                stock.trendAccumulated += Math.abs(priceChange);
            } else {
                stock.trendDirection = direction;
                stock.trendCounter = 1;
                stock.trendAccumulated = Math.abs(priceChange);
            }
        } else {
            stock.trendDirection = 0; stock.trendCounter = 0; stock.trendAccumulated = 0;
        }
        stock.isTrending = stock.trendDirection !== 0 &&
            stock.trendCounter >= constants_1.OU_PARAMS.trendDetectionBars &&
            stock.trendAccumulated >= threshold * constants_1.OU_PARAMS.trendDetectionBars * 0.5;
    }
    // ─── 私有辅助函数：成交量 ───
    calcVolume(stock, regimes) {
        const baseVol = stock.baseVolume || 10000;
        const volFactor = 1 + stock.volatility * 5;
        const regimeMul = regimes === 'bull' ? 1.4 : regimes === 'bear' ? 1.2 : 0.9;
        let volume = baseVol * volFactor * regimeMul * Math.exp(this.randn() * 0.6);
        volume = this.clamp(volume, 500, 150000);
        return Math.floor(volume);
    }

    async generateTick() {
        if (this.stocks.size === 0)
            return [];
        const results = [];
        const regimes = this.marketRegime;
        const params = constants_1.STATE_PARAMS[regimes];
        const dt = 1 / constants_1.MARKET.TICKS_PER_DAY;
        const stocksArr: any[] = [...this.stocks.values()];
        // 行业联动：同行业股票共享一部分随机冲击（板块同涨同跌、板块间分化）
        const industryShocks = {};
        const cfgBySymbol = this.poolBySymbol;
        for (const stock of stocksArr) {
            if (industryShocks[stock.industry] === undefined) {
                industryShocks[stock.industry] = this.randn() * 0.004;
            }
        }
        for (const stock of stocksArr) {
            const cfg = cfgBySymbol.get(stock.symbol) || {};
            const mu = Number(cfg.mu ?? 100);
            this.updateVolatility(stock);
            const shock = stock.volatility * params.volMult * this.randn() * Math.sqrt(dt) * 1.5 + industryShocks[stock.industry];
            const jump = this.calcJump(dt);
            const factorImpact = this.calcFactorImpact(stock);
            const ofiImpact = this.calcOFIImpact(stock);
            const drift = params.driftBase;
            let meanReversion = 0;
            let momentumBoost = 0;
            if (!stock.isTrending) {
                meanReversion = Number(cfg.theta ?? 0.15) * (mu - stock.price) * dt;
            } else {
                momentumBoost = 0.2 * dt * 1.5;
                // 经济泡沫积累：行业泡沫度越高追涨越强（受控）
                const ib = this.industryBubbleMap[stock.industry] || 1;
                if (ib > 1.3) {
                    momentumBoost += Math.min(0.3, (ib - 1) * 0.12) * dt * 4;
                }
            }
            // 经济泡沫：破灭期向内在价值快速回归
            let burstDrift = 0;
            if (this.burstingIndustries.has(stock.industry)) {
                const intrinsic = Number(stock.intrinsic) || 1;
                const target = intrinsic * 1.05;
                if (stock.price > target) {
                    burstDrift = -0.008; // 每 tick 回归 0.8%（泡沫破灭暴跌）
                }
                else if (stock.price >= intrinsic * 0.9) {
                    this.burstingIndustries.delete(stock.industry); // 回归完成
                    this.logger.log('🧊 泡沫出清: ' + stock.industry + ' 回归内在价值');
                }
            }
            let priceChange = drift + shock + jump + factorImpact * dt * 5 + ofiImpact + meanReversion + momentumBoost + burstDrift;
            // 收紧单 tick 波动 ±2%：保证相邻 K 线价格区间贴近（消除图表割裂）
            priceChange = this.clamp(priceChange, -0.02, 0.02);
            let newPrice = stock.price * (1 + priceChange);
            if (isNaN(newPrice) || !isFinite(newPrice))
                newPrice = stock.price;
            newPrice = Math.max(0.5, newPrice);
            stock.price = newPrice;
            this.updateTrend(stock, priceChange);
            // B1 波动检测：记录本 tick 前价（用于事件驱动传导判断）
            // 价格安全网：单 tick 涨跌 ±10%（prevTickPrice 为本 tick 前价）
            if (stock.prevTickPrice && stock.prevTickPrice > 0) {
                const maxUp = stock.prevTickPrice * 1.1;
                const maxDn = stock.prevTickPrice * 0.9;
                if (stock.price > maxUp)
                    stock.price = maxUp;
                if (stock.price < maxDn)
                    stock.price = maxDn;
            }
            stock.prevTickPrice = stock.price;
            stock.lastReturn = priceChange;
            // prevClose 保持"昨收"不变（涨跌幅基准），仅由 endOfDay 更新
            stock.lastVolume = this.calcVolume(stock, regimes);
            stock.avgVolume = stock.avgVolume * 0.92 + stock.lastVolume * 0.08;
            stock.dayHigh = Math.max(stock.dayHigh, stock.price);
            stock.dayLow = Math.min(stock.dayLow, stock.price);
            stock.dayVolume += stock.lastVolume;
            stock.minuteCounter++;
            this.updateKlines(stock);
            results.push({
                symbol: stock.symbol,
                price: stock.price,
                volume: stock.lastVolume,
                timestamp: this.tickCount,
            });
        }
        // 宏观反馈回路：个股表现 → 宏观因子（股票成为影响金融体系的真实嵌入体）
        this.updateMacroFeedback();
        // B1 复合反应 LoD：平稳期每 5 分钟传导，剧烈波动（黑天鹅等）立即传导
        if (this.tickCount % 5 === 0 || this.hasVolatileMove()) {
            this.updateIndustryLinks();
        }
        // AI 对手盘：机构/游资/散户交易行为（多空博弈，P2 订单流化）
        await this.applyAiTrading();
        this.updateIndexFeedback();
        this.tickCount++;
        return results;
    }
    // ─── 经济泡沫：行业泡沫度 = 行业均价 / 行业内在价值 ───
    computeIndustryBubble() {
        const sumPrice = {};
        const sumIntr = {};
        const cnt = {};
        for (const st of this.stocks.values()) {
            const ind = st.industry || '其他';
            sumPrice[ind] = (sumPrice[ind] || 0) + Number(st.price);
            sumIntr[ind] = (sumIntr[ind] || 0) + (Number(st.intrinsic) || Number(st.price));
            cnt[ind] = (cnt[ind] || 0) + 1;
        }
        this.industryBubbleMap = {};
        for (const k of Object.keys(cnt)) {
            const intr = sumIntr[k] / cnt[k];
            this.industryBubbleMap[k] = intr > 0 ? (sumPrice[k] / cnt[k]) / intr : 1;
        }
    }
    // 每日泡沫破灭判定：泡沫度>2 的行业 5% 概率破灭
    maybeBurstBubble() {
        this.computeIndustryBubble();
        for (const [ind, ratioRaw] of Object.entries(this.industryBubbleMap)) {
            const ratio = ratioRaw as number;
            if (ratio > 2 && !this.burstingIndustries.has(ind) && Math.random() < 0.05) {
                this.triggerBurst(ind, '市场恐慌情绪蔓延');
            }
            else if (ratio > 1.5 && Math.random() < 0.01) {
                this.triggerBurst(ind, '获利盘集体出逃');
            }
        }
    }
    // 细小抛售触发（用户/AI 卖出时若泡沫度高则戳破）
    checkSellTrigger(industry) {
        const ratio = this.industryBubbleMap ? this.industryBubbleMap[industry] : 1;
        if (ratio > 2 && !this.burstingIndustries.has(industry) && Math.random() < 0.3) {
            this.triggerBurst(industry, '细小抛售引发连锁恐慌');
            return true;
        }
        return false;
    }
    triggerBurst(industry, reason) {
        if (this.burstingIndustries.has(industry))
            return;
        this.burstingIndustries.add(industry);
        this.burstEvents.push({ industry, reason });
        this.factors['市场情绪'] = Math.max(-0.15, (this.factors['市场情绪'] ?? 0) - 0.04);
        this.logger.warn('💥 泡沫破灭: ' + industry + '（' + reason + '）');
    }
    getBurstEvents() {
        const ev = this.burstEvents;
        this.burstEvents = [];
        return ev;
    }
    // ─── B1 波动检测：单 tick 任一股票涨跌 > 1.5%（黑天鹅/跳空/大单）→ 立即触发行业传导 ───
    hasVolatileMove() {
        for (const st of this.stocks.values()) {
            const prev = st.prevTickPrice || st.price;
            if (prev > 0 && Math.abs(st.price - prev) / prev > 0.015)
                return true;
        }
        return false;
    }
    // ─── B1 用户成交计入行情：价格冲击 + 成交量并入当前 tick K 线 ───
    applyUserFill(fill) {
        const stock = this.stocks.get(fill.symbol);
        if (!stock)
            return;
        // 价格冲击：成交额 / (日均成交额×2)，买推高卖压低，上限 1%（防大单操纵过度）
        const turnover = Number(fill.filledQuantity) * Number(fill.avgPrice);
        const avgTurnover = (stock.avgVolume || 8000) * (Number(stock.price) || 1);
        const impact = Math.min(0.01, (turnover / Math.max(1, avgTurnover * 2)) * 0.5);
        // 方向大小写兼容：引擎成交 side 为小写（buy/sell/short/cover），AI/其他路径可能传大写
        const sideUp = String(fill.side || '').toUpperCase();
        const dir = (sideUp === 'BUY' || sideUp === 'COVER') ? 1 : -1;
        // 经济泡沫：细小抛售戳破泡沫
        if (dir < 0 && stock.industry) {
            this.checkSellTrigger(stock.industry);
        }
        stock.price = Math.max(0.5, stock.price * (1 + dir * impact));
        // 成交量并入当前 K 线（本 tick 的购买售出纳入图表与总额计算）
        const qty = Number(fill.filledQuantity) || 0;
        stock.lastVolume += qty;
        stock.dayVolume += qty;
        const k1 = stock.current1min;
        if (k1) {
            k1.volume += qty;
            k1.high = Math.max(k1.high, stock.price);
            k1.low = Math.min(k1.low, stock.price);
            k1.close = stock.price;
        }
        const k5 = stock.current5min;
        if (k5) {
            k5.volume += qty;
            k5.high = Math.max(k5.high, stock.price);
            k5.low = Math.min(k5.low, stock.price);
            k5.close = stock.price;
        }
    }
    // ─── B1 行业复合传导：行业动量按关联矩阵传导给相关行业（半导体涨 → 消费电子/软件跟涨） ───
    updateIndustryLinks() {
        const links = constants_1.INDUSTRY_LINKS;
        if (!links)
            return;
        // 各行业当日动量（平均涨跌幅）
        const mom = {};
        const counts = {};
        for (const st of this.stocks.values()) {
            const base = Number(st.dayOpen) || 1;
            const ret = (st.price - base) / base;
            mom[st.industry] = (mom[st.industry] || 0) + ret;
            counts[st.industry] = (counts[st.industry] || 0) + 1;
        }
        for (const k of Object.keys(mom)) {
            mom[k] /= counts[k] || 1;
        }
        // 按矩阵传导：目标行业 += 来源动量 × 关联度 × 0.15（衰减系数，防自激）
        for (const [src, map] of Object.entries(links)) {
            const srcMom = mom[src];
            if (srcMom == null)
                continue;
            for (const [dst, w] of Object.entries(map)) {
                if (mom[dst] == null || dst === src)
                    continue;
                // 单次传导上限 ±0.5%（防行业间正反馈滚雪球）
                const boost = Math.max(-0.005, Math.min(0.005, srcMom * w * 0.15));
                for (const st of this.stocks.values()) {
                    if (st.industry === dst) {
                        st.price = Math.max(0.5, st.price * (1 + boost));
                        st.lastReturn = (st.price - (Number(st.dayOpen) || 1)) / (Number(st.dayOpen) || 1);
                    }
                }
            }
        }
    }
    // ─── AI 对手盘（P2 订单流化）：机构/游资/散户向真实盘口挂限价单/发市价单 ───
    // 市价单吃掉真实挂单（AI 虚拟挂单 + 用户挂单），用户挂单触发真实结算；价格冲击与成交量走 applyUserFill
    async applyAiTrading() {
        const arr = [...this.stocks.values()];
        if (arr.length === 0)
            return;
        // 先清理过期的 AI 虚拟挂单（TTL 到期自动撤单）
        if (this.engine) {
            try {
                this.engine.pruneExpiredVirtualOrders(this.tickCount);
            }
            catch (e) { }
        }
        for (const agent of this.aiAgents) {
            if (Math.random() > agent.activity)
                continue;
            // 选股：游资追热点行业，机构/散户随机
            let target;
            if (agent.type === '游资' && this.hotTopics.length > 0) {
                const hotIndustry = this.hotTopics[0].industry;
                target = arr.find((st) => st.industry === hotIndustry && Math.random() < 0.4) || arr[Math.floor(Math.random() * arr.length)];
            }
            else {
                target = arr[Math.floor(Math.random() * arr.length)];
            }
            // 方向：机构/散户追涨杀跌；游资低吸高抛（反转）
            const base = Number(target.dayOpen) || 1;
            const ret = (target.price - base) / base;
            let dir;
            if (agent.type === '游资') {
                dir = ret > 0.015 ? -1 : ret < -0.015 ? 1 : (Math.random() < 0.5 ? 1 : -1);
            }
            else {
                // 防自激：已大涨(>3%)不再追买、大跌(<-3%)不再追卖
                dir = ret > 0.03 ? 0 : ret < -0.03 ? 0 : (ret >= 0 ? 1 : -1);
            }
            if (dir === 0)
                continue;
            const side = dir > 0 ? 'buy' : 'sell';
            // 量级：按 agent scale × 随机
            const qty = Math.round(agent.scale * (0.5 + Math.random()));
            if (!this.engine)
                continue;
            const isCN = target.market !== 'HK' && target.market !== 'US';
            const limitUp = isCN && base > 0 ? base * 1.10 : null;
            const limitDown = isCN && base > 0 ? base * 0.90 : null;
            if (Math.random() < 0.67) {
                // 限价挂单进入盘口排队：机构贴价大单、游资中等、散户偏远小单；TTL 8~30 tick
                const offsetPct = agent.type === '机构' ? 0.0005 + Math.random() * 0.001
                    : agent.type === '游资' ? 0.001 + Math.random() * 0.0015
                        : 0.0015 + Math.random() * 0.002;
                let price = Number(target.price) * (1 + dir * offsetPct);
                if (isCN && limitUp !== null && limitDown !== null) {
                    price = Math.min(Math.max(price, limitDown), limitUp);
                }
                const ttlTicks = 8 + Math.floor(Math.random() * 22);
                try {
                    this.engine.placeVirtualOrder(target.symbol, side, Number(price.toFixed(2)), qty, this.tickCount + ttlTicks);
                }
                catch (e) { }
            }
            else {
                // 市价单吃真实盘口：AI 虚拟挂单 + 用户挂单；用户挂单被吃掉走真实结算
                try {
                    const fill = this.engine.executeVirtualMarketOrder(target.symbol, side, qty);
                    if (!fill)
                        continue;
                    const realFills = (fill.counterFills || []).filter((f) => f.orderId);
                    if (realFills.length > 0) {
                        await this.engine.settleCounterFills(target.symbol, this.market, realFills);
                    }
                    // 价格冲击 + 成交量并入 K 线（与用户成交同一路径，AI 抛售可戳破泡沫）
                    this.applyUserFill({ symbol: target.symbol, side, filledQuantity: fill.filledQuantity, avgPrice: fill.avgPrice });
                }
                catch (e) {
                    this.logger.warn('AI 市价单执行失败: ' + (e && e.message ? e.message : e));
                }
            }
        }
    }
    // ─── B1 指数影响全局：跨市场指数平均变化 → 市场情绪因子（指数涨 → 情绪升 → 全市场偏多） ───
    updateIndexFeedback() {
        const idx = this.getIndices();
        if (!idx || idx.length === 0)
            return;
        let sum = 0;
        for (const i of idx) {
            sum += Number(i.changePct) || 0;
        }
        const avg = sum / idx.length; // 平均指数涨跌幅（%）
        // 削弱系数：% 转小数 + 极弱反馈（一天最多 ~0.003，防正反馈自激爆炸）
        this.factors['市场情绪'] = this.clamp((this.factors['市场情绪'] ?? 0) + avg * 0.00002, -0.1, 0.1);
    }
    // ─── 宏观反馈：股票表现反向影响宏观因子（双向联动，缓慢平滑防自激震荡） ───
    updateMacroFeedback() {
        const arr = [...this.stocks.values()];
        if (arr.length === 0)
            return;
        const upRatio = arr.filter((s) => (s.lastReturn ?? 0) > 0).length / arr.length;
        const senti = (upRatio - 0.5) * 0.12;
        const macroStocks = arr.filter((s) => ['银行', '券商', '保险', '有色金属', '煤炭', '房地产', '物流'].includes(s.industry));
        const macroRet = macroStocks.length
            ? macroStocks.reduce((a, s) => a + (s.lastReturn ?? 0), 0) / macroStocks.length
            : 0;
        const indRet = arr.reduce((a, s) => a + (s.lastReturn ?? 0), 0) / arr.length;
        // 平滑更新（当前值 96% + 反馈 4%），并限制在合理区间
        const setFactor = (name, target) => {
            const cur = this.factors[name] ?? 0;
            this.factors[name] = this.clamp(cur * 0.96 + target * 0.04, -0.5, 0.5);
        };
        setFactor('市场情绪', senti * 2);
        setFactor('宏观经济', macroRet * 8);
        setFactor('行业景气', indRet * 8);
    }
    // ─── 指数体系：按成分股实时计算（基准点位 × 成分平均涨跌） ───
    getIndices() {
        // 三服务器：仅显示本市场指数
        const defs = [
            { code: '000001', name: '上证指数', base: 3100, market: 'CN', filter: () => true },
            { code: '399001', name: '深证成指', base: 10500, market: 'CN', filter: (s) => /^(000|002|300)/.test(s.code || '') },
            { code: '399006', name: '创业板指', base: 2200, market: 'CN', filter: (s) => /^300/.test(s.code || '') },
            { code: '000688', name: '科创50', base: 950, market: 'CN', filter: (s) => /^688/.test(s.code || '') },
            { code: '399999', name: '中证文娱', base: 1200, market: 'CN', filter: (s) => /^(G|V)/.test(s.symbol) },
            // B1 多市场指数
            { code: 'HSI', name: '恒生指数', market: 'HK', base: 18500, filter: (s) => s.market === 'HK' },
            { code: 'NDX', name: '纳斯达克', market: 'US', base: 16500, filter: (s) => s.market === 'US' && /^(U[1-4])/.test(s.symbol) },
            { code: 'DJI', name: '道琼斯', market: 'US', base: 38500, filter: (s) => s.market === 'US' && /^(U[5-8])/.test(s.symbol) },
        ];
        return defs.filter((d) => d.market === this.market || (d.market === 'CN' && this.market === 'CN')).map((d) => {
            const members = [...this.stocks.values()].filter((st) => d.filter(st));
            let total = 0;
            for (const st of members) {
                const prev = Number(st.prevClose) || Number(st.dayOpen) || 1;
                total += (st.price - prev) / prev;
            }
            const change = members.length ? (total / members.length) * 100 : 0;
            return {
                code: d.code,
                name: d.name,
                value: Number((d.base * (1 + change / 100)).toFixed(2)),
                changePct: Number(change.toFixed(2)),
                members: members.length,
            };
        });
    }
    // S2 交易时段时间映射：0-119 → 9:30-11:30；120-239 → 13:00-15:00（真实A股时段）
    tradingTime(day, minute) {
        if (minute < 120) return new Date(2024, 0, 1 + day, 9, 30 + minute, 0);
        return new Date(2024, 0, 1 + day, 13, minute - 120, 0);
    }
    updateKlines(stock) {
        // 每 tick 即 1 分钟（TICKS_PER_DAY=240=A股真实交易分钟数），minuteCounter 每天 0 起
        const minute = stock.minuteCounter;
        const price = stock.price;
        const volume = stock.lastVolume;
        // 1min：用起始分钟索引判断（原实现用 getMinutes() 每小时回绕，产生重复时间戳）
        if (!stock.current1min || stock.current1min.startMinute !== minute) {
            if (stock.current1min) {
                stock.kline1min.push(stock.current1min);
                if (stock.kline1min.length > 50000)
                    stock.kline1min.shift();
            }
            // 价格连续性：新 bar 的 open = 上一条 close（相邻 bar 区间自然交叠，消除图表割裂）
            const prevClose1 = stock.kline1min.length > 0 ? Number(stock.kline1min[stock.kline1min.length - 1].close) : price;
            stock.current1min = {
                startMinute: minute,
                time: this.tradingTime(this.gameDay, minute),
                open: prevClose1, high: Math.max(prevClose1, price), low: Math.min(prevClose1, price), close: price, volume: 0,
            };
        }
        const k1 = stock.current1min;
        k1.high = Math.max(k1.high, price);
        k1.low = Math.min(k1.low, price);
        k1.close = price;
        k1.volume += volume;
        const fiveIdx = Math.floor(minute / 5);
        // 5min：用起始五分钟索引判断（原实现用 getMinutes() 回绕，每个周期错误新建 bar）
        if (!stock.current5min || stock.current5min.startFiveIdx !== fiveIdx) {
            if (stock.current5min) {
                stock.kline5min.push(stock.current5min);
                if (stock.kline5min.length > 20000)
                    stock.kline5min.shift();
            }
            const prevClose5 = stock.kline5min.length > 0 ? Number(stock.kline5min[stock.kline5min.length - 1].close) : price;
            stock.current5min = {
                startFiveIdx: fiveIdx,
                time: this.tradingTime(this.gameDay, fiveIdx * 5),
                open: prevClose5, high: Math.max(prevClose5, price), low: Math.min(prevClose5, price), close: price, volume: 0,
            };
        }
        const k5 = stock.current5min;
        k5.high = Math.max(k5.high, price);
        k5.low = Math.min(k5.low, price);
        k5.close = price;
        k5.volume += volume;
        if (!stock.currentDaily) {
            stock.currentDaily = {
                time: new Date(2024, 0, 1 + this.gameDay),
                open: stock.dayOpen, high: stock.dayHigh, low: stock.dayLow, close: price, volume: stock.dayVolume,
            };
        }
        else {
            stock.currentDaily.high = stock.dayHigh;
            stock.currentDaily.low = stock.dayLow;
            stock.currentDaily.close = price;
            stock.currentDaily.volume = stock.dayVolume;
        }
    }
    // S1 从 klines 表恢复历史（1min/5min/daily + gameDay + 价格）
    restoreFromHistory(rows) {
        const BASE = new Date(2024, 0, 1).getTime();
        const DAY_MS = 86400000;
        const byStock = {};
        for (const r of rows) {
            if (!byStock[r.symbol])
                byStock[r.symbol] = { '1min': [], '5min': [], daily: [] };
            const bar = {
                time: new Date(r.time),
                open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
            };
            if (r.timeframe === '1min') byStock[r.symbol]['1min'].push(bar);
            else if (r.timeframe === '5min') byStock[r.symbol]['5min'].push(bar);
            else byStock[r.symbol].daily.push(bar);
        }
        const dedupe = (arr) => {
            const seen = new Set();
            return arr.filter((b) => {
                const k = new Date(b.time).getTime();
                if (seen.has(k))
                    return false;
                seen.add(k);
                return true;
            });
        };
        let maxDay = -1;
        for (const st of this.stocks.values()) {
            const h = byStock[st.symbol] || { '1min': [], '5min': [], daily: [] };
            st.kline1min = dedupe(h['1min']);
            st.kline5min = dedupe(h['5min']);
            st.klineDaily = dedupe(h.daily);
            for (const d of st.klineDaily) {
                const day = Math.floor((new Date(d.time).getTime() - BASE) / DAY_MS);
                if (day > maxDay)
                    maxDay = day;
            }
        }
        this.gameDay = maxDay + 1;
    }
    async endOfDay(skipPersist = false) {
        // 内在价值每日微增（基本面缓慢向好，泡沫度相对下降）
        for (const st of this.stocks.values()) {
            st.intrinsic = (Number(st.intrinsic) || Number(st.price)) * 1.001;
        }
        const batchKlines = [];
        for (const stock of this.stocks.values()) {
            // S1 持久化：1min / 5min / daily 全部落库（重启可恢复历史）
            const persistBar = (timeframe, bar) => {
                try {
                    batchKlines.push(this.klineRepo.create({
                        symbol: stock.symbol,
                        timeframe,
                        time: bar.time,
                        open: bar.open,
                        high: bar.high,
                        low: bar.low,
                        close: bar.close,
                        volume: bar.volume,
                    }));
                } catch (e) { }
            };
            if (stock.current1min) {
                stock.kline1min.push(stock.current1min);
                // FIX(K线重复): 不再单独落库，统一由下方「当天完整落库」写入，避免最后一根 1min 被重复落库
                stock.current1min = null;
            }
            if (stock.current5min) {
                stock.kline5min.push(stock.current5min);
                stock.current5min = null;
            }
            if (stock.currentDaily) {
                stock.klineDaily.push(stock.currentDaily);
                if (!skipPersist)
                    persistBar('daily', stock.currentDaily);
                stock.currentDaily = null;
            }
            if (Math.random() < constants_1.BLACK_SWAN.probability) {
                const [minGap, maxGap] = constants_1.BLACK_SWAN.gapRange;
                const gap = minGap + Math.random() * (maxGap - minGap);
                stock.price = Math.max(0.5, stock.price * (1 + gap));
                stock.dayOpen = stock.price;
                this.logger.warn(`[黑天鹅] ${stock.symbol} 隔夜跳空 ${(gap * 100).toFixed(2)}%`);
            }
            else {
                stock.dayOpen = stock.price;
            }
            stock.dayHigh = stock.price;
            stock.dayLow = stock.price;
            stock.dayVolume = 0;
            stock.minuteCounter = 0;
            stock.prevClose = stock.price;
            stock.isTrending = false;
            stock.trendCounter = 0;
            stock.trendDirection = 0;
            stock.trendAccumulated = 0;
        }
        // S1 补：当天完整 1min/5min 落库（current 只是最后一根，完整历史必须全量）
        if (!skipPersist) {
        const dayStart = new Date(2024, 0, 1 + this.gameDay).getTime();
        for (const stock of this.stocks.values()) {
            for (const bar of stock.kline1min) {
                if (new Date(bar.time).getTime() >= dayStart) {
                    try {
                        batchKlines.push(this.klineRepo.create({
                            symbol: stock.symbol, timeframe: '1min',
                            time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
                        }));
                    } catch (e) { }
                }
            }
            for (const bar of stock.kline5min) {
                if (new Date(bar.time).getTime() >= dayStart) {
                    try {
                        batchKlines.push(this.klineRepo.create({
                            symbol: stock.symbol, timeframe: '5min',
                            time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
                        }));
                    } catch (e) { }
                }
            }
        }
        }
        // 批量写入（daily + 当天完整 1min/5min）
        if (batchKlines.length > 0) {
            try {
                await this.klineRepo.save(batchKlines);
            } catch (e) {
                this.logger.error('K线落库失败（第1次）: ' + (e && e.message ? e.message : e));
                try {
                    await this.klineRepo.save(batchKlines);
                } catch (e2) {
                    this.logger.error('K线落库失败（重试仍失败，今日K线可能丢失）: ' + (e2 && e2.message ? e2.message : e2));
                }
            }
        }
        this.updateMarketRegime();
        this.decayFactors();
        this.gameDay++;
    }
    updateMarketRegime() {
        const probs = constants_1.STATE_TRANSITIONS[this.marketRegime];
        const rand = Math.random();
        let cumulative = 0;
        for (const state of ['bull', 'bear', 'sideways']) {
            cumulative += probs[state];
            if (rand < cumulative) {
                this.marketRegime = state;
                break;
            }
        }
    }
    decayFactors() {
        for (const f of constants_1.FACTOR_NAMES) {
            this.factors[f] *= 0.95;
            this.factors[f] += (Math.random() - 0.5) * 0.008;
            this.factors[f] = this.clamp(this.factors[f], -0.2, 0.2);
        }
    }
    getPrices() {
        const prices = {};
        for (const [sym, state] of this.stocks) {
            prices[sym] = state.price;
        }
        return prices;
    }
    // P1: 昨收价映射（开盘集合竞价的参考基准）
    getPrevCloses() {
        const out = {};
        for (const [sym, state] of this.stocks) {
            out[sym] = Number(state.prevClose) || Number(state.dayOpen) || Number(state.price) || 1;
        }
        return out;
    }
    // P1: 开盘集合竞价结果写回 dayOpen（今开 = 竞价开盘价）
    setAuctionDayOpens(auctionPrices) {
        for (const [sym, price] of Object.entries(auctionPrices)) {
            const st = this.stocks.get(sym);
            if (st && Number.isFinite(Number(price)) && Number(price) > 0) {
                st.dayOpen = Number(price);
            }
        }
    }
    // SECURITY: 全市场冲击写回引擎内部价格（原夜间事件只改 getPrices 返回副本，下一 tick 被覆盖失效）
    applyMarketwideShock(pct) {
        const factor = 1 + Number(pct);
        for (const st of this.stocks.values()) {
            st.price = Math.max(0.5, Number(st.price) * factor);
            st.dayOpen = Math.max(0.5, Number(st.dayOpen) * factor);
            st.prevClose = Math.max(0.5, Number(st.prevClose) * factor);
        }
        this.logger.log('🌙 隔夜事件冲击全市场 ' + (Number(pct) * 100).toFixed(2) + '%（已写回内部价格）');
    }
    // 股票列表：名称/行业/现价/涨跌幅/今开/高低/成交量（用于前端行情列表）
    getStockList() {
        this.computeIndustryBubble();
        const list = [];
        for (const state of this.stocks.values()) {
            const prevClose = Number(state.prevClose) || Number(state.dayOpen) || 1;
            const adj = this.adjFactors.get(state.symbol) || { factor: 1, series: [] };
            list.push({
                symbol: state.symbol,
                market: state.market || 'CN',
                adjFactor: Number(adj.factor),
                adjustmentSeries: adj.series.map((s) => ({ day: s.day, factor: s.factor })),
                name: state.name || state.symbol,
                code: state.code || '',
                listDate: state.listDate || '',
                description: state.description || '',
                industry: state.industry
                    || this.poolBySymbol.get(state.symbol)?.industry
                    || '综合',
                price: Number(state.price.toFixed(2)),
                changePct: Number((((state.price - prevClose) / prevClose) * 100).toFixed(2)),
                dayOpen: Number(state.dayOpen.toFixed(2)),
                dayHigh: Number(state.dayHigh.toFixed(2)),
                dayLow: Number(state.dayLow.toFixed(2)),
                dayVolume: state.dayVolume,
            });
        }
        return list;
    }
    getKlines(symbol, timeframe) {
        const stock = this.stocks.get(symbol);
        if (!stock)
            return [];
        const agg = (bars, group) => {
            const out = [];
            let cur = null;
            for (const b of bars) {
                const g = group(b.time);
                if (!cur || cur.g !== g) {
                    if (cur)
                        out.push(cur.bar);
                    cur = { g, bar: { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume } };
                }
                else {
                    cur.bar.high = Math.max(cur.bar.high, b.high);
                    cur.bar.low = Math.min(cur.bar.low, b.low);
                    cur.bar.close = b.close;
                    cur.bar.volume += b.volume;
                }
            }
            if (cur)
                out.push(cur.bar);
            return out;
        };
        let klines;
        let current;
        switch (timeframe) {
            case '1min':
                klines = [...stock.kline1min];
                current = stock.current1min;
                break;
            case '5min':
                klines = [...stock.kline5min];
                current = stock.current5min;
                break;
            case '60min':
                // 60 分钟：按小时聚合（09:30 起始，跨午休按自然小时）
                {
                    const src = [...stock.kline1min];
                    if (stock.current1min)
                        src.push(stock.current1min);
                    const hourKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours(); };
                    return agg(src, hourKey);
                }
            case 'daily':
                klines = [...stock.klineDaily];
                current = stock.currentDaily;
                break;
            case 'weekly':
                // 周线：按 ISO 周聚合 daily
                {
                    const src = [...stock.klineDaily];
                    if (stock.currentDaily)
                        src.push(stock.currentDaily);
                    const weekKey = (t) => { const d = new Date(t); const day = (d.getDay() + 6) % 7; const base = new Date(d); base.setDate(d.getDate() - day); return base.getFullYear() + '-' + (base.getMonth() + 1) + '-' + base.getDate(); };
                    return agg(src, weekKey);
                }
            case 'monthly':
                {
                    const src = [...stock.klineDaily];
                    if (stock.currentDaily)
                        src.push(stock.currentDaily);
                    const monthKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1); };
                    return agg(src, monthKey);
                }
        }
        if (current)
            klines.push(current);
        return klines;
    }
    getState() {
        return {
            gameDay: this.gameDay,
            tickCount: this.tickCount,
            marketRegime: this.marketRegime,
            factors: { ...this.factors },
            hotTopics: [...this.hotTopics],
            // P1: 本市场实时开市状态（含节假日历判断），供前端休市遮罩/下单禁用使用
            isTradingTime: constants_1.isTradingTimeFor(this.market),
        };
    }
    applyFactorImpulse(factor, impact) {
        if (this.factors[factor] !== undefined) {
            this.factors[factor] += impact;
            this.factors[factor] = this.clamp(this.factors[factor], -0.2, 0.2);
        }
    }
    // ─── 财报真实化：每 20 个交易日一个财报季，随机 30% 股票披露 ───
    generateReports() {
        const arr = [...this.stocks.values()];
        const due = arr.filter(() => Math.random() < 0.3);
        for (const st of due) {
            // 动量决定预期差：近期涨多的公司易超预期，跌多的易不及预期
            const momentum = (st.lastReturn ?? 0) * 60 + (Math.random() - 0.5) * 0.1;
            const surprise = momentum > 0.015 ? 1 : momentum < -0.015 ? -1 : 0;
            const revBase = 5 + Math.random() * 15;
            const revenue = revBase * 1e8;
            const revGrowth = surprise === 1 ? 8 + Math.random() * 22 : surprise === -1 ? -15 + Math.random() * 20 : -3 + Math.random() * 12;
            const netMargin = 0.04 + Math.random() * 0.12;
            const report = {
                day: this.gameDay,
                symbol: st.symbol,
                company: st.name,
                code: st.code,
                revenue: Number((revenue / 1e8).toFixed(1)),
                revenueYoy: Number(revGrowth.toFixed(1)),
                netProfit: Number((revenue * netMargin / 1e8).toFixed(2)),
                netMargin: Number((netMargin * 100).toFixed(1)),
                surprise,
                quarter: 'Q' + (1 + Math.floor(Math.random() * 4)),
                dividend: 0,
            };
            // 财报冲击股价：超预期 +2.5%，不及预期 -2.5%，符合 ±0.5%
            const shock = surprise === 1 ? 0.025 : surprise === -1 ? -0.025 : (Math.random() > 0.5 ? 1 : -1) * 0.005;
            st.price = Math.max(0.5, st.price * (1 + shock));
            // 玩法：分红（30% 概率，每股 0.3~1.5 元，当日除权，持仓者日终现金到账）
            if (Math.random() < 0.3) {
                const perShare = Number((0.3 + Math.random() * 1.2).toFixed(2));
                this.recordDividend(st.symbol, perShare, this.gameDay);
                report.dividend = perShare;
            }
            st.lastReturn = shock;
            const list = this.reports.get(st.symbol) || [];
            list.push(report);
            this.reports.set(st.symbol, list);
        }
        return due.length;
    }
    getReports(symbol) {
        return symbol ? (this.reports.get(symbol) || []) : [...this.reports.values()].flat();
    }
    // ─── 玩法：每天开盘刷新（热点/IPO/黑天鹅），由 market.service 在 tickCounter===0 调用 ───
    async startNewDay() {
        this.maybeBurstBubble();
        this.refreshHotTopics();
        const ipo = await this.maybeListIPO();
        const swan = this.maybeBlackSwan();
        this.dayEvents = { ipo, swan };
    }
    getDayEvents() {
        const e = this.dayEvents;
        this.dayEvents = null;
        return e;
    }
    // 热点题材：60% 概率生成 1-2 个热点板块（持续 1-3 天）
    refreshHotTopics() {
        const today = this.gameDay;
        // 移除到期热点
        this.hotTopics = this.hotTopics.filter((h) => h.day + h.duration > today);
        // 生成新热点
        if (this.hotTopics.length < 2 && Math.random() < 0.6) {
            const industries = [...new Set([...this.stocks.values()].map((x) => x.industry).filter(Boolean))];
            if (industries.length > 0) {
                const count = Math.random() < 0.4 ? 2 : 1;
                for (let i = 0; i < count; i++) {
                    const industry = industries[Math.floor(Math.random() * industries.length)];
                    if (!this.hotTopics.some((h) => h.industry === industry)) {
                        this.hotTopics.push({
                            industry,
                            strength: 0.3 + Math.random() * 0.3,
                            day: today,
                            duration: 1 + Math.floor(Math.random() * 3),
                        });
                    }
                }
            }
        }
    }
    // IPO：每 30 天上市 1-2 只新股（首日高波动）
    async maybeListIPO() {
        // 重启后清理已上市的（防止重复上市 UNIQUE 冲突）
        this.ipoQueue = this.ipoQueue.filter((cfg) => cfg && !this.stocks.has(cfg.symbol));
        if (this.ipoQueue.length === 0 || this.gameDay < this.nextIpoDay)
            return null;
        const count = Math.min(2, this.ipoQueue.length);
        const listed = [];
        for (let i = 0; i < count; i++) {
            const cfg = this.ipoQueue.shift();
            if (!cfg)
                break;
            const price = Number(cfg.initialPrice);
            // SECURITY: 落库失败不能产生 unhandledRejection 崩进程，改为记录并继续
            try {
                await this.createStockInMemory(cfg, price);
            } catch (e) {
                this.logger.error('IPO 落库失败: ' + cfg.symbol + ' ' + (e && e.message ? e.message : e));
                continue;
            }
            // 首日高波动
            const st = this.stocks.get(cfg.symbol);
            if (st)
                st.volatility = Number(cfg.sigma) * 1.6;
            listed.push(cfg);
            this.logger.log('🚀 新股上市: ' + cfg.name + ' (' + cfg.code + ') 发行价 ' + price + ' 元');
        }
        this.nextIpoDay = this.gameDay + 10; // S2 节奏适配：真实日同步后缩短（30游戏日≈6周太慢）
        return { listed };
    }
    // 黑天鹅：3% 概率，市场级/板块级/个股级冲击
    // C1 事件：40% 利好（政策红包/行业利好/个股重大利好），60% 利空（黑天鹅）
    maybeBlackSwan() {
        if (Math.random() > 0.03)
            return null;
        const arr = [...this.stocks.values()];
        if (arr.length === 0)
            return null;
        const good = Math.random() < 0.4;
        const direction = good ? 'good' : 'bad';
        const roll = Math.random();
        if (roll < 0.35) {
            // 市场级：±2~4%
            const impact = good ? 2 + Math.random() * 2 : -(2 + Math.random() * 2);
            for (const st of arr) {
                st.price = Math.max(0.5, st.price * (1 + impact / 100));
                st.lastReturn = impact / 100;
            }
            this.factors['市场情绪'] = this.clamp((this.factors['市场情绪'] ?? 0) + (good ? 0.08 : -0.08), -0.2, 0.2);
            return { type: 'market', impact, direction, desc: good ? '政策红包：央行降准降息，市场全面利好' : '系统性风险：市场恐慌性抛售' };
        }
        else if (roll < 0.8) {
            // 板块级：±5~8%
            const industries = [...new Set(arr.map((x) => x.industry))];
            const industry = industries[Math.floor(Math.random() * industries.length)];
            const impact = good ? 5 + Math.random() * 3 : -(5 + Math.random() * 3);
            for (const st of arr) {
                if (st.industry === industry) {
                    st.price = Math.max(0.5, st.price * (1 + impact / 100));
                    st.lastReturn = impact / 100;
                }
            }
            this.factors['行业景气'] = this.clamp((this.factors['行业景气'] ?? 0) + (good ? 0.05 : -0.05), -0.2, 0.2);
            return { type: 'industry', impact, direction, industry, desc: good ? industry + '行业重大利好：政策扶持或技术突破' : industry + '行业重大利空：监管或技术事故冲击' };
        }
        else {
            // 个股级：±10~15%
            const st = arr[Math.floor(Math.random() * arr.length)];
            const impact = good ? 10 + Math.random() * 5 : -(10 + Math.random() * 5);
            st.price = Math.max(0.5, st.price * (1 + impact / 100));
            st.lastReturn = impact / 100;
            return { type: 'stock', impact, direction, symbol: st.symbol, name: st.name, desc: good ? st.name + '重大利好：拿下超级订单或新品发布' : st.name + '突发利空：造假指控或重大事故' };
        }
    }
    // 内存/DB 双写创建股票（init 与 IPO 共用）
    async createStockInMemory(cfg, price) {
        if (this.stocks.has(cfg.symbol)) return; // 双保险：已存在跳过
        const stock = this.stockRepo.create({
            symbol: cfg.symbol,
            name: cfg.name,
            code: cfg.code || '',
            listDate: cfg.listDate || (this.gameDay + '-xx-xx'),
            industry: cfg.industry,
            description: cfg.description || '',
            initialPrice: price,
            mu: cfg.mu || price,
            sigma: cfg.sigma || 0.025,
            theta: cfg.theta || 0.12,
            isActive: true,
        });
        await this.stockRepo.save(stock);
        this.poolBySymbol.set(cfg.symbol, cfg);
        const baseVol = Math.max(8000, Math.floor(price * 120));
        this.stocks.set(cfg.symbol, {
            symbol: cfg.symbol, name: cfg.name, industry: cfg.industry,
            code: cfg.code || '', listDate: cfg.listDate || '', description: cfg.description || '',
            price, intrinsic: price, // 内在价值（泡沫锚点）：初始=发行价，每日微增
            volatility: Number(cfg.sigma) * 0.5, lastReturn: 0,
            prevClose: price, lastVolume: baseVol, avgVolume: baseVol, baseVolume: baseVol, prevVolume: baseVol,
            dayOpen: price, dayHigh: price, dayLow: price, dayVolume: 0, minuteCounter: 0,
            kline1min: [], kline5min: [], klineDaily: [], current1min: null, current5min: null, currentDaily: null,
            trendCounter: 0, trendDirection: 0, trendAccumulated: 0, isTrending: false,
        });
    }
    // 分红：财报季记录（除权 + 持仓现金到账）
    recordDividend(symbol, perShare, day) {
        const list = this.dividends.get(symbol) || [];
        list.push({ perShare, day });
        this.dividends.set(symbol, list);
        // 除权：股价下调
        const st = this.stocks.get(symbol);
        if (st) {
            const before = Number(st.price);
            st.price = Math.max(0.5, before - perShare);
            // P1 复权：累计前复权因子（除权当日起历史价格按新因子折算，消除分红跳空）
            if (before > 0) {
                const info = this.adjFactors.get(symbol) || { factor: 1, series: [] };
                info.factor = info.factor * (st.price / before);
                info.series.push({ day: Number(day), factor: info.factor });
                this.adjFactors.set(symbol, info);
            }
        }
    }
    getDividends(day) {
        const out = [];
        for (const [symbol, list] of this.dividends.entries()) {
            for (const d of list) {
                if (d.day === day)
                    out.push({ symbol, perShare: d.perShare });
            }
        }
        return out;
    }
    // 随机取一只股票（新闻占位符填充用）
    getRandomStock() {
        const arr = [...this.stocks.values()];
        return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
    }
    // 新闻定向冲击：对指定个股/行业施加一次性价格波动（真实嵌入金融体系）
    applyNewsImpact(news) {
        const bullish = news.type !== 'bearish';
        const strength = 0.5 + Math.random() * 0.6; // 0.5%~1.1%
        for (const st of this.stocks.values()) {
            if (news.targetedSymbol && st.symbol === news.targetedSymbol) {
                st.price = Math.max(0.5, st.price * (1 + (bullish ? 1 : -1) * strength * 0.01));
                st.lastReturn = (bullish ? 1 : -1) * strength * 0.01;
            }
            else if (news.targetedIndustry && st.industry === news.targetedIndustry) {
                st.price = Math.max(0.5, st.price * (1 + (bullish ? 1 : -1) * strength * 0.004));
                st.lastReturn = (bullish ? 1 : -1) * strength * 0.004;
            }
        }
    }
};

export { MarketDataService };

MarketDataService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(stock_entity_1.Stock)),
    __param(1, (0, typeorm_1.InjectRepository)(kline_entity_1.Kline)),
    __param(2, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        trading_engine_service_1.TradingEngineService])
],
MarketDataService
);

