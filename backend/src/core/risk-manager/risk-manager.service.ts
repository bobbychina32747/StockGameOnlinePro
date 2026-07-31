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
    async dailySettlement(account, day) {
        const positions = await this.getPositionsValue(account);
        if (positions.marginUsed > 0) {
            const interest = positions.marginUsed * constants_1.RISK.marginInterestRate;
            account.cash = Number(account.cash) - interest;
        }
        account.totalEquity = Number(account.cash) + positions.holdValue;
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
                totalTrades: 0,
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
        return {
            totalReturn,
            dailyReturns: returns,
            sharpeRatio: Number(sharpeRatio.toFixed(4)),
            maxDrawdown: Number(maxDrawdown.toFixed(4)),
            calmarRatio: maxDrawdown > 0 ? totalReturn / maxDrawdown : 0,
            winRate: 0,
            totalTrades: 0,
            volatility: Number(volatility.toFixed(4)),
        };
    }
    calculateVaR(confidence = 0.95, days = 20) {
        return 0.02;
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

