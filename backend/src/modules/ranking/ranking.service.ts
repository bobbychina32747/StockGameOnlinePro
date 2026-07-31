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
        const entries = accounts
            .filter((a) => Number(a.initialEquity) > 0)
            .map((a) => ({
            userId: a.userId,
            username: a.user?.username || '未知',
            totalEquity: Number(a.totalEquity),
            totalReturn: (Number(a.totalEquity) - Number(a.initialEquity)) / Number(a.initialEquity),
            rank: 0,
        }))
            .sort((a, b) => b.totalReturn - a.totalReturn)
            .map((e, i) => ({ ...e, rank: i + 1 }));
        this.cache = entries;
        return entries;
    }
    getRankings(limit = 20) {
        return this.cache.slice(0, limit);
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

