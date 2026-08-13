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

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import position_entity_1 = require("../../infrastructure/database/entities/position.entity");

import daily_snapshot_entity_1 = require("../../infrastructure/database/entities/daily-snapshot.entity");

import constants_1 = require("../../common/constants");

let RiskManagerService = class RiskManagerService {
    [key: string]: any;
    constructor(accountRepo, snapshotRepo, positionRepo) {
        this.accountRepo = accountRepo;
        this.snapshotRepo = snapshotRepo;
        this.positionRepo = positionRepo;
        this.logger = new common_1.Logger(RiskManagerService.name);
        this.equityHistory = new Map<string, any>();
        this.currentPrices = {};
        // 交易复盘：个人复盘 + 全局复盘（教育卡）
        this.reviews = new Map();
        this.globalReviews = [];
    }
    setMarketPrices(prices) {
        this.currentPrices = prices;
    }
    async recordDailyEquity(account, day) {
        const history = this.equityHistory.get(account.id) || [];
        const prevEquity = history.length > 0 ? history[history.length - 1].equity : Number(account.initialEquity);
        const dailyReturn = (Number(account.totalEquity) - prevEquity) / prevEquity;
        history.push({
            day,
            equity: Number(account.totalEquity),
            return: dailyReturn,
        });
        if (history.length > 365)
            history.shift();
        this.equityHistory.set(account.id, history);
        const snapshot = this.snapshotRepo.create({
            userId: account.userId,
            day,
            equity: Number(account.totalEquity),
            dailyReturn,
        });
        await this.snapshotRepo.save(snapshot);
    }
    // 交易复盘：个人复盘卡（强平/大亏损）+ 全局复盘（泡沫破灭教育）
    addReview(userId, review) {
        if (!userId)
            return;
        const arr = this.reviews.get(userId) || [];
        arr.unshift({ ...review, time: new Date().toISOString() });
        if (arr.length > 20)
            arr.length = 20;
        this.reviews.set(userId, arr);
    }
    addGlobalReview(review) {
        this.globalReviews.unshift({ ...review, time: new Date().toISOString() });
        if (this.globalReviews.length > 10)
            this.globalReviews.length = 10;
    }
    getReviews(userId) {
        const mine = userId ? (this.reviews.get(userId) || []) : [];
        return [...mine, ...this.globalReviews].slice(0, 20);
    }
    // 段位评分：收益(总收益归一化) + 风控(回撤) + 活跃(交易次数)
    computeTier(account) {
        const initial = Number(account.initialEquity) || 1;
        const totalReturn = (Number(account.totalEquity) - initial) / initial;
        const retScore = Math.max(0, Math.min(1, totalReturn / 0.5)) * 100;
        const peak = Number(account.peakEquity) || Number(account.totalEquity);
        const drawdown = peak > 0 ? Math.max(0, (peak - Number(account.totalEquity)) / peak) : 0;
        const riskScore = Math.max(0, Math.min(1, 1 - drawdown / 0.5)) * 100;
        const trades = Number(account.totalTrades) || 0;
        const actScore = Math.max(0, Math.min(1, trades / 50)) * 100;
        const tierScore = Math.round(retScore * 0.4 + riskScore * 0.3 + actScore * 0.3);
        const tiers = [
            { min: 92, name: '王者', icon: '🐉' },
            { min: 82, name: '大师', icon: '👑' },
            { min: 70, name: '钻石', icon: '🔷' },
            { min: 55, name: '铂金', icon: '💎' },
            { min: 35, name: '黄金', icon: '🥇' },
            { min: 15, name: '白银', icon: '🥈' },
            { min: 0, name: '青铜', icon: '🥉' },
        ];
        const tier = tiers.find((t) => tierScore >= t.min) || tiers[tiers.length - 1];
        account.tier = tier.name;
        account.tierScore = tierScore;
    }
    async dailySettlement(account, day) {
        const positions = await this.getPositionsValue(account);
        if (positions.marginUsed > 0) {
            const interest = positions.marginUsed * constants_1.RISK.marginInterestRate;
            account.cash = Number(account.cash) - interest;
        }
        account.totalEquity = Number(account.cash) + positions.holdValue;
        // 复盘：单日大亏损 >10% → 生成教训卡
        if (Number(account.dayStartEquity) > 0) {
            const dayRet = (Number(account.totalEquity) - Number(account.dayStartEquity)) / Number(account.dayStartEquity);
            if (dayRet < -0.1) {
                this.addReview(account.userId, {
                    type: '大亏损',
                    title: `📉 单日亏损 ${(Math.abs(dayRet) * 100).toFixed(1)}%`, desc: `第 ${day} 个交易日，你的账户单日亏损超过 10%`, lesson: '单日巨亏通常是重仓追高或未设止损。建议：①控制单笔仓位 ≤20% ②永远设止损单 ③泡沫期的暴涨回调往往最凶',
                });
            }
        }
        account.peakEquity = Math.max(Number(account.peakEquity), Number(account.totalEquity));
        account.dailyPnl = Number(account.totalEquity) - Number(account.dayStartEquity);
        account.totalPnl = Number(account.totalEquity) - Number(account.initialEquity);
        account.dayStartEquity = Number(account.totalEquity);
        account.currentDay = day;
        await this.accountRepo.save(account);
        await this.recordDailyEquity(account, day);
        return account;
    }
    // F6 修复：日终批量结算所有账户（由 market.service 在每日收市时调用）
    async settleAllAccounts(day) {
        const accounts = await this.accountRepo.find();
        const settled = [];
        for (const account of accounts) {
            try {
                settled.push(await this.dailySettlement(account, day));
                // 段位系统：收益40% + 风控30% + 活跃30%
                this.computeTier(account);
                await this.accountRepo.save(account);
            }
            catch (e) {
                this.logger.error(`日终结算失败 account=${account.id}: ${e.message}`);
            }
        }
        return settled;
    }
    // Q4：账户历史净值（内存，最近 365 天）
    getEquityHistory(accountId) {
        return (this.equityHistory.get(accountId) || []).slice();
    }
    async getPositionsValue(account) {
        const positions = await this.positionRepo.find({ where: { accountId: account.id } });
        let holdValue = 0;
        let marginUsed = 0;
        for (const pos of positions) {
            const price = this.currentPrices[pos.symbol] || 0;
            holdValue += (pos.longQty - pos.shortQty) * price;
            marginUsed += (pos.longQty * price) / Number(account.leverage || 1);
            marginUsed += pos.shortQty * price * constants_1.RISK.marginShortRate;
        }
        return { holdValue, marginUsed };
    }
    async calculateMetrics(account) {
        const history = this.equityHistory.get(account.id) || [];
        if (history.length < 2) {
            return {
                totalReturn: 0,
                dailyReturns: [],
                sharpeRatio: 0,
                maxDrawdown: 0,
                calmarRatio: 0,
                winRate: 0,
                totalTrades: Number(account.totalTrades) || 0,
                volatility: 0,
            };
        }
        const returns = history.map((h) => h.return);
        const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / returns.length;
        const volatility = Math.sqrt(variance * 252);
        const sharpeRatio = volatility > 0 ? (avgReturn * 252) / volatility : 0;
        let peak = Number(account.initialEquity);
        let maxDrawdown = 0;
        for (const h of history) {
            if (h.equity > peak)
                peak = h.equity;
            const drawdown = (peak - h.equity) / peak;
            if (drawdown > maxDrawdown)
                maxDrawdown = drawdown;
        }
        const totalReturn = (Number(account.totalEquity) - Number(account.initialEquity)) / Number(account.initialEquity);
        // FIX(M3): winRate 用「盈利交易日占比」近似（真实交易胜率需流水配对）；totalTrades 用账户真实值
        const winDays = returns.filter((r) => r > 0).length;
        return {
            totalReturn,
            dailyReturns: returns,
            sharpeRatio: Number(sharpeRatio.toFixed(4)),
            maxDrawdown: Number(maxDrawdown.toFixed(4)),
            calmarRatio: maxDrawdown > 0 ? totalReturn / maxDrawdown : 0,
            winRate: Number((returns.length ? winDays / returns.length : 0).toFixed(4)),
            totalTrades: Number(account.totalTrades) || 0,
            volatility: Number(volatility.toFixed(4)),
        };
    }
    calculateVaR(accountId, confidence = 0.95, days = 20) {
        // FIX(M3): 历史模拟法 VaR——取指定账户最近 days 天日收益的 (1-confidence) 分位数损失
        const history = accountId ? (this.equityHistory.get(accountId) || []) : [...this.equityHistory.values()].flat();
        if (history.length < 2)
            return 0;
        const returns = history.slice(-days).map((h) => h.return).sort((a, b) => a - b);
        const idx = Math.max(0, Math.floor(returns.length * (1 - confidence)));
        return Math.max(0, -returns[idx]);
    }
    kellyCriterion(winRate, avgWin, avgLoss) {
        if (avgLoss === 0)
            return 0;
        const b = avgWin / avgLoss;
        const p = winRate;
        const q = 1 - p;
        const kelly = (b * p - q) / b;
        return Math.max(0, Math.min(1, kelly));
    }
};

export { RiskManagerService };

RiskManagerService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(daily_snapshot_entity_1.DailySnapshot)),
    __param(2, (0, typeorm_1.InjectRepository)(position_entity_1.Position)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
],
RiskManagerService
);

