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

// Phase A: 重置防刷钱——RESET_ENABLED 开关（大赛期间关闭）
import config_1 = require("@nestjs/config");

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import position_entity_1 = require("../../infrastructure/database/entities/position.entity");
import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");

// Phase A: 重置防刷钱——基金持仓/未成交挂单一票否决 + 审计
import fund_holding_entity_1 = require("../../infrastructure/database/entities/fund-holding.entity");
import order_entity_1 = require("../../infrastructure/database/entities/order.entity");
import reset_audit_log_entity_1 = require("../../infrastructure/database/entities/reset-audit-log.entity");

// Phase C: 成就服务端化
import achievement_entity_1 = require("../../infrastructure/database/entities/achievement.entity");

// Phase C: 赛季中禁重置/划转
import season_service_1 = require("../season/season.service");

import risk_manager_service_1 = require("../../core/risk-manager/risk-manager.service");

import trading_engine_service_1 = require("../../core/trading-engine/trading-engine.service");

import constants_1 = require("../../common/constants");

let AccountService = class AccountService {
    [key: string]: any;
    constructor(accountRepo, positionRepo, transactionRepo, fundHoldingRepo, orderRepo, resetAuditRepo, riskManager, engine, config, achievementRepo, seasonService) {
        this.accountRepo = accountRepo;
        this.positionRepo = positionRepo;
        this.transactionRepo = transactionRepo;
        this.fundHoldingRepo = fundHoldingRepo;
        this.orderRepo = orderRepo;
        this.resetAuditRepo = resetAuditRepo;
        this.riskManager = riskManager;
        this.engine = engine;
        this.config = config;
        this.achievementRepo = achievementRepo;
        this.seasonService = seasonService;
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
        // P5 配对级绩效：取最近 500 笔流水（升序）做 FIFO 配对
        const txs = await this.transactionRepo.find({
            where: { accountId: account.id },
            order: { createdAt: 'ASC' },
            take: 500,
        });
        const metrics = await this.riskManager.calculateMetrics(account, txs);
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
        // Phase A: 大赛进行中（RESET_ENABLED=false）禁止重置，保证赛季公平
        const resetEnabled = String(this.config && this.config.get ? this.config.get('RESET_ENABLED', 'true') : 'true') === 'true';
        if (!resetEnabled) {
            return { success: false, error: '大赛进行中，账户重置已关闭' };
        }
        // Phase C: 赛季中已报名的账户禁止重置（快照净值赛公平性）
        if (this.seasonService && await this.seasonService.isBlocked(userId)) {
            return { success: false, error: '赛季进行中，账户重置已关闭' };
        }
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
            // Phase A P0#1: 基金份额是独立资产，持有时重置=申购→重置→赎回无限刷钱，一票否决
            const fundHoldings = await this.fundHoldingRepo.find({ where: { userId, marketMode: mode } });
            const fundValue = fundHoldings.reduce((s, h) => s + Number(h.shares || 0) * 1, 0);
            if (fundHoldings.some((h) => Number(h.shares || 0) > 0)) {
                return { success: false, error: '存在基金持仓，无法重置账户（请先赎回全部基金）' };
            }
            // Phase A P0#1: 挂单会被 checkPendingOrders 成交成持仓，是绕过"无持仓"检查的时序窗口，必须同步禁止
            const pending = await this.orderRepo.find({ where: { accountId: account.id, status: order_entity_1.OrderStatus.PENDING } });
            if (pending.length > 0) {
                return { success: false, error: '存在未成交挂单，无法重置账户（请先撤单）' };
            }
            // Phase A: 冷却 1 个游戏日（按账户 currentDay 持久化，防排行榜/赛季刷分）
            const lastResetDay = Number(account.lastResetDay || 0);
            const currentDay = Number(account.currentDay || 0);
            if (currentDay <= lastResetDay) {
                return { success: false, error: '重置过于频繁，请下一个交易日后再试' };
            }
            const prevCash = Number(account.cash);
            const prevEquity = Number(account.totalEquity);
            const prevPeak = Number(account.peakEquity);
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
            // Phase B: 融资负债随重置清零
            account.borrowed = 0;
            account.lastResetDay = currentDay;
            account.resetCount = (Number(account.resetCount) || 0) + 1;
            await this.accountRepo.save(account);
            // Phase A: 审计落库（重置前后资金状态可追溯）
            try {
                await this.resetAuditRepo.save(this.resetAuditRepo.create({
                    userId, marketMode: mode, preset,
                    prevCash, prevEquity, prevPeak,
                    fundValueAtReset: fundValue,
                }));
            }
            catch (e) {
                this.logger.warn('重置审计落库失败: ' + (e && e.message ? e.message : e));
            }
            this.logger.warn(`账户重置: user=${userId} ${mode} ${preset}（第 ${account.resetCount} 次，前资产 ¥${prevEquity.toFixed(2)}）`);
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
        // Phase C: 赛季中已报名的账户禁止划转（防搬钱虚增赛季净值）
        if (this.seasonService && await this.seasonService.isBlocked(userId)) {
            return { success: false, error: '赛季进行中，跨市场划转已关闭' };
        }
        // P5 动态汇率：用实时汇率（行情引擎每日演化）而非固定基准
        const fx = (0, constants_1.getFxRates)();
        const fromRate = fx[fromMode];
        const toRate = fx[toMode];
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
    // Phase C: 成就服务端化（评估在前端，服务端只做幂等持久化 + 跨设备查询）
    getAchievements(userId) {
        return this.achievementRepo.find({ where: { userId }, order: { unlockedAt: 'ASC' } });
    }
    async unlockAchievement(userId, code) {
        if (!code || typeof code !== 'string' || code.length > 40) {
            return { success: false, error: '成就代码无效' };
        }
        const existing = await this.achievementRepo.findOne({ where: { userId, code } });
        if (existing)
            return { success: true, duplicate: true };
        try {
            await this.achievementRepo.save(this.achievementRepo.create({ userId, code }));
            return { success: true };
        }
        catch (e) {
            // UNIQUE(userId, code) 冲突=并发幂等
            return { success: true, duplicate: true };
        }
    }
};

export { AccountService };

AccountService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(position_entity_1.Position)),
    __param(2, (0, typeorm_1.InjectRepository)(transaction_entity_1.Transaction)),
    __param(3, (0, typeorm_1.InjectRepository)(fund_holding_entity_1.FundHolding)),
    __param(4, (0, typeorm_1.InjectRepository)(order_entity_1.Order)),
    __param(5, (0, typeorm_1.InjectRepository)(reset_audit_log_entity_1.ResetAuditLog)),
    __param(9, (0, typeorm_1.InjectRepository)(achievement_entity_1.Achievement)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        risk_manager_service_1.RiskManagerService,
        trading_engine_service_1.TradingEngineService,
        config_1.ConfigService,
        typeorm_2.Repository,
        season_service_1.SeasonService])
],
AccountService
);

