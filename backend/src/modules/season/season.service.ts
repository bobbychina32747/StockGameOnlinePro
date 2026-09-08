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

import season_entity_1 = require("../../infrastructure/database/entities/season.entity");

import season_entry_entity_1 = require("../../infrastructure/database/entities/season-entry.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

// Phase C: 模拟大赛 V1（快照净值赛 MVP：10 游戏日滚动赛季、手动报名、收益率排序、荣誉奖励、赛季中禁重置/划转/基金）
// 行情引擎注入：默认 CN 实例 + HK/US 字符串 token（与 market-data.module 工厂一致）
import market_data_service_1 = require("../../core/market-data/market-data.service");

// Phase E: 赛季类型轮换表（teams 定稿顺序 biweekly→monthly→weekly：跨度变化可感知、避免连续短赛疲劳；
// 首位 biweekly 保证改造后首个新赛季仍为现口径 10 游戏日，线上无跳变）
const SEASON_TYPE_CYCLE = ['biweekly', 'monthly', 'weekly'];
const TYPE_DURATION_DAYS = { weekly: 5, biweekly: 10, monthly: 20 };
let SeasonService = class SeasonService {
    [key: string]: any;
    constructor(seasonRepo, entryRepo, accountRepo, marketData, marketDataHK, marketDataUS) {
        this.seasonRepo = seasonRepo;
        this.entryRepo = entryRepo;
        this.accountRepo = accountRepo;
        this.marketData = marketData;
        this.marketDataHK = marketDataHK;
        this.marketDataUS = marketDataUS;
        this.logger = new common_1.Logger(SeasonService.name);
        // 防并发结算：单进程串行锁（与结算队列同理）
        this.settleChain = Promise.resolve();
    }
    gameDays() {
        return {
            CN: Number((this.marketData && this.marketData.gameDay) || 0),
            HK: Number((this.marketDataHK && this.marketDataHK.gameDay) || 0),
            US: Number((this.marketDataUS && this.marketDataUS.gameDay) || 0),
        };
    }
    async ensureSeason() {
        let season = await this.seasonRepo.findOne({
            where: [{ status: season_entity_1.SeasonStatus.ENROLLING }, { status: season_entity_1.SeasonStatus.RUNNING }],
        });
        if (!season) {
            const settled = await this.seasonRepo.find({ where: { status: season_entity_1.SeasonStatus.SETTLED } });
            settled.sort((a, b) => Number(b.seq) - Number(a.seq)); // fakeRepo 无 order 支持 → 服务内排序
            const seq = (settled.length ? Number(settled[0].seq) : 0) + 1;
            // Phase E: type 轮换决定 durationDays（durationDays 列保留供读侧零改动）
            const type = SEASON_TYPE_CYCLE[(seq - 1) % SEASON_TYPE_CYCLE.length];
            season = await this.seasonRepo.save(this.seasonRepo.create({
                seq,
                name: `第 ${seq} 赛季`,
                status: season_entity_1.SeasonStatus.ENROLLING,
                anchorDay: '{}',
                type,
                durationDays: TYPE_DURATION_DAYS[type],
            }));
            this.logger.log(`🏆 新赛季开启: 第 ${seq} 赛季（${type}，${TYPE_DURATION_DAYS[type]} 游戏日）`);
        }
        return season;
    }
    async getCurrentSeason() {
        return this.ensureSeason();
    }
    // 报名：报名窗口（enrolling）内一键报名，三市场账户同时参赛；首个报名者触发开赛（anchorDay=当前各市场 gameDay）
    async enroll(userId) {
        const season = await this.ensureSeason();
        if (season.status !== season_entity_1.SeasonStatus.ENROLLING) {
            return { success: false, error: '当前赛季已开赛，报名已截止' };
        }
        const accounts = await this.accountRepo.find({ where: { userId } });
        const gameDays = this.gameDays();
        let created = 0;
        const entries = [];
        for (const account of accounts) {
            const mode = account.marketMode || 'CN';
            const existing = await this.entryRepo.findOne({ where: { seasonId: season.id, accountId: account.id } });
            if (existing) {
                entries.push(existing);
                continue;
            }
            const entry = await this.entryRepo.save(this.entryRepo.create({
                seasonId: season.id,
                userId,
                accountId: account.id,
                marketMode: mode,
                startEquity: Number(account.totalEquity),
                startDay: Number(account.currentDay) || gameDays[mode] || 0,
                status: season_entry_entity_1.EntryStatus.ACTIVE,
            }));
            entries.push(entry);
            created++;
        }
        if (entries.length === 0) {
            return { success: false, error: '账户不存在，无法报名' };
        }
        // 首个报名者触发开赛（anchorDay 定格各市场当前 gameDay）
        if (season.status === season_entity_1.SeasonStatus.ENROLLING) {
            season.status = season_entity_1.SeasonStatus.RUNNING;
            season.anchorDay = JSON.stringify(gameDays);
            await this.seasonRepo.save(season);
            this.logger.log(`🏆 ${season.name} 开赛（anchorDay=${season.anchorDay}，${season.durationDays} 游戏日）`);
        }
        return { success: true, season: { id: season.id, seq: season.seq, name: season.name, type: season.type, status: season.status, anchorDay: JSON.parse(season.anchorDay), durationDays: season.durationDays }, entries: entries.map((e) => e.id), created };
    }
    // 赛季中禁重置/划转/基金（MVP 一刀切：有 active 报名的用户在 RUNNING 赛季中冻结这三项）
    async isBlocked(userId) {
        const season = await this.seasonRepo.findOne({ where: { status: season_entity_1.SeasonStatus.RUNNING } });
        if (!season)
            return false;
        const entries = await this.entryRepo.find({ where: { seasonId: season.id, userId, status: season_entry_entity_1.EntryStatus.ACTIVE } });
        return entries.length > 0;
    }
    // 实时榜单：报名快照净值口径——合成收益率 = Σ(totalEquity-startEquity) / ΣstartEquity（本金差异免疫）
    async leaderboard(seasonId, market = 'ALL', limit = 20) {
        const season = seasonId ? await this.seasonRepo.findOne({ where: { id: seasonId } }) : await this.seasonRepo.findOne({ where: { status: season_entity_1.SeasonStatus.RUNNING } });
        if (!season)
            return [];
        const entries = await this.entryRepo.find({ where: { seasonId: season.id } });
        const byUser = new Map();
        for (const e of entries) {
            if (market !== 'ALL' && e.marketMode !== market)
                continue;
            if (!byUser.has(e.userId)) {
                byUser.set(e.userId, { userId: e.userId, startSum: 0, equitySum: 0 });
            }
            const row = byUser.get(e.userId);
            row.startSum += Number(e.startEquity);
            const account = await this.accountRepo.findOne({ where: { id: e.accountId } });
            row.equitySum += Number(account ? account.totalEquity : e.startEquity);
        }
        const rows = [...byUser.values()].map((r) => ({
            userId: r.userId,
            seasonReturn: r.startSum > 0 ? ((r.equitySum - r.startSum) / r.startSum) * 100 : 0,
            seasonPnl: Number((r.equitySum - r.startSum).toFixed(2)),
        })).sort((a, b) => b.seasonReturn - a.seasonReturn).slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100));
        return rows;
    }
    // 我的赛季信息（报名状态 + 实时收益）
    async myStatus(userId) {
        const season = await this.ensureSeason();
        const entries = await this.entryRepo.find({ where: { seasonId: season.id, userId } });
        const gameDays = this.gameDays();
        const anchor = JSON.parse(season.anchorDay || '{}');
        const daysLeft = season.status === season_entity_1.SeasonStatus.RUNNING
            ? Math.max(0, Number(season.durationDays) - Math.max(0, gameDays.CN - (anchor.CN || 0), gameDays.HK - (anchor.HK || 0), gameDays.US - (anchor.US || 0)))
            : null;
        let myReturn = null;
        let myRank = null;
        if (entries.length > 0) {
            const board = await this.leaderboard(season.id, 'ALL', 100);
            myRank = board.findIndex((r) => r.userId === userId);
            const mine = board[myRank];
            if (mine)
                myReturn = Number(mine.seasonReturn.toFixed(2));
            myRank = myRank >= 0 ? myRank + 1 : null;
        }
        return {
            season: { id: season.id, seq: season.seq, name: season.name, type: season.type, status: season.status, anchorDay: anchor, durationDays: season.durationDays, daysLeft },
            enrolled: entries.length > 0,
            myReturn,
            myRank,
        };
    }
    // 结算：active 报名固化 finalEquity/finalReturn/排名；前三 seasonPoints +300/200/100；幂等（RUNNING 才执行，串行锁防并发）
    // Phase E: 奖励改记 seasonPoints（荣誉积分独立列）——tierScore 由 computeTier 每日覆盖为段位分，
    // 双语义冲突见 phaseE 方案 01；积分按用户计一次，账户层三市场同额累加仅为 V1 记账语义兼容
    rewardFor(rank) {
        if (rank === 1)
            return { medal: 'gold', points: 300 };
        if (rank === 2)
            return { medal: 'silver', points: 200 };
        if (rank === 3)
            return { medal: 'bronze', points: 100 };
        return null; // 前三开外无奖励（archive/points 共用查表，防常量漂移）
    }
    async settleSeason() {
        const run = this.settleChain.then(() => this.settleSeasonInner());
        this.settleChain = run.then(() => undefined, () => undefined);
        return run;
    }
    async settleSeasonInner() {
        const season = await this.seasonRepo.findOne({ where: { status: season_entity_1.SeasonStatus.RUNNING } });
        if (!season)
            return { success: false, error: '无进行中的赛季' };
        const entries = await this.entryRepo.find({ where: { seasonId: season.id, status: season_entry_entity_1.EntryStatus.ACTIVE } });
        const byUser = new Map();
        for (const e of entries) {
            const account = await this.accountRepo.findOne({ where: { id: e.accountId } });
            e.finalEquity = Number(account ? account.totalEquity : e.startEquity);
            e.finalReturn = Number(e.startEquity) > 0 ? (Number(e.finalEquity) - Number(e.startEquity)) / Number(e.startEquity) : 0;
            e.status = season_entry_entity_1.EntryStatus.SETTLED;
            if (!byUser.has(e.userId)) {
                byUser.set(e.userId, { userId: e.userId, startSum: 0, equitySum: 0 });
            }
            const row = byUser.get(e.userId);
            row.startSum += Number(e.startEquity);
            row.equitySum += Number(e.finalEquity);
        }
        const ranking = [...byUser.values()]
            .map((r) => ({ userId: r.userId, ret: r.startSum > 0 ? (r.equitySum - r.startSum) / r.startSum : 0 }))
            .sort((a, b) => b.ret - a.ret);
        // 前三 seasonPoints 奖励（荣誉体系，不印钱；与 V1 一致：该用户全部市场账户同额累加）
        for (let i = 0; i < Math.min(3, ranking.length); i++) {
            const reward = this.rewardFor(i + 1);
            const accounts = await this.accountRepo.find({ where: { userId: ranking[i].userId } });
            for (const account of accounts) {
                account.seasonPoints = Number(account.seasonPoints || 0) + reward.points;
                await this.accountRepo.save(account);
            }
        }
        for (const e of entries) {
            const row = ranking.find((r) => r.userId === e.userId);
            e.finalRank = row ? ranking.indexOf(row) + 1 : null;
            await this.entryRepo.save(e);
        }
        season.status = season_entity_1.SeasonStatus.SETTLED;
        season.endedAt = new Date();
        season.settledAt = new Date();
        await this.seasonRepo.save(season);
        this.logger.log(`🏆 ${season.name} 结算完成：${ranking.length} 名选手，冠军 ${ranking[0] ? ranking[0].userId : '无'}（${ranking[0] ? (ranking[0].ret * 100).toFixed(2) : 0}%）`);
        return { success: true, season: { seq: season.seq, name: season.name }, top3: ranking.slice(0, 3).map((r) => ({ userId: r.userId, ret: Number((r.ret * 100).toFixed(2)) })) };
    }
    // 调度检查：任一市场 gameDay 跑满时长 → 结算 + 自动开新赛季
    async maybeSettleByClock() {
        const season = await this.seasonRepo.findOne({ where: { status: season_entity_1.SeasonStatus.RUNNING } });
        if (!season)
            return null;
        const gameDays = this.gameDays();
        const anchor = JSON.parse(season.anchorDay || '{}');
        const elapsed = Math.max(0, gameDays.CN - (anchor.CN || 0), gameDays.HK - (anchor.HK || 0), gameDays.US - (anchor.US || 0));
        if (elapsed >= Number(season.durationDays)) {
            const result = await this.settleSeason();
            await this.ensureSeason();
            return result;
        }
        return null;
    }
    async history() {
        const settled = await this.seasonRepo.find({ where: { status: season_entity_1.SeasonStatus.SETTLED }, order: { seq: 'DESC' }, take: 5 });
        const out = [];
        for (const s of settled) {
            const entries = await this.entryRepo.find({ where: { seasonId: s.id, status: season_entry_entity_1.EntryStatus.SETTLED } });
            const champs = entries.filter((e) => e.finalRank === 1).map((e) => ({ userId: e.userId, finalReturn: Number(e.finalReturn) * 100, finalRank: e.finalRank }));
            const uniq = [...new Map(champs.map((c) => [c.userId, c])).values()];
            out.push({ seq: s.seq, name: s.name, type: s.type, settledAt: s.settledAt, champions: uniq });
        }
        return out;
    }
    // Phase E V2: 赛程日历——DB 当前赛季（enrolling/running）+ 合成未来届（不落库）。
    // 时间语义：快档下游戏日与真实日历解耦，startDay 为相对今日的偏移（估算值，文档已注明）。
    // 注意：fakeRepo 无 order 支持 → 服务内显式按 seq 排序，勿依赖仓库层排序。
    async schedule(count = 6) {
        const gameDays = this.gameDays();
        const current = await this.seasonRepo.findOne({
            where: [{ status: season_entity_1.SeasonStatus.ENROLLING }, { status: season_entity_1.SeasonStatus.RUNNING }],
        });
        const out = [];
        let seq = 1;
        let nextStart = 0; // 下届 startDay（相对 today）
        if (current) {
            seq = Number(current.seq);
            const anchor = JSON.parse(current.anchorDay || '{}');
            const duration = Number(current.durationDays);
            const elapsed = current.status === season_entity_1.SeasonStatus.RUNNING
                ? Math.max(0, Number(gameDays.CN) - Number(anchor.CN || 0), Number(gameDays.HK) - Number(anchor.HK || 0), Number(gameDays.US) - Number(anchor.US || 0))
                : 0;
            out.push({
                seq, name: current.name, type: current.type, status: current.status,
                startDay: 0, durationDays: duration,
                daysLeft: current.status === 'running' ? Math.max(0, duration - elapsed) : null,
                anchorDay: current.status === 'running' ? anchor : null,
            });
            nextStart = Math.max(0, duration - elapsed);
        }
        else {
            const settled = await this.seasonRepo.find({ order: { seq: 'DESC' }, take: 1 });
            seq = settled.length ? Number(settled[0].seq) : 0;
        }
        const want = Math.max(0, Math.min(Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 6, 100) - out.length);
        for (let i = 0; i < want; i++) {
            seq += 1;
            const type = SEASON_TYPE_CYCLE[(seq - 1) % SEASON_TYPE_CYCLE.length];
            out.push({ seq, name: `第 ${seq} 赛季`, type, status: 'upcoming', startDay: nextStart, durationDays: TYPE_DURATION_DAYS[type], daysLeft: null });
            nextStart += TYPE_DURATION_DAYS[type];
        }
        return { today: gameDays, seasons: out };
    }
    // Phase E V2: 战绩档案——最小口径两点曲线（报名起点+结算终点；season_entries 无逐日净值、
    // daily_snapshots 无 accountId 无法归属账户，逐日曲线裁到 V3）；档案用结算时固化值，不回溯账户现值
    async archive(seasonId, userId) {
        const season = await this.seasonRepo.findOne({ where: { id: seasonId } });
        if (!season || season.status !== season_entity_1.SeasonStatus.SETTLED) {
            return { success: false, error: '赛季不存在或未结算' };
        }
        const entries = await this.entryRepo.find({ where: { seasonId: season.id, status: season_entry_entity_1.EntryStatus.SETTLED } });
        const byUser = new Map();
        for (const e of entries) {
            const row = byUser.get(e.userId) || { userId: e.userId, startSum: 0, equitySum: 0, bestRank: null };
            row.startSum += Number(e.startEquity);
            row.equitySum += Number(e.finalEquity);
            if (e.finalRank !== null && e.finalRank !== undefined && (row.bestRank === null || Number(e.finalRank) < Number(row.bestRank)))
                row.bestRank = Number(e.finalRank);
            byUser.set(e.userId, row);
        }
        const rows = [...byUser.values()]
            .map((r) => ({ userId: r.userId, startSum: r.startSum, equitySum: r.equitySum, ret: r.startSum > 0 ? (r.equitySum - r.startSum) / r.startSum : 0, bestRank: r.bestRank }))
            .sort((a, b) => b.ret - a.ret);
        const championRow = rows.length ? rows[0] : null;
        const champion = championRow ? { userId: championRow.userId, ret: Number((championRow.ret * 100).toFixed(2)) } : null;
        const toCurve = (row) => [
            { point: '报名', equity: Number(row.startSum.toFixed(2)) },
            { point: '结算', equity: Number(row.equitySum.toFixed(2)) },
        ];
        const championEntries = championRow ? entries.filter((e) => e.userId === championRow.userId).map((e) => ({ marketMode: e.marketMode, startEquity: Number(e.startEquity), finalEquity: Number(e.finalEquity), ret: Number((e.finalReturn || 0) * 100).toFixed(2) })) : null;
        let mine = null;
        const myRow = rows.find((r) => r.userId === userId);
        if (myRow) {
            const rank = rows.indexOf(myRow) + 1;
            const reward = this.rewardFor(rank);
            const myEntries = entries.filter((e) => e.userId === userId).map((e) => ({ marketMode: e.marketMode, startEquity: Number(e.startEquity), finalEquity: Number(e.finalEquity), ret: Number((e.finalReturn || 0) * 100).toFixed(2) }));
            mine = {
                rank,
                ret: Number((myRow.ret * 100).toFixed(2)),
                medal: reward ? reward.medal : null,
                points: reward ? reward.points : 0,
                curve: toCurve(myRow),
                entries: myEntries,
            };
        }
        return {
            success: true,
            season: { seq: season.seq, name: season.name, type: season.type, settledAt: season.settledAt, entriesCount: entries.length, champion },
            mine,
            championCurve: championRow ? { userId: championRow.userId, entries: championEntries, curve: toCurve(championRow) } : null,
        };
    }
    // Phase E V2: 赛季积分榜——用户级口径取 max(各账户 seasonPoints)（V1 结算对三市场账户同额累加，
    // sum 会把单场胜利计 ×3 失真）；consecutiveWins 由已结算 entries 推导（从最近一届往回数连续冠军）
    async points(limit = 20) {
        const settled = await this.seasonRepo.find({ where: { status: season_entity_1.SeasonStatus.SETTLED } });
        settled.sort((a, b) => Number(b.seq) - Number(a.seq)); // fakeRepo 无 order，服务内排序
        const users = new Set();
        const entryAll = [];
        for (const s of settled) {
            const es = await this.entryRepo.find({ where: { seasonId: s.id, status: season_entry_entity_1.EntryStatus.SETTLED } });
            for (const e of es) {
                users.add(e.userId);
                entryAll.push({ seasonSeq: Number(s.seq), userId: e.userId, finalRank: e.finalRank });
            }
        }
        const pointsByUser = new Map();
        for (const u of users) {
            // 逐用户查询（fake 天然支持等值 where，避免 In 兼容面扩散）
            const accounts = await this.accountRepo.find({ where: { userId: u } });
            pointsByUser.set(u, accounts.reduce((m, a) => Math.max(m, Number(a.seasonPoints || 0)), 0));
        }
        // consecutiveWins：按赛季 seq 降序推每个用户从最近一届往回数连续冠军届数，遇非冠军即断
        const bySeason = new Map();
        for (const e of entryAll) {
            const arr = bySeason.get(e.seasonSeq) || [];
            arr.push(e);
            bySeason.set(e.seasonSeq, arr);
        }
        const winsByUser = new Map();
        for (const u of users) {
            let wins = 0;
            for (const s of settled) { // settled 已按 seq 降序
                const es = bySeason.get(Number(s.seq)) || [];
                const mine = es.find((e) => e.userId === u);
                if (!mine)
                    continue; // 未参赛的届跳过（不打断连续夺冠）
                if (Number(mine.finalRank) === 1)
                    wins += 1;
                else
                    break;
            }
            winsByUser.set(u, wins);
        }
        const rows = [...users]
            .map((u) => ({ userId: u, points: pointsByUser.get(u) || 0, consecutiveWins: winsByUser.get(u) || 0 }))
            .sort((a, b) => b.points - a.points || b.consecutiveWins - a.consecutiveWins);
        return rows.slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100)).map((r, i) => ({ rank: i + 1, ...r }));
    }
};

export { SeasonService };

SeasonService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(season_entity_1.Season)),
    __param(1, (0, typeorm_1.InjectRepository)(season_entry_entity_1.SeasonEntry)),
    __param(2, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(3, (0, common_1.Inject)(market_data_service_1.MarketDataService)),
    __param(4, (0, common_1.Inject)('MarketDataHK')),
    __param(5, (0, common_1.Inject)('MarketDataUS')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        market_data_service_1.MarketDataService,
        market_data_service_1.MarketDataService,
        market_data_service_1.MarketDataService])
],
SeasonService
);
