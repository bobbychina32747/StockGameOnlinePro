var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import common_1 = require("@nestjs/common");

import ranking_service_1 = require("./ranking.service");

let RankingScheduler = class RankingScheduler {
    [key: string]: any;
    constructor(rankingService) {
        this.rankingService = rankingService;
        this.logger = new common_1.Logger(RankingScheduler.name);
        this.handle = null;
        this.handle = setInterval(async () => {
            await this.rankingService.calculateRankings();
            this.logger.log('排行榜已更新');
        }, 60 * 60 * 1000);
        setTimeout(() => this.rankingService.calculateRankings(), 10000);
    }
};

export { RankingScheduler };

RankingScheduler = __decorate(
[
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [ranking_service_1.RankingService])
],
RankingScheduler
);

