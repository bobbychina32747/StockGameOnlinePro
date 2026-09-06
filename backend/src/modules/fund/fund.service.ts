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

import fund_holding_entity_1 = require("../../infrastructure/database/entities/fund-holding.entity");

import trading_engine_service_1 = require("../../core/trading-engine/trading-engine.service");

// Phase C: 行情引擎实例（只读 gameDay 用于赎回费持有期档位）
import market_data_service_1 = require("../../core/market-data/market-data.service");

// Phase C: 赛季中禁基金申购/赎回（快照净值赛公平性）
import season_service_1 = require("../season/season.service");

import constants_1 = require("../../common/constants");

// Phase C: 赎回费档位（A股基金真实口径）：持有 <7 交易日 1.5% / 7-30 日 0.5% / ≥30 日 0
function redeemFeeRate(holdDays) {
    const d = Math.max(0, Number(holdDays) || 0);
    if (d < 7)
        return 0.015;
    if (d < 30)
        return 0.005;
    return 0;
}

let FundService = class FundService {
    [key: string]: any;
    constructor(accountRepo, holdingRepo, engine, marketData, seasonService) {
        this.accountRepo = accountRepo;
        this.holdingRepo = holdingRepo;
        this.engine = engine;
        this.marketData = marketData;
        this.seasonService = seasonService;
        this.logger = new common_1.Logger(FundService.name);
        this.funds = [
            // Phase C: 增加申购费率（ETF 0.15%、货基 0）；NAV 保持稳健上涨（不可跌——防重开"重置/赎回"套利窗口，teams 风控红线）
            { id: 'fund-1', name: '沪深300 ETF', type: 'ETF', nav: 4.5, dailyReturn: 0.001, subscribeFeeRate: 0.0015 },
            { id: 'fund-2', name: '货币基金 A', type: '货币基金', nav: 1.0, dailyReturn: 0.0001, subscribeFeeRate: 0 },
        ];
        // FIX(M6): 定期更新基金净值（模拟净值波动）；unref 防止测试进程被定时器挂住
        const navTimer = setInterval(() => this.updateNavs(), 60 * 1000);
        if (navTimer && typeof navTimer.unref === 'function')
            navTimer.unref();
    }
    getFunds() {
        return this.funds;
    }
    getFund(id) {
        return this.funds.find((f) => f.id === id);
    }
    gameDay() {
        return Number((this.marketData && this.marketData.gameDay) || 0);
    }
    // Phase C: 币种折算——基金 NAV 以 CNY 计价，非 CN 账户按实时汇率折算申购/赎回
    toCny(amount, mode) {
        if (mode === 'CN')
            return Number(amount);
        const fx = (0, constants_1.getFxRates)();
        return Number(amount) * (Number(fx[mode]) || 1);
    }
    fromCny(cny, mode) {
        if (mode === 'CN')
            return Number(cny);
        const fx = (0, constants_1.getFxRates)();
        return Number(cny) / (Number(fx[mode]) || 1);
    }
    async subscribe(userId, mode, fundId, amount) {
        // SECURITY: Number('abc')=NaN 会绕过 NaN<=0 的判断并永久损坏 account.cash，必须先校验有限性
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
            return { success: false, error: '申购金额必须为大于0的数字' };
        }
        const fund = this.getFund(fundId);
        if (!fund)
            return { success: false, error: '基金不存在' };
        if (!this.engine)
            return { success: false, error: '交易引擎不可用' };
        // Phase C: 赛季中已报名的账户禁止申购（防净值口径被基金搬移干扰）
        if (this.seasonService && await this.seasonService.isBlocked(userId)) {
            return { success: false, error: '赛季进行中，基金申购已关闭' };
        }
        // SECURITY: 走结算互斥队列并在队列内重新读账户，封堵并发双花（check-then-act 竞态）
        return this.engine.runExclusive(async () => {
            const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode || 'US' } });
            if (!account)
                return { success: false, error: '账户不存在' };
            if (Number(account.cash) < amt)
                return { success: false, error: '账户余额不足' };
            const cny = this.toCny(amt, mode || 'US');
            const fee = cny * (Number(fund.subscribeFeeRate) || 0);
            const shares = (cny - fee) / fund.nav;
            account.cash = Math.round((Number(account.cash) - amt) * 100) / 100;
            await this.accountRepo.save(account);
            // FIX(H5): 份额落库，重启不丢失
            let holding = await this.holdingRepo.findOne({ where: { userId, marketMode: mode || 'US', fundId } });
            if (!holding) {
                holding = this.holdingRepo.create({ userId, marketMode: mode || 'US', fundId, shares: 0, totalInvested: 0, firstBuyDay: this.gameDay() });
            }
            holding.shares = Number(holding.shares) + shares;
            holding.totalInvested = Number(holding.totalInvested) + amt;
            if (Number(holding.firstBuyDay || 0) <= 0)
                holding.firstBuyDay = this.gameDay();
            await this.holdingRepo.save(holding);
            this.logger.log(`用户 ${userId} 申购 ${fund.name} ${shares.toFixed(4)} 份 (${mode || 'US'} ${amt.toFixed(2)}，申购费 ${this.fromCny(fee, mode || 'US').toFixed(2)})`);
            return { success: true, shares: Number(shares.toFixed(4)), nav: fund.nav, fee: Number(this.fromCny(fee, mode || 'US').toFixed(2)) };
        });
    }
    async redeem(userId, mode, fundId, shares) {
        const sh = Number(shares);
        if (!Number.isFinite(sh) || sh <= 0) {
            return { success: false, error: '赎回份额必须为大于0的数字' };
        }
        const fund = this.getFund(fundId);
        if (!fund)
            return { success: false, error: '基金不存在' };
        if (!this.engine)
            return { success: false, error: '交易引擎不可用' };
        // Phase C: 赛季中已报名的账户禁止赎回
        if (this.seasonService && await this.seasonService.isBlocked(userId)) {
            return { success: false, error: '赛季进行中，基金赎回已关闭' };
        }
        // SECURITY: 走结算互斥队列，防止与成交结算/申购交叉丢失更新
        return this.engine.runExclusive(async () => {
            const holding = await this.holdingRepo.findOne({ where: { userId, marketMode: mode || 'US', fundId } });
            if (!holding || Number(holding.shares) < sh)
                return { success: false, error: '持仓份额不足' };
            const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode || 'US' } });
            if (!account)
                return { success: false, error: '账户不存在' };
            // Phase C: 赎回费按持有期（gameDay - firstBuyDay）分档
            const holdDays = Math.max(0, this.gameDay() - Number(holding.firstBuyDay || 0));
            const feeRate = redeemFeeRate(holdDays);
            const cnyValue = sh * fund.nav * (1 - feeRate);
            const amount = this.fromCny(cnyValue, mode || 'US');
            account.cash = Math.round((Number(account.cash) + amount) * 100) / 100;
            await this.accountRepo.save(account);
            holding.shares = Number(holding.shares) - sh;
            if (Number(holding.shares) <= 0) {
                await this.holdingRepo.delete(holding.id);
            }
            else {
                await this.holdingRepo.save(holding);
            }
            this.logger.log(`用户 ${userId} 赎回 ${fund.name} ${sh.toFixed(4)} 份 (${mode || 'US'} ${amount.toFixed(2)}，持有 ${holdDays} 日，赎回费 ${(feeRate * 100).toFixed(1)}%)`);
            return { success: true, amount: Number(amount.toFixed(2)), nav: fund.nav, holdDays, feeRate };
        });
    }
    updateNavs() {
        for (const fund of this.funds) {
            const change = fund.nav * fund.dailyReturn * (Math.random() * 2);
            fund.nav = Number((fund.nav + change).toFixed(4));
        }
    }
};

export { FundService };

FundService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(fund_holding_entity_1.FundHolding)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        trading_engine_service_1.TradingEngineService,
        market_data_service_1.MarketDataService,
        season_service_1.SeasonService])
],
FundService
);
