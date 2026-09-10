import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { FundHolding } from '../../infrastructure/database/entities/fund-holding.entity';
// Phase 14: 基金净值落库（重启后 NAV 不复位，见 FundNav 实体注释）
import { FundNav } from '../../infrastructure/database/entities/fund-nav.entity';
import { TradingEngineService } from '../../core/trading-engine/trading-engine.service';

// Phase C: 行情引擎实例（只读 gameDay 用于赎回费持有期档位）
import { MarketDataService } from '../../core/market-data/market-data.service';

// Phase C: 赛季中禁基金申购/赎回（快照净值赛公平性）
import { SeasonService } from '../season/season.service';

import { getFxRates } from '../../common/constants';

// NAV 以 CNY 计价，非 CN 账户按实时汇率折算申购/赎回
interface FundDefinition {
    id: string;
    name: string;
    type: string;
    nav: number;
    dailyReturn: number;
    subscribeFeeRate: number;
}

// Phase C: 赎回费档位（A股基金真实口径）：持有 <7 交易日 1.5% / 7-30 日 0.5% / ≥30 日 0
function redeemFeeRate(holdDays: number): number {
    const d = Math.max(0, Number(holdDays) || 0);
    if (d < 7)
        return 0.015;
    if (d < 30)
        return 0.005;
    return 0;
}

// P0 修复（赎回舍入）：到账金额只向「分」结算，且只取「对平台不亏、对用户不占便宜」的一侧（向下取整）。
// 四舍五入会把 0.005 份（净值 1.0，应值 0.005）白送成 0.01，用户可用细分份额反复赎回印钱；
// toFixed(6) 仅用于抹掉浮点噪声（如 98.5*100=9849.999999999998），不改变真实的分以下数值
function floorToCent(value: number): number {
    const v = Number(value);
    if (!Number.isFinite(v))
        return 0;
    return Math.floor(Number((v * 100).toFixed(6))) / 100;
}

