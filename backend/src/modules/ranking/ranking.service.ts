import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { DailySnapshot } from '../../infrastructure/database/entities/daily-snapshot.entity';
import { RiskManagerService } from '../../core/risk-manager/risk-manager.service';
import { computeLiveEquity } from '../../common/live-equity';

// 榜单缓存条目（内部保留 userId 供 getUserRank 查询，对外输出时在 getRankings 中剔除）
interface RankingEntry {
    userId: string;
    market: string;
    tier: string;
    username: string;
    totalEquity: number;
    totalReturn: number;
    dayReturn: number;
    rank: number;
    // Phase G-2: 机器人玩家标记（算法盘）——仅用于展示标识与运营统计，不影响名次与权限
    isBot: boolean;
}

@Injectable()
export class RankingService {
    private readonly logger = new Logger(RankingService.name);
    private cache: RankingEntry[] = [];

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(DailySnapshot) private readonly snapshotRepo: Repository<DailySnapshot>,
        // G-3: 实时价来源（RiskManagerService 是 @Global 模块导出的，注入不需要额外 imports）。
        // @Optional()：既有单测用 2 参构造 RankingService，缺它时退化为存量 totalEquity（行为与修复前一致）。
        @Optional() private readonly riskManager?: RiskManagerService,
    ) {}

    // G-3 修复：排行榜"赚钱了不显示"——原实现直接读 accounts.totalEquity，而该字段只在
    // ①开户 ②账户重置 ③**日终结算** 三处写库；两次日终之间（实时档约 4 小时）所有人的市值重估都不反映，
    // 于是刚买入并上涨的账户在榜上仍是 0.00%。现按最新价做市值重估（口径与日终结算一致，
    // 见 common/live-equity.ts）；日终落库的老口径保持不动（它仍是历史快照的来源）。
    private liveEquity(account: Account, positions: any[]): number | null {
        const prices = this.riskManager?.getCurrentPrices ? this.riskManager.getCurrentPrices() : null;
        return computeLiveEquity(account, positions, prices);
    }

    async calculateRankings() {
        // 'positions' 一并取出：实时市值重估需要持仓（一账户持仓数量级很小，join 成本可忽略）
        const accounts = await this.accountRepo.find({ relations: ['user', 'positions'] });
        // Q2 优化：只取每用户最近 2 天的快照（按 max(day) 裁剪），避免全量快照参与计算
        const snaps = await this.snapshotRepo.find({ order: { day: 'ASC' } });
        const byUser = new Map();
        for (const sn of snaps) {
            const arr = byUser.get(sn.userId) || [];
            arr.push(sn);
            byUser.set(sn.userId, arr);
        }
        byUser.forEach((arr, uid) => {
            if (arr.length > 0) {
                const maxDay = arr[arr.length - 1].day;
                byUser.set(uid, arr.filter((s) => Number(s.day) >= Number(maxDay) - 1));
            }
        });
        // 快照表只有 userId（无 accountId），多市场账户同一天有多条快照，按 userId 串算会跨账户混算，
        // 因此快照仅作为 dayStartEquity 缺失时的兜底
        const dayReturnFallback = (userId: string): number => {
            const arr = byUser.get(userId) || [];
            if (arr.length === 0)
                return 0;
            const last = arr[arr.length - 1];
            const prev = arr.length >= 2 ? arr[arr.length - 2] : null;
            if (prev && Number(prev.equity) > 0)
                return (Number(last.equity) - Number(prev.equity)) / Number(prev.equity);
            return Number(last.dailyReturn) || 0;
        };
        const entries = accounts
            .filter((a) => Number(a.initialEquity) > 0)
            .map((a) => {
            // G-3: 实时市值重估优先；估值不完整（行情未就绪/缺报价）时回退日终落库值
            const live = this.liveEquity(a, a.positions || []);
            const equity = live === null ? Number(a.totalEquity) : live;
            const initial = Number(a.initialEquity);
            const dayStart = Number(a.dayStartEquity);
            return {
                // cache 内部保留 userId 供 getUserRank 查询，对外输出时在 getRankings 中剔除
                userId: a.userId,
                market: a.marketMode || 'CN',
                tier: a.tier || '青铜',
                username: a.user?.username || '未知',
                totalEquity: equity,
                totalReturn: initial > 0 ? (equity - initial) / initial : 0,
                // FIX(F): 今日盈亏按账户计算（accountId 维度，dayStartEquity 为该账户当日基准），
                // 避免多市场账户共用同一 userId 快照导致跨账户混算
                dayReturn: dayStart > 0 ? (equity - dayStart) / dayStart : dayReturnFallback(a.userId),
                rank: 0,
                // Phase G-2: 机器人玩家与真人同榜竞技（同权限、同费率、同规则），此处只标记来源
                isBot: a.user?.isBot === true,
            };
        })
            .sort((a, b) => b.totalReturn - a.totalReturn)
            .map((e, i) => ({ ...e, rank: i + 1 }));
        this.cache = entries;
        return entries;
    }

    // 三服务器排行：market=ALL 跨服总榜；CN/HK/US 服内榜
    getRankings(limit: number = 20, sort: string = 'totalReturn', market: string = 'ALL') {
        // sort: totalReturn(总收益) | dayReturn(今日) | equity(总资产)
        // SECURITY(F): limit 钳制到 1..50，非法值回退 20
        const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
        // FIX(P1 排序)：条目真实字段名是 totalEquity，旧代码取 'equity' → (b[key] ?? 0) - (a[key] ?? 0) 恒为 0，
        // sort=equity 退化成 cache 原顺序（= 总收益率序）。本行 key 与真实字段对齐；dayReturn/totalReturn 分支不变。
        // 稳定性：Array#sort 自 V8 7.0 起稳定 → 同值保持 cache 内原次序（cache 按 totalReturn 降序生成），与改前一致
        const key = sort === 'dayReturn' ? 'dayReturn' : sort === 'equity' ? 'totalEquity' : 'totalReturn';
        const list = market && market !== 'ALL'
            ? this.cache.filter((e) => e.market === market)
            : this.cache;
        // SECURITY(F): 输出剔除 userId，并对 username 脱敏（保留前 2 个字符，其余用 *）
        const maskUsername = (name: string): string => {
            const chars = Array.from(name || '未知');
            return chars.length <= 2 ? chars.join('') : chars.slice(0, 2).join('') + '*'.repeat(chars.length - 2);
        };
        // Phase G-2: 机器人用**展示名**（去掉 bot_ 前缀，如 bot_alpha → Alpha）且不脱敏——
        // 脱敏是给真人隐私用的，机器人没有隐私；显示"Alpha/Beta 在榜上"才看得出是在和人机同台竞技。
        // 真人的展示名仍走 maskUsername（口径与改动前完全一致）。
        const displayName = (e: RankingEntry): string => {
            if (!e.isBot)
                return maskUsername(e.username);
            const raw = String(e.username || '').replace(/^bot_/, '');
            const name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : e.username;
            return name;
        };
        // 注：rank 仍是 cache 生成时的总收益率位次（不随 sort 重算）→ 按 equity/dayReturn 排序时，
        // 榜单先后与 rank 数字可能不一致（前端奖牌按 rank 渲染）；属既有语义，本次只修排序 key，rank 一致性问题另议
        return [...list]
            .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
            .slice(0, n)
            .map((e) => ({
            market: e.market,
            tier: e.tier,
            username: displayName(e),
            isBot: e.isBot,
            totalEquity: e.totalEquity,
            totalReturn: e.totalReturn,
            dayReturn: e.dayReturn,
            rank: e.rank,
        }));
    }

    // P3: 本方法返回内部缓存条目（含 userId 这类内部标识）。grep 确认当前无调用点（controller 只调 getRankings），
    // 故保留方法不改签名；将来若被控制器直接返回，须先裁剪成公开字段（去掉 userId）再输出
    getUserRank(userId: string) {
        return this.cache.find((e) => e.userId === userId);
    }
}
