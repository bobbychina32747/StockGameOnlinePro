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

let FundService = class FundService {
    [key: string]: any;
    constructor(accountRepo) {
        this.accountRepo = accountRepo;
        this.logger = new common_1.Logger(FundService.name);
        this.funds = [
            { id: 'fund-1', name: '沪深300 ETF', type: 'ETF', nav: 4.5, dailyReturn: 0.001 },
            { id: 'fund-2', name: '货币基金 A', type: '货币基金', nav: 1.0, dailyReturn: 0.0001 },
        ];
        this.holdings = {};
    }
    getFunds() {
        return this.funds;
    }
    getFund(id) {
        return this.funds.find((f) => f.id === id);
    }
    async subscribe(userId, mode, fundId, amount) {
        if (!amount || Number(amount) <= 0) {
            return { success: false, error: '申购金额必须大于0' };
        }
        const fund = this.getFund(fundId);
        if (!fund)
            return { success: false, error: '基金不存在' };
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode || 'US' } });
        if (!account)
            return { success: false, error: '账户不存在' };
        if (Number(account.cash) < Number(amount))
            return { success: false, error: '账户余额不足' };
        const shares = Number(amount) / fund.nav;
        account.cash = Number(account.cash) - Number(amount);
        await this.accountRepo.save(account);
        const key = `${userId}_${mode}_${fundId}`;
        if (!this.holdings[key])
            this.holdings[key] = { shares: 0, totalInvested: 0 };
        this.holdings[key].shares += shares;
        this.holdings[key].totalInvested += Number(amount);
        this.logger.log(`用户 ${userId} 申购 ${fund.name} ${shares.toFixed(4)} 份 (¥${amount})`);
        return { success: true, shares: Number(shares.toFixed(4)), nav: fund.nav };
    }
    async redeem(userId, mode, fundId, shares) {
        if (!shares || Number(shares) <= 0) {
            return { success: false, error: '赎回份额必须大于0' };
        }
        const fund = this.getFund(fundId);
        if (!fund)
            return { success: false, error: '基金不存在' };
        const key = `${userId}_${mode}_${fundId}`;
        const holding = this.holdings[key];
        if (!holding || holding.shares < Number(shares))
            return { success: false, error: '持仓份额不足' };
        const amount = Number(shares) * fund.nav;
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode || 'US' } });
        if (!account)
            return { success: false, error: '账户不存在' };
        account.cash = Number(account.cash) + amount;
        await this.accountRepo.save(account);
        holding.shares -= Number(shares);
        if (holding.shares <= 0)
            delete this.holdings[key];
        this.logger.log(`用户 ${userId} 赎回 ${fund.name} ${shares.toFixed(4)} 份 (¥${amount})`);
        return { success: true, amount: Number(amount.toFixed(2)), nav: fund.nav };
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
    __metadata("design:paramtypes", [typeorm_2.Repository])
],
FundService
);