@Injectable()
export class FundService implements OnModuleInit {
    private readonly logger = new Logger(FundService.name);
    private readonly funds: FundDefinition[];

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(FundHolding) private readonly holdingRepo: Repository<FundHolding>,
        private readonly engine: TradingEngineService,
        private readonly marketData: MarketDataService,
        private readonly seasonService: SeasonService,
        // P0 修复（事务）：注入 DataSource 用于「账户现金 + 基金持仓」原子写；
        // 声明为可选参数，兼容既有单测的 5 参构造（无 DataSource 时退化为顺序写库）
        @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
        // Phase 14 P0 修复（重启市值缩水）：净值表 repo，用于启动回填 + 定时落库。
        // 与 DataSource 同样声明为可选且置于参数末尾，兼容既有单测的 5/6 参构造（缺 repo 时跳过持久化）
        @Optional() @InjectRepository(FundNav) private readonly fundNavRepo?: Repository<FundNav>,
    ) {
        this.funds = [
            // Phase C: 增加申购费率（ETF 0.15%、货基 0）；NAV 保持稳健上涨（不可跌——防重开"重置/赎回"套利窗口，teams 风控红线）
            { id: 'fund-1', name: '沪深300 ETF', type: 'ETF', nav: 4.5, dailyReturn: 0.001, subscribeFeeRate: 0.0015 },
            { id: 'fund-2', name: '货币基金 A', type: '货币基金', nav: 1.0, dailyReturn: 0.0001, subscribeFeeRate: 0 },
        ];
        // FIX(M6): 定期更新基金净值（模拟净值波动）；unref 防止测试进程被定时器挂住
        // Phase 14: updateNavs 变异步（含落库），回调补 catch 防未处理拒绝（落库失败已在内部降级为 error 日志）
        const navTimer = setInterval(() => {
            void this.updateNavs().catch((e) => this.logger.error(`基金净值更新异常: ${(e && e.message) ? e.message : e}`));
        }, 60 * 1000);
        if (navTimer && typeof navTimer.unref === 'function')
            navTimer.unref();
    }

    // Phase 14 P0 修复（重启市值缩水）：启动时用库里的净值回填内存 NAV。
    // 只覆盖已存在的 fundId、且只接受有限正数（脏数据忽略并 warn）；读库失败 catch + warn，绝不影响启动
    async onModuleInit() {
        const repo = this.fundNavRepo;
        if (!repo) {
            // 未注入 repo（既有 5/6 参单测构造、极端降级）：跳过持久化，功能仍可用，但重启会回到内存初值
            this.logger.warn('未注入 FundNav 仓库，基金净值持久化已跳过（重启后 NAV 会回到初值）');
            return;
        }
        let rows: FundNav[] = [];
        try {
            rows = (await repo.find()) || [];
        }
        catch (e) {
            this.logger.warn('读取基金净值失败，沿用内存初值: ' + ((e && e.message) ? e.message : e));
            return;
        }
        const present = new Set<string>();
        for (const row of rows) {
            const fund = this.funds.find((f) => f.id === (row && row.fundId));
            // 库里有内存不认识的 fundId（历史遗留/下线基金）：忽略，避免污染内存口径
            if (!fund)
                continue;
            present.add(fund.id);
            const nav = Number(row.nav);
            if (!Number.isFinite(nav) || nav <= 0) {
                this.logger.warn(`基金 ${fund.id} 库中净值非法（${row.nav}），已忽略并沿用内存初值 ${fund.nav}`);
                continue;
            }
            fund.nav = nav;
        }
        // 首启（fund_navs 为空）或后续新增基金：用内存初值补一次基线，保证下次重启有值可回填；
        // 已有行（含脏值行）不在此覆盖，交给下个落库周期修正
        for (const fund of this.funds) {
            if (!present.has(fund.id))
                await this.persistNav(fund, '初始化基线');
        }
    }

    getFunds() {
        return this.funds;
    }

    getFund(id: string) {
        return this.funds.find((f) => f.id === id);
    }

    gameDay(): number {
        return Number((this.marketData && this.marketData.gameDay) || 0);
    }

    // Phase C: 币种折算——基金 NAV 以 CNY 计价，非 CN 账户按实时汇率折算申购/赎回
    toCny(amount: number, mode: string): number {
        if (mode === 'CN')
            return Number(amount);
        const fx = getFxRates();
        return Number(amount) * (Number(fx[mode]) || 1);
    }

    fromCny(cny: number, mode: string): number {
        if (mode === 'CN')
            return Number(cny);
        const fx = getFxRates();
        return Number(cny) / (Number(fx[mode]) || 1);
    }

    async subscribe(userId: string, mode: string, fundId: string, rawAmount: number) {
        // P0 修复（舍入套利）：金额先规范化到「分」，扣款与份额必须基于同一个 amount。
        // 旧实现按请求原始值（如 0.014）算份额、却只按 Math.round 扣 0.01，循环调用可抽干现金（等价印钱）
        const amount = Math.round(Number(rawAmount) * 100) / 100;
        // SECURITY: Number('abc')=NaN 会绕过 NaN<=0 的判断并永久损坏 account.cash，必须先校验有限性
        if (!Number.isFinite(amount) || amount <= 0) {
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
            if (Number(account.cash) < amount)
                return { success: false, error: '账户余额不足' };
            // 事务前算好计价口径（汇率/费率/份额），事务内只写库，避免事务内重读与队列互斥语义冲突
            const cny = this.toCny(amount, mode || 'US');
            const fee = cny * (Number(fund.subscribeFeeRate) || 0);
            const shares = (cny - fee) / fund.nav;
            account.cash = Math.round((Number(account.cash) - amount) * 100) / 100;
            // FIX(H5): 份额落库，重启不丢失
            let holding = await this.holdingRepo.findOne({ where: { userId, marketMode: mode || 'US', fundId } });
            if (!holding) {
                holding = this.holdingRepo.create({ userId, marketMode: mode || 'US', fundId, shares: 0, totalInvested: 0, firstBuyDay: this.gameDay() });
            }
            holding.shares = Number(holding.shares) + shares;
            // Phase C 重构前口径：totalInvested 记本币 amt，与 CNY 计价的 shares/nav 不一致 → 统一按 CNY 累计
            holding.totalInvested = Number(holding.totalInvested) + cny;
            if (Number(holding.firstBuyDay || 0) <= 0)
                holding.firstBuyDay = this.gameDay();
            // P0 修复（事务）：现金扣减与份额落库放同一事务，中途崩溃不再出现「钱已扣、份额未记」
            await this.persistFundMutation(account, holding);
            this.logger.log(`用户 ${userId} 申购 ${fund.name} ${shares.toFixed(4)} 份 (${mode || 'US'} ${amount.toFixed(2)}，申购费 ${this.fromCny(fee, mode || 'US').toFixed(2)})`);
            return { success: true, shares: Number(shares.toFixed(4)), nav: fund.nav, fee: Number(this.fromCny(fee, mode || 'US').toFixed(2)) };
        });
    }

    async redeem(userId: string, mode: string, fundId: string, rawShares: number) {
        // P0 修复（赎回舍入）：份额先规范化到 4 位小数（与持仓展示/日志同精度），份额扣减与到账金额同源，
        // 避免旧实现按请求原始精度计价、金额另行舍入造成的反向套利（0.005 份 → 到账 0.01）
        const sh = Math.round(Number(rawShares) * 10000) / 10000;
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
            // P0 修复（金额取整方向）：本币到账额按「分」结算，只取对平台不亏的一侧（向下取整）
            const amount = floorToCent(this.fromCny(cnyValue, mode || 'US'));
            // 不足 1 分不予赎回：否则用户份额被扣而到账 0，构成反向吃亏
            if (amount <= 0)
                return { success: false, error: '赎回金额不足0.01，无法赎回' };
            account.cash = Math.round((Number(account.cash) + amount) * 100) / 100;
            holding.shares = Number(holding.shares) - sh;
            // P0 修复（事务）：现金增加与份额扣减（或清仓删行）必须同一事务，中途崩溃不再凭空造钱
            await this.persistFundMutation(account, holding, Number(holding.shares) <= 0);
            this.logger.log(`用户 ${userId} 赎回 ${fund.name} ${sh.toFixed(4)} 份 (${mode || 'US'} ${amount.toFixed(2)}，持有 ${holdDays} 日，赎回费 ${(feeRate * 100).toFixed(1)}%)`);
            return { success: true, amount: Number(amount.toFixed(2)), nav: fund.nav, holdDays, feeRate };
        });
    }

    // P0 修复（事务）：把「账户现金 + 基金持仓」两次写库收敛到同一个数据库事务，
    // 消除「先写 account 再写 holding」中间崩溃导致的资金/份额不一致（申购丢份额、赎回凭空造钱）。
    // 抽成独立小方法，便于单测注入 fake DataSource 断言事务边界。
    private async persistFundMutation(account: Account, holding: FundHolding, removeHolding = false) {
        const ds = this.dataSource;
        // 事务内只做写：nav/份额/汇率已在事务前算好，不在事务内重读账户或持仓
        if (ds && typeof ds.transaction === 'function') {
            await ds.transaction(async (mgr) => {
                await mgr.save(account);
                if (removeHolding)
                    await mgr.delete(FundHolding, holding.id);
                else
                    await mgr.save(holding);
            });
            return;
        }
        // 未注入 DataSource（纯单测/极端降级）：保持旧的顺序写库语义，功能可用
        await this.accountRepo.save(account);
        if (removeHolding)
            await this.holdingRepo.delete(holding.id);
        else
            await this.holdingRepo.save(holding);
    }

    updateNavs() {
        // 红线（teams 风控）：NAV 只涨不跌——change ≥ 0，公式与随机项分布保持不变
        for (const fund of this.funds) {
            const change = fund.nav * fund.dailyReturn * (Math.random() * 2);
            fund.nav = Number((fund.nav + change).toFixed(4));
        }
        // Phase 14 P0 修复（重启市值缩水）：新 NAV 立即落库 upsert（fundId 主键 → save 天然幂等）。
        // 内存 NAV 先整体推进再落库：保持既有同步可见性，且落库失败绝不阻塞行情（persistNav 内部只记 error）
        return Promise.all(this.funds.map((fund) => this.persistNav(fund, '定时落库'))).then(() => undefined);
    }

    // Phase 14: 把某只基金的当前 NAV 落库（repo.save({ fundId, nav })，主键冲突即更新）。
    // 落库失败只 logger.error、不向上抛：NAV 是内存行情态，不能因 DB 抖动中断行情或启动
    private async persistNav(fund: FundDefinition, scene: string) {
        const repo = this.fundNavRepo;
        if (!repo)
            return; // 未注入 repo：跳过持久化（onModuleInit 已 warn 过一次，避免定时器周期刷日志）
        try {
            await repo.save({ fundId: fund.id, nav: fund.nav });
        }
        catch (e) {
            this.logger.error(`基金净值落库失败（${scene}）${fund.id}=${fund.nav}: ` + ((e && e.message) ? e.message : e));
        }
    }
}
