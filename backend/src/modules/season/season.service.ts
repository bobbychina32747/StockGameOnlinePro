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
            const settled = await this.seasonRepo.find({ order: { seq: 'DESC' }, take: 1 });
            const seq = (settled.length ? Number(settled[0].seq) : 0) + 1;
            season = await this.seasonRepo.save(this.seasonRepo.create({
                seq,
                name: `第 ${seq} 赛季`,
                status: season_entity_1.SeasonStatus.ENROLLING,
                anchorDay: '{}',
                durationDays: 10,
            }));
            this.logger.log(`🏆 新赛季开启: 第 ${seq} 赛季（报名中）`);
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
        return { success: true, season: { id: season.id, seq: season.seq, name: season.name, status: season.status, anchorDay: JSON.parse(season.anchorDay), durationDays: season.durationDays }, entries: entries.map((e) => e.id), created };
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
            season: { id: season.id, seq: season.seq, name: season.name, status: season.status, anchorDay: anchor, durationDays: season.durationDays, daysLeft },
            enrolled: entries.length > 0,
            myReturn,
            myRank,
        };
    }
    // 结算：active 报名固化 finalEquity/finalReturn/排名；前三 tierScore +300/200/100；幂等（RUNNING 才执行，串行锁防并发）
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
        // 前三 tierScore 奖励（荣誉体系，不印钱）
        const rewards = [300, 200, 100];
        for (let i = 0; i < Math.min(3, ranking.length); i++) {
            const accounts = await this.accountRepo.find({ where: { userId: ranking[i].userId } });
            for (const account of accounts) {
                account.tierScore = Number(account.tierScore || 0) + rewards[i];
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
            out.push({ seq: s.seq, name: s.name, settledAt: s.settledAt, champions: uniq });
        }
        return out;
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
