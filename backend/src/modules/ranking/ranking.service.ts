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

import daily_snapshot_entity_1 = require("../../infrastructure/database/entities/daily-snapshot.entity");

let RankingService = class RankingService {
    [key: string]: any;
    constructor(accountRepo, snapshotRepo) {
        this.accountRepo = accountRepo;
        this.snapshotRepo = snapshotRepo;
        this.logger = new common_1.Logger(RankingService.name);
        this.cache = [];
    }
    async calculateRankings() {
        const accounts = await this.accountRepo.find({ relations: ['user'] });
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
        const dayReturnFallback = (userId) => {
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
            .map((a) => ({
            // cache 内部保留 userId 供 getUserRank 查询，对外输出时在 getRankings 中剔除
            userId: a.userId,
            market: a.marketMode || 'CN',
            tier: a.tier || '青铜',
            username: a.user?.username || '未知',
            totalEquity: Number(a.totalEquity),
            totalReturn: (Number(a.totalEquity) - Number(a.initialEquity)) / Number(a.initialEquity),
            // FIX(F): 今日盈亏按账户计算（accountId 维度，dayStartEquity 为该账户当日基准），
            // 避免多市场账户共用同一 userId 快照导致跨账户混算
            dayReturn: Number(a.dayStartEquity) > 0
                ? (Number(a.totalEquity) - Number(a.dayStartEquity)) / Number(a.dayStartEquity)
                : dayReturnFallback(a.userId),
            rank: 0,
        }))
            .sort((a, b) => b.totalReturn - a.totalReturn)
            .map((e, i) => ({ ...e, rank: i + 1 }));
        this.cache = entries;
        return entries;
    }
    // 三服务器排行：market=ALL 跨服总榜；CN/HK/US 服内榜
    getRankings(limit = 20, sort = 'totalReturn', market = 'ALL') {
        // sort: totalReturn(总收益) | dayReturn(今日) | equity(总资产)
        // SECURITY(F): limit 钳制到 1..50，非法值回退 20
        const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
        const key = sort === 'dayReturn' ? 'dayReturn' : sort === 'equity' ? 'equity' : 'totalReturn';
        const list = market && market !== 'ALL'
            ? this.cache.filter((e) => e.market === market)
            : this.cache;
        // SECURITY(F): 输出剔除 userId，并对 username 脱敏（保留前 2 个字符，其余用 *）
        const maskUsername = (name) => {
            const chars = Array.from(name || '未知');
            return chars.length <= 2 ? chars.join('') : chars.slice(0, 2).join('') + '*'.repeat(chars.length - 2);
        };
        return [...list]
            .sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0))
            .slice(0, n)
            .map((e) => ({
            market: e.market,
            tier: e.tier,
            username: maskUsername(e.username),
            totalEquity: e.totalEquity,
            totalReturn: e.totalReturn,
            dayReturn: e.dayReturn,
            rank: e.rank,
        }));
    }
    getUserRank(userId) {
        return this.cache.find((e) => e.userId === userId);
    }
};

export { RankingService };

RankingService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(daily_snapshot_entity_1.DailySnapshot)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository])
],
RankingService
);

