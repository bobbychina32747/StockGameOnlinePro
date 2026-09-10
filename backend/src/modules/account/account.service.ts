import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

// Phase A: 重置防刷钱——RESET_ENABLED 开关（大赛期间关闭）
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';

// Phase A: 重置防刷钱——基金持仓/未成交挂单一票否决 + 审计
import { FundHolding } from '../../infrastructure/database/entities/fund-holding.entity';
import { Order, OrderStatus } from '../../infrastructure/database/entities/order.entity';
import { ResetAuditLog } from '../../infrastructure/database/entities/reset-audit-log.entity';

// Phase C: 成就服务端化
import { Achievement } from '../../infrastructure/database/entities/achievement.entity';

// Phase C: 赛季中禁重置/划转
import { SeasonService } from '../season/season.service';
import { RiskManagerService } from '../../core/risk-manager/risk-manager.service';

// Phase F: 流水「最近 N 笔」口径单一来源
import { sliceRecentAsc } from '../../core/risk-manager/perf';
import { TradingEngineService } from '../../core/trading-engine/trading-engine.service';
import { FX_CNY_PER_UNIT, FX_TRANSFER_FEE_RATE, RISK, getFxRates } from '../../common/constants';

@Injectable()
export class AccountService {
    private readonly logger = new Logger(AccountService.name);

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(Position) private readonly positionRepo: Repository<Position>,
        @InjectRepository(Transaction) private readonly transactionRepo: Repository<Transaction>,
        @InjectRepository(FundHolding) private readonly fundHoldingRepo: Repository<FundHolding>,
        @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
        @InjectRepository(ResetAuditLog) private readonly resetAuditRepo: Repository<ResetAuditLog>,
        private readonly riskManager: RiskManagerService,
        private readonly engine: TradingEngineService,
        private readonly config: ConfigService,
        @InjectRepository(Achievement) private readonly achievementRepo: Repository<Achievement>,
        private readonly seasonService: SeasonService,
    ) {}

    async getAccount(userId: string, mode: string = 'US') {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            throw new NotFoundException(`账户不存在（${mode}）`);
        return account;
    }

    async getOrCreateAccount(userId: string, mode: string) {
        const existing = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (existing)
            return existing;
        const account = this.accountRepo.create({
            userId,
            marketMode: mode,
            cash: RISK.initialCash,
            totalEquity: RISK.initialCash,
            peakEquity: RISK.initialCash,
            initialEquity: RISK.initialCash,
            dayStartEquity: RISK.initialCash,
        });
        return this.accountRepo.save(account);
    }

    async getPositions(accountId: string) {
        return this.positionRepo.find({ where: { accountId } });
    }

    // Q7：交易流水（资金明细/交割单）
    getTransactions(userId: string, mode: string, limit: string | number = 100) {
        return this.accountRepo.find({ where: { userId, marketMode: mode } }).then((list) => {
            const acct = list && list[0];
            if (!acct)
                return [];
            return this.transactionRepo.find({
                where: { accountId: acct.id },
                order: { createdAt: 'DESC' },
                // SECURITY: 必须先钳下界再钳上界——原式 Math.min(Number(limit) || 100, 300) 对 limit=-1 得到 take=-1，
                // 而 SQLite 的 LIMIT 负值等于「无上限」，可拉走该账户全部流水（越权读放大）；现统一落在 [1,300]，默认 100 不变
                take: Math.min(Math.max(1, Number(limit) || 100), 300),
            });
        });
    }

    // Q4：账户历史净值曲线
    getHistory(userId: string, mode: string) {
        return this.accountRepo.find({ where: { userId, marketMode: mode } }).then((list) => {
            const acct = list && list[0];
            return acct ? this.riskManager.getEquityHistory(acct.id) : [];
        });
    }

    async getMetrics(userId: string, mode: string) {
        const account = await this.getAccount(userId, mode);
        // P5 配对级绩效：最近 500 笔流水（升序）做 FIFO 配对
        // Phase F 修复：原「升序 + take 500」在 SQLite 下取到的是最旧 500 笔（与注释/日终段位口径相反）
        // → 统一走 perf.sliceRecentAsc（拉全量升序后截尾），与 settleAllAccounts 段位指标同口径
        const allTxs = await this.transactionRepo.find({
            where: { accountId: account.id },
            order: { createdAt: 'ASC' },
        });
        const txs = sliceRecentAsc(allTxs);
        const metrics = await this.riskManager.calculateMetrics(account, txs);
        return { account, metrics };
    }

    async setLeverage(userId: string, mode: string, leverage: number) {
        const account = await this.getAccount(userId, mode);
        // SECURITY: 非数字（NaN/Infinity/字符串）会绕过比较并污染保证金计算，必须先校验有限性
        const lev = Number(leverage);
        if (!Number.isFinite(lev) || lev < 1 || lev > 3) {
            throw new BadRequestException('杠杆倍数必须是 1~3 之间的数字');
        }
        account.leverage = lev;
        return this.accountRepo.save(account);
    }

    // 交易复盘：个人 + 全局教训卡
    getReviews(userId: string) {
        return this.riskManager ? this.riskManager.getReviews(userId) : [];
    }

    async resetAccount(userId: string, mode: string, preset: string) {
        const presets = {
            '散户': { cash: 100000, leverage: 1 },
            '机构': { cash: 500000, leverage: 2 },
            '日内交易者': { cash: 200000, leverage: 3 },
        };
        // SECURITY: 必须按自有键判定——presets[preset] 会命中原型链上的函数（'constructor'/'__proto__'/'toString' 均 truthy），
        // 绕过「未知的角色预设」校验后把 cash/leverage/totalEquity/peakEquity/initialEquity/dayStartEquity 写成 undefined
        // 并清零 dailyPnl/totalPnl/marginUsed/shortCollateral/borrowed（已登录用户可自我损坏账户数据，P1）
        const cfg = Object.prototype.hasOwnProperty.call(presets, preset) ? presets[preset] : null;
        if (!cfg)
            throw new BadRequestException('未知的角色预设');
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
            throw new ServiceUnavailableException('交易引擎不可用');
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
            const pending = await this.orderRepo.find({ where: { accountId: account.id, status: OrderStatus.PENDING } });
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
    async transferCash(userId: string, fromMode: string, toMode: string, amount: number) {
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
        const fx = getFxRates();
        // SECURITY: 取汇率前先按市场白名单校验（FX_CNY_PER_UNIT 的自有键即 CN/HK/US）+ hasOwnProperty 双保险——
        // 原实现直接 fx[fromMode] 会让 '__proto__'/'constructor'/'toString' 命中原型链上的 truthy 值，绕过「不支持的市场」校验
        const isFxMarket = (m: string) => Object.prototype.hasOwnProperty.call(FX_CNY_PER_UNIT, m)
            && Object.prototype.hasOwnProperty.call(fx, m);
        if (!isFxMarket(fromMode) || !isFxMarket(toMode)) {
            throw new BadRequestException('不支持的划转市场（仅支持 CN/HK/US）');
        }
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
            const received = (cnyValue / toRate) * (1 - FX_TRANSFER_FEE_RATE);
            from.cash = Math.round((Number(from.cash) - amt) * 100) / 100;
            to.cash = Math.round((Number(to.cash) + received) * 100) / 100;
            await this.accountRepo.save(from);
            await this.accountRepo.save(to);
            this.logger.log('跨市场划转 ' + userId + ': ' + fromMode + ' -' + amt.toFixed(2) + ' → ' + toMode + ' +' + received.toFixed(2) + '（手续费 ' + (FX_TRANSFER_FEE_RATE * 100).toFixed(1) + '%）');
            return { success: true, received: Number(received.toFixed(2)) };
        });
    }

    getModeInfo(mode: string) {
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
    getAchievements(userId: string) {
        return this.achievementRepo.find({ where: { userId }, order: { unlockedAt: 'ASC' } });
    }

    async unlockAchievement(userId: string, code: string) {
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
}
