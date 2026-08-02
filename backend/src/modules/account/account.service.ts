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
import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");

import risk_manager_service_1 = require("../../core/risk-manager/risk-manager.service");

import constants_1 = require("../../common/constants");

let AccountService = class AccountService {
    [key: string]: any;
    constructor(accountRepo, positionRepo, transactionRepo, riskManager) {
        this.accountRepo = accountRepo;
        this.positionRepo = positionRepo;
        this.transactionRepo = transactionRepo;
        this.riskManager = riskManager;
    }
    async getAccount(userId, mode = 'US') {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            throw new common_1.NotFoundException(`账户不存在（${mode}）`);
        return account;
    }
    async getOrCreateAccount(userId, mode) {
        const existing = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (existing)
            return existing;
        const account = this.accountRepo.create({
            userId,
            marketMode: mode,
            cash: constants_1.RISK.initialCash,
            totalEquity: constants_1.RISK.initialCash,
            peakEquity: constants_1.RISK.initialCash,
            initialEquity: constants_1.RISK.initialCash,
            dayStartEquity: constants_1.RISK.initialCash,
        });
        return this.accountRepo.save(account);
    }
    async getPositions(accountId) {
        return this.positionRepo.find({ where: { accountId } });
    }
    // Q7：交易流水（资金明细/交割单）
    getTransactions(userId, mode, limit = 100) {
        return this.accountRepo.find({ where: { userId, marketMode: mode } }).then((list) => {
            const acct = list && list[0];
            if (!acct)
                return [];
            return this.transactionRepo.find({
                where: { accountId: acct.id },
                order: { createdAt: 'DESC' },
                take: Math.min(Number(limit) || 100, 300),
            });
        });
    }
    // Q4：账户历史净值曲线
    getHistory(userId, mode) {
        return this.accountRepo.find({ where: { userId, marketMode: mode } }).then((list) => {
            const acct = list && list[0];
            return acct ? this.riskManager.getEquityHistory(acct.id) : [];
        });
    }
    async getMetrics(userId, mode) {
        const account = await this.getAccount(userId, mode);
        const metrics = await this.riskManager.calculateMetrics(account);
        return { account, metrics };
    }
    async setLeverage(userId, mode, leverage) {
        const account = await this.getAccount(userId, mode);
        if (leverage < 1 || leverage > 3) {
            throw new common_1.BadRequestException('杠杆倍数必须在 1~3 之间');
        }
        account.leverage = leverage;
        return this.accountRepo.save(account);
    }
    // 交易复盘：个人 + 全局教训卡
    getReviews(userId) {
        return this.riskManager ? this.riskManager.getReviews(userId) : [];
    }
    async resetAccount(userId, mode, preset) {
        const presets = {
            '散户': { cash: 100000, leverage: 1 },
            '机构': { cash: 500000, leverage: 2 },
            '日内交易者': { cash: 200000, leverage: 3 },
        };
        const cfg = presets[preset];
        if (!cfg)
            throw new common_1.BadRequestException('未知的角色预设');
        const account = await this.getAccount(userId, mode);
        account.cash = cfg.cash;
        account.leverage = cfg.leverage;
        account.totalEquity = cfg.cash;
        account.peakEquity = cfg.cash;
        account.initialEquity = cfg.cash;
        account.dayStartEquity = cfg.cash;
        account.dailyPnl = 0;
        account.totalPnl = 0;
        account.marginUsed = 0;
        await this.positionRepo.delete({ accountId: account.id });
        return this.accountRepo.save(account);
    }
    getModeInfo(mode) {
        const isCN = mode === 'CN';
        return {
            mode,
            isTPlusOne: isCN,
            allowShort: !isCN,
            priceLimit: isCN ? 0.10 : null,
            label: isCN ? 'A股模式' : '美股模式',
            description: isCN
                ? '🇨🇳 A股 | T+1 | 单向做多 | 印花税0.1%'
                : '🇺🇸 美股 | T+0 | 可多空 | 无印花税',
        };
    }
};

export { AccountService };

AccountService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(position_entity_1.Position)),
    __param(2, (0, typeorm_1.InjectRepository)(transaction_entity_1.Transaction)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        risk_manager_service_1.RiskManagerService])
],
AccountService
);

