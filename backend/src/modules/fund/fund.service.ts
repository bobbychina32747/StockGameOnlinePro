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

let FundService = class FundService {
    [key: string]: any;
    constructor(accountRepo, holdingRepo, engine) {
        this.accountRepo = accountRepo;
        this.holdingRepo = holdingRepo;
        this.engine = engine;
        this.logger = new common_1.Logger(FundService.name);
        this.funds = [
            { id: 'fund-1', name: '沪深300 ETF', type: 'ETF', nav: 4.5, dailyReturn: 0.001 },
            { id: 'fund-2', name: '货币基金 A', type: '货币基金', nav: 1.0, dailyReturn: 0.0001 },
        ];
        // FIX(M6): 定期更新基金净值（模拟净值波动）
        setInterval(() => this.updateNavs(), 60 * 1000);
    }
    getFunds() {
        return this.funds;
    }
    getFund(id) {
        return this.funds.find((f) => f.id === id);
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
        // SECURITY: 走结算互斥队列并在队列内重新读账户，封堵并发双花（check-then-act 竞态）
        return this.engine.runExclusive(async () => {
            const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode || 'US' } });
            if (!account)
                return { success: false, error: '账户不存在' };
            if (Number(account.cash) < amt)
                return { success: false, error: '账户余额不足' };
            const shares = amt / fund.nav;
            account.cash = Math.round((Number(account.cash) - amt) * 100) / 100;
            await this.accountRepo.save(account);
            // FIX(H5): 份额落库，重启不丢失
            let holding = await this.holdingRepo.findOne({ where: { userId, marketMode: mode || 'US', fundId } });
            if (!holding) {
                holding = this.holdingRepo.create({ userId, marketMode: mode || 'US', fundId, shares: 0, totalInvested: 0 });
            }
            holding.shares = Number(holding.shares) + shares;
            holding.totalInvested = Number(holding.totalInvested) + amt;
            await this.holdingRepo.save(holding);
            this.logger.log(`用户 ${userId} 申购 ${fund.name} ${shares.toFixed(4)} 份 (¥${amt.toFixed(2)})`);
            return { success: true, shares: Number(shares.toFixed(4)), nav: fund.nav };
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
        // SECURITY: 走结算互斥队列，防止与成交结算/申购交叉丢失更新
        return this.engine.runExclusive(async () => {
            const holding = await this.holdingRepo.findOne({ where: { userId, marketMode: mode || 'US', fundId } });
            if (!holding || Number(holding.shares) < sh)
                return { success: false, error: '持仓份额不足' };
            const amount = sh * fund.nav;
            const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode || 'US' } });
            if (!account)
                return { success: false, error: '账户不存在' };
            account.cash = Math.round((Number(account.cash) + amount) * 100) / 100;
            await this.accountRepo.save(account);
            holding.shares = Number(holding.shares) - sh;
            if (Number(holding.shares) <= 0) {
                await this.holdingRepo.delete(holding.id);
            }
            else {
                await this.holdingRepo.save(holding);
            }
            this.logger.log(`用户 ${userId} 赎回 ${fund.name} ${sh.toFixed(4)} 份 (¥${amount.toFixed(2)})`);
            return { success: true, amount: Number(amount.toFixed(2)), nav: fund.nav };
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
        trading_engine_service_1.TradingEngineService])
],
FundService
);
