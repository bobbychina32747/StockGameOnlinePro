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

import ranking_service_1 = require("./ranking.service");

let RankingController = class RankingController {
    [key: string]: any;
    constructor(rankingService) {
        this.rankingService = rankingService;
    }
    getRankings(limit, sort, market) {
        return this.rankingService.getRankings(limit || 20, sort || 'totalReturn', market || 'ALL');
    }
};
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Query)('limit')),
    __param(1, (0, common_1.Query)('sort')),
    __param(2, (0, common_1.Query)('market')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Number]),
    __metadata("design:returntype", void 0)
], RankingController.prototype, "getRankings", null);

export { RankingController };

RankingController = __decorate(
[
    (0, common_1.Controller)('ranking'),
    // SECURITY(F): 排行榜需登录后才能访问（防止未认证访问用户排行数据）
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [ranking_service_1.RankingService])
],
RankingController
);

