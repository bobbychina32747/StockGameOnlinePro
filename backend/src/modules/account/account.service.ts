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

import trading_engine_service_1 = require("../../core/trading-engine/trading-engine.service");

import constants_1 = require("../../common/constants");

let AccountService = class AccountService {
    [key: string]: any;
    constructor(accountRepo, positionRepo, transactionRepo, riskManager, engine) {
        this.accountRepo = accountRepo;
        this.positionRepo = positionRepo;
        this.transactionRepo = transactionRepo;
        this.riskManager = riskManager;
        this.engine = engine;
        this.logger = new common_1.Logger(AccountService.name);
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
        // SECURITY: 非数字（NaN/Infinity/字符串）会绕过比较并污染保证金计算，必须先校验有限性
        const lev = Number(leverage);
        if (!Number.isFinite(lev) || lev < 1 || lev > 3) {
            throw new common_1.BadRequestException('杠杆倍数必须是 1~3 之间的数字');
        }
        account.leverage = lev;
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
        // SECURITY: 重置必须走结算互斥队列，防止与成交结算交叉丢失更新
        if (!this.engine) {
            throw new common_1.ServiceUnavailableException('交易引擎不可用');
        }
        return this.engine.runExclusive(async () => {
            const account = await this.getAccount(userId, mode);
            // SECURITY: 有持仓时禁止重置（原实现直接删持仓=免费套利棘轮：赚了保留、亏了重置）
            const positions = await this.positionRepo.find({ where: { accountId: account.id } });
            if (positions.length > 0) {
                return { success: false, error: '存在持仓，无法重置账户（请先平仓）' };
            }
            account.cash = cfg.cash;
            account.leverage = cfg.leverage;
            account.totalEquity = cfg.cash;
            account.peakEquity = cfg.cash;
            account.initialEquity = cfg.cash;
            account.dayStartEquity = cfg.cash;
            account.dailyPnl = 0;
            account.totalPnl = 0;
            account.marginUsed = 0;
            // SECURITY: 冻结保证金必须归零（原实现遗留 shortCollateral 导致资金永久冻结）
            account.shortCollateral = 0;
            // 注：基金持仓（FundHolding）不在本服务管理范围，重置不涉及基金份额
            await this.accountRepo.save(account);
            return { success: true, account };
        });
    }
    // P3 跨市场资金划转：按汇率折算（CN/HK/US → 人民币 → 目标币种），收 0.1% 手续费
    async transferCash(userId, fromMode, toMode, amount) {
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
            return { success: false, error: '划转金额必须为大于0的数字' };
        }
        if (!fromMode || !toMode || fromMode === toMode) {
            return { success: false, error: '划转市场必须不同（CN/HK/US）' };
        }
        const fromRate = constants_1.FX_CNY_PER_UNIT[fromMode];
        const toRate = constants_1.FX_CNY_PER_UNIT[toMode];
        if (!fromRate || !toRate) {
            return { success: false, error: '不支持的市场' };
        }
        if (!this.engine) {
            return { success: false, error: '交易引擎不可用' };
        }
        return this.engine.runExclusive(async () => {
            const from = await this.accountRepo.findOne({ where: { userId, marketMode: fromMode } });
            if (!from)
                return { success: false, error: '转出账户不存在' };
            if (Number(from.cash) < amt)
                return { success: false, error: '转出账户余额不足' };
            const to = await this.accountRepo.findOne({ where: { userId, marketMode: toMode } });
            if (!to)
                return { success: false, error: '转入账户不存在' };
            const cnyValue = amt * fromRate;
            const received = (cnyValue / toRate) * (1 - constants_1.FX_TRANSFER_FEE_RATE);
            from.cash = Math.round((Number(from.cash) - amt) * 100) / 100;
            to.cash = Math.round((Number(to.cash) + received) * 100) / 100;
            await this.accountRepo.save(from);
            await this.accountRepo.save(to);
            this.logger.log('跨市场划转 ' + userId + ': ' + fromMode + ' -' + amt.toFixed(2) + ' → ' + toMode + ' +' + received.toFixed(2) + '（手续费 ' + (constants_1.FX_TRANSFER_FEE_RATE * 100).toFixed(1) + '%）');
            return { success: true, received: Number(received.toFixed(2)) };
        });
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
        risk_manager_service_1.RiskManagerService,
        trading_engine_service_1.TradingEngineService])
],
AccountService
);

