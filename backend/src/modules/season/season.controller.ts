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

import jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import season_service_1 = require("./season.service");

let SeasonController = class SeasonController {
    [key: string]: any;
    constructor(seasonService) {
        this.seasonService = seasonService;
    }
    enroll(user) {
        return this.seasonService.enroll(user.id);
    }
    current(user) {
        return this.seasonService.myStatus(user.id);
    }
    leaderboard(market = 'ALL', limit) {
        return this.seasonService.leaderboard(null, market, limit);
    }
    history() {
        return this.seasonService.history();
    }
    // Phase E V2: 赛程日历 / 战绩档案 / 赛季积分榜
    schedule(count) {
        return this.seasonService.schedule(count);
    }
    archive(user, seasonId) {
        return this.seasonService.archive(seasonId, user.id);
    }
    points(limit) {
        return this.seasonService.points(limit);
    }
};
__decorate([
    (0, common_1.Post)('enroll'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User]),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "enroll", null);
__decorate([
    (0, common_1.Get)('current'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User]),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "current", null);
__decorate([
    (0, common_1.Get)('leaderboard'),
    __param(0, (0, common_1.Query)('market')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Number]),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "leaderboard", null);
__decorate([
    (0, common_1.Get)('history'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "history", null);
__decorate([
    (0, common_1.Get)('schedule'),
    __param(0, (0, common_1.Query)('count')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "schedule", null);
__decorate([
    (0, common_1.Get)('archive/:seasonId'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('seasonId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String]),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "archive", null);
__decorate([
    (0, common_1.Get)('points'),
    __param(0, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", Promise)
], SeasonController.prototype, "points", null);

export { SeasonController };

SeasonController = __decorate(
[
    (0, common_1.Controller)('season'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [season_service_1.SeasonService])
],
SeasonController
);
