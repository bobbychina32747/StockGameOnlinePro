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

let MarketDataService = class MarketDataService {
    [key: string]: any;
    constructor(stockRepo, klineRepo, engine) {
        this.stockRepo = stockRepo;
        this.klineRepo = klineRepo;
        this.engine = engine;
        this.logger = new common_1.Logger(MarketDataService.name);
        this.stocks = new Map<string, any>();
        this.marketRegime = 'sideways';
        this.tickCount = 0;
        this.gameDay = 0;
        this.factors = {} as Record<string, number>;
        this.isRunning = false;
        this.intervalHandle = null;
    }
    async init() {
        for (const f of constants_1.FACTOR_NAMES) {
            this.factors[f] = -0.02 + Math.random() * 0.04;
        }
        let dbStocks = await this.stockRepo.find({ where: { isActive: true } });
        if (dbStocks.length === 0) {
            for (const cfg of constants_1.STOCK_POOL) {
                const stock = this.stockRepo.create({
                    symbol: cfg.symbol,
                    name: cfg.name,
                    initialPrice: cfg.initialPrice,
                    mu: cfg.mu,
                    sigma: cfg.sigma,
                    theta: cfg.theta,
                });
                await this.stockRepo.save(stock);
                dbStocks.push(stock);
            }
        }
        for (const s of dbStocks) {
            const price = Number(s.initialPrice);
            // 根据初始价格动态计算基准成交量（价格越高流动性越好）
            const baseVol = Math.max(8000, Math.floor(price * 120));
            this.stocks.set(s.symbol, {
                symbol: s.symbol,
                price,
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
        for (let d = 0; d < 3; d++) {
            for (let t = 0; t < constants_1.MARKET.TICKS_PER_DAY; t++) {
                this.generateTick();
            }
            await this.endOfDay();
        }
        this.gameDay = 0;
        this.logger.log(`市场数据已初始化: ${dbStocks.length} 只股票`);
    }
    start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        this.intervalHandle = setInterval(() => {
            this.generateTick();
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
        for (const [name, val] of Object.entries(this.factors)) {
            let weight = 1.0;
            if (name === '市场情绪') weight = 1.3;
            const symCode = stock.symbol.charCodeAt(0) || 65;
            if (name === '行业景气' && symCode % 2 === 0) weight = 1.5;
            if (name === '政策风险' && symCode % 2 === 1) weight = 1.5;
            impact += (val as number) * weight;
        }
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

    generateTick() {
        if (this.stocks.size === 0)
            return [];
        const results = [];
        const regimes = this.marketRegime;
        const params = constants_1.STATE_PARAMS[regimes];
        const dt = 1 / constants_1.MARKET.TICKS_PER_DAY;
        const stocksArr: any[] = [...this.stocks.values()];
        const innovations = [];
        for (const stock of stocksArr) {
            const mu = Number(constants_1.STOCK_POOL.find((s) => s.symbol === stock.symbol)?.mu ?? 100);
            this.updateVolatility(stock);
            const shock = stock.volatility * params.volMult * this.randn() * Math.sqrt(dt) * 1.5;
            innovations.push(shock);
            const jump = this.calcJump(dt);
            const factorImpact = this.calcFactorImpact(stock);
            const ofiImpact = this.calcOFIImpact(stock);
            const drift = params.driftBase;
            let meanReversion = 0;
            let momentumBoost = 0;
            if (!stock.isTrending) {
                meanReversion = Number(constants_1.STOCK_POOL.find((s) => s.symbol === stock.symbol)?.theta ?? 0.15) * (mu - stock.price) * dt;
            } else {
                momentumBoost = 0.2 * dt * 1.5;
            }
            let priceChange = drift + shock + jump + factorImpact * dt * 5 + ofiImpact + meanReversion + momentumBoost;
            priceChange = this.clamp(priceChange, -0.03, 0.03);
            let newPrice = stock.price * (1 + priceChange);
            if (isNaN(newPrice) || !isFinite(newPrice))
                newPrice = stock.price;
            newPrice = Math.max(0.5, newPrice);
            stock.price = newPrice;
            this.updateTrend(stock, priceChange);
            stock.lastReturn = priceChange;
            stock.prevClose = stock.price;
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
        if (results.length === 2 && regimes === 'bear') {
            const correlation = 0.85;
            const crossA = correlation * innovations[1] * 0.2 * stocksArr[0].price;
            const crossB = correlation * innovations[0] * 0.2 * stocksArr[1].price;
            stocksArr[0].price = Math.max(0.5, stocksArr[0].price + crossA);
            stocksArr[1].price = Math.max(0.5, stocksArr[1].price + crossB);
        }
        this.tickCount++;
        return results;
    }
    updateKlines(stock) {
        const minute = Math.floor(stock.minuteCounter / 60);
        const price = stock.price;
        const volume = stock.lastVolume;
        if (!stock.current1min || stock.current1min.time.getMinutes() !== (30 + minute) % 60) {
            if (stock.current1min) {
                stock.kline1min.push(stock.current1min);
                if (stock.kline1min.length > 500)
                    stock.kline1min.shift();
            }
            stock.current1min = {
                time: new Date(2024, 0, 1, 9, 30 + minute, 0),
                open: price, high: price, low: price, close: price, volume: 0,
            };
        }
        const k1 = stock.current1min;
        k1.high = Math.max(k1.high, price);
        k1.low = Math.min(k1.low, price);
        k1.close = price;
        k1.volume += volume;
        const fiveIdx = Math.floor(minute / 5);
        if (!stock.current5min || Math.floor((stock.current5min.time.getMinutes() - 30) / 5) !== fiveIdx) {
            if (stock.current5min) {
                stock.kline5min.push(stock.current5min);
                if (stock.kline5min.length > 500)
                    stock.kline5min.shift();
            }
            stock.current5min = {
                time: new Date(2024, 0, 1, 9, 30 + fiveIdx * 5, 0),
                open: price, high: price, low: price, close: price, volume: 0,
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
    async endOfDay() {
        const batchKlines = [];
        for (const stock of this.stocks.values()) {
            if (stock.current1min) {
                stock.kline1min.push(stock.current1min);
                stock.current1min = null;
            }
            if (stock.current5min) {
                stock.kline5min.push(stock.current5min);
                stock.current5min = null;
            }
            if (stock.currentDaily) {
                stock.klineDaily.push(stock.currentDaily);
                try {
                    batchKlines.push(this.klineRepo.create({
                        symbol: stock.symbol,
                        timeframe: 'daily',
                        time: stock.currentDaily.time,
                        open: stock.currentDaily.open,
                        high: stock.currentDaily.high,
                        low: stock.currentDaily.low,
                        close: stock.currentDaily.close,
                        volume: stock.currentDaily.volume,
                    }));
                } catch (e) { }
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
        // 批量写入日K线
        if (batchKlines.length > 0) {
            try {
                await this.klineRepo.save(batchKlines);
            } catch (e) { }
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
    getKlines(symbol, timeframe) {
        const stock = this.stocks.get(symbol);
        if (!stock)
            return [];
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
            case 'daily':
                klines = [...stock.klineDaily];
                current = stock.currentDaily;
                break;
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
        };
    }
    applyFactorImpulse(factor, impact) {
        if (this.factors[factor] !== undefined) {
            this.factors[factor] += impact;
            this.factors[factor] = this.clamp(this.factors[factor], -0.2, 0.2);
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

