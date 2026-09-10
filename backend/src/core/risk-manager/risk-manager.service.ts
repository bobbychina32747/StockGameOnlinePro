import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { DailySnapshot } from '../../infrastructure/database/entities/daily-snapshot.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';
import { RISK } from '../../common/constants';
import { pairedMetrics, sliceRecentAsc } from './perf';
import { computeTierScore, tierOf } from './tier';

@Injectable()
export class RiskManagerService {
    private readonly logger = new Logger(RiskManagerService.name);
    private readonly equityHistory = new Map<string, any>();
    private currentPrices: Record<string, number> = {};
    // 交易复盘：个人复盘 + 全局复盘（教育卡）
    private readonly reviews = new Map<string, any[]>();
    private readonly globalReviews: any[] = [];

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(DailySnapshot) private readonly snapshotRepo: Repository<DailySnapshot>,
        @InjectRepository(Position) private readonly positionRepo: Repository<Position>,
        @InjectRepository(Transaction) private readonly txRepo: Repository<Transaction>,
    ) {}

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

    // Phase D：真实指标聚合（settleAllAccounts 批量拉取流水后逐账户调用；perf.ts 配对输入须时间升序）
    buildTierMetrics(account, txs) {
        const initial = Number(account.initialEquity) || 1;
        const totalReturn = (Number(account.totalEquity) - initial) / initial;
        const peak = Number(account.peakEquity) || Number(account.totalEquity);
        const maxDrawdown = peak > 0 ? Math.max(0, (peak - Number(account.totalEquity)) / peak) : 0;
        const paired = pairedMetrics(Array.isArray(txs) ? txs : []);
        return {
            totalReturn,
            maxDrawdown,
            profitFactor: paired.profitFactor,
            winRate: paired.pairedWinRate,
            totalTrades: Number(account.totalTrades) || 0,
        };
    }

    // Phase D 数据驱动段位（销 tech-debt 主观 40/30/30 公式）：metrics 由 settleAllAccounts 提供；
    // 无参调用降级为空流水口径（兼容存量测试构造）
    computeTier(account, metrics) {
        const m = metrics || this.buildTierMetrics(account, []);
        const score = computeTierScore(m);
        const tier = tierOf(score);
        account.tier = tier.name;
        account.tierScore = score;
    }

    async dailySettlement(account, day, preloadedPositions) {
        // SECURITY: 幂等保护——当日已结算的账户直接跳过（防出错重跑导致重复计息/重复快照）
        if (Number(account.currentDay) === Number(day)) {
            return account;
        }
        const positions = await this.getPositionsValue(account, preloadedPositions);
        // Phase B P1#9: 利息基数 = 融资负债（真杠杆记账）+ 空头冻结保证金（杠杆1不借资不付息语义保留）
        const interestBase = Number(account.borrowed || 0) + Number(account.shortCollateral || 0);
        if (interestBase > 0) {
            const interest = interestBase * RISK.marginInterestRate;
            account.cash = Math.round((Number(account.cash) - interest) * 100) / 100;
        }
        account.totalEquity = Number(account.cash) + positions.holdValue + Number(account.shortCollateral || 0) - Number(account.borrowed || 0);
        // 复盘：单日大亏损 >10% → 生成教训卡
        if (Number(account.dayStartEquity) > 0) {
            const dayRet = (Number(account.totalEquity) - Number(account.dayStartEquity)) / Number(account.dayStartEquity);
            if (dayRet < -0.1) {
                this.addReview(account.userId, {
                    type: '大亏损',
                    title: `📉 单日亏损 ${(Math.abs(dayRet) * 100).toFixed(1)}%`, desc: `第 ${day} 个交易日，你的账户单日亏损超过 10%`, lesson: '单日巨亏通常是重仓追高或未设止损。建议：①控制单笔仓位 ≤20% ②永远设止损单 ③泡沫期的暴涨回调往往最凶',
                });
            }
            // Phase C: 数据驱动教训卡——单日大赚（警惕追高兑现风险）
            if (dayRet > 0.1) {
                this.addReview(account.userId, {
                    type: '大赚',
                    title: `🚀 单日盈利 ${(dayRet * 100).toFixed(1)}%`, desc: `第 ${day} 个交易日，你的账户单日盈利超过 10%`, lesson: '单日大涨常常伴随短期过热。建议：①检查仓位是否过于集中 ②考虑分批兑现 ③别把运气当能力，看回撤数据说话',
                });
            }
        }
        // Phase C: 数据驱动教训卡——满仓单票（单一持仓市值超总权益 80%）
        if (positions.maxSingleRatio > 0.8 && Number(account.totalEquity) > 0) {
            this.addReview(account.userId, {
                type: '满仓单票',
                title: `🎯 单票集中度 ${(positions.maxSingleRatio * 100).toFixed(0)}%`, desc: `第 ${day} 个交易日，单一持仓占总资产 ${(positions.maxSingleRatio * 100).toFixed(0)}%`, lesson: '鸡蛋别放一个篮子：①单一持仓建议 ≤ 总资产 50% ②分散到 2-3 个不相关行业 ③重仓单票时务必设止损',
            });
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
        if (accounts.length === 0)
            return settled;
        const ids = accounts.map((a) => a.id);
        // Phase D 批量 2：持仓（原逐账户 positionRepo.find → 1 次 In；只读，结算不回写 positions）
        let positionsByAccount = new Map();
        try {
            const posRows = await this.positionRepo.find({ where: { accountId: In(ids) } });
            for (const p of posRows) {
                const arr = positionsByAccount.get(p.accountId) || [];
                arr.push(p);
                positionsByAccount.set(p.accountId, arr);
            }
        }
        catch (e) {
            this.logger.warn('日终批量预载持仓失败，退回逐账户查询: ' + e.message);
            positionsByAccount = null; // null → getPositionsValue 走原逐账户查询
        }
        // Phase D 批量 3：流水（1 次全局 ASC 拉取 + JS 分组截最近 500；
        // 不用 find({take})：better-sqlite3 下 take 生成全局 LIMIT，按 uuid 排序靠后账户会拿不满）
        const txsByAccount = new Map();
        try {
            const txRows = await this.txRepo.find({ order: { createdAt: 'ASC' } });
            const byAcct = new Map();
            for (const t of txRows) {
                const arr = byAcct.get(t.accountId) || [];
                arr.push(t);
                byAcct.set(t.accountId, arr);
            }
            for (const [acid, arr] of byAcct) {
                txsByAccount.set(acid, sliceRecentAsc(arr)); // 最近 500 且保持升序（Phase F: 口径单一来源）
            }
        }
        catch (e) {
            this.logger.warn('日终批量预载流水失败，段位指标按 0 流水口径: ' + e.message);
        }
        for (const account of accounts) {
            try {
                const posRows = positionsByAccount ? positionsByAccount.get(account.id) : undefined;
                settled.push(await this.dailySettlement(account, day, posRows));
                // Phase D：数据驱动段位（收益/回撤/盈亏因子/胜率/活跃）
                const metrics = this.buildTierMetrics(account, txsByAccount.get(account.id) || []);
                this.computeTier(account, metrics);
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

    async getPositionsValue(account, preloaded) {
        const positions = preloaded || await this.positionRepo.find({ where: { accountId: account.id } });
        let holdValue = 0;
        let marginUsed = 0;
        let maxSingle = 0;
        for (const pos of positions) {
            const price = this.currentPrices[pos.symbol];
            if (price === undefined || price === null)
                continue; // 无报价持仓跳过估值，避免按 0 计
            const singleValue = Math.max(0, (Number(pos.longQty) - Number(pos.shortQty)) * price);
            maxSingle = Math.max(maxSingle, singleValue);
            holdValue += (pos.longQty - pos.shortQty) * price;
            // Phase B P1#9: 多头全额现金买入对应的借入部分已记账在 account.borrowed，不再由持仓市值推导；
            // marginUsed 仅保留空头保证金（兼容字段，利息基数已改用 borrowed+shortCollateral）
            marginUsed += pos.shortQty * price * RISK.marginShortRate;
        }
        // Phase C: 单票集中度 = 最大单票市值 / 总权益（总权益在调用后计算，用现金+持仓近似）
        const equityApprox = Number(account.cash) + holdValue + Number(account.shortCollateral || 0) - Number(account.borrowed || 0);
        const maxSingleRatio = equityApprox > 0 ? maxSingle / equityApprox : 0;
        return { holdValue, marginUsed, maxSingleRatio };
    }

    async calculateMetrics(account, txs) {
        const history = this.equityHistory.get(account.id) || [];
        // P5 配对级绩效：FIFO 流水配对 → 真实胜率/盈亏因子/月度收益
        const paired = pairedMetrics(Array.isArray(txs) ? txs : []);
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
                pairedTrades: paired.pairedTrades,
                pairedWinRate: Number(paired.pairedWinRate.toFixed(4)),
                profitFactor: paired.profitFactor === Infinity ? 0 : Number(paired.profitFactor.toFixed(2)),
                monthlyPnl: paired.monthlyPnl,
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
            // P5 配对级绩效（真实盈亏配对，而非盈利交易日占比）
            pairedTrades: paired.pairedTrades,
            pairedWinRate: Number(paired.pairedWinRate.toFixed(4)),
            profitFactor: paired.profitFactor === Infinity ? 0 : Number(paired.profitFactor.toFixed(2)),
            monthlyPnl: paired.monthlyPnl,
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
}
