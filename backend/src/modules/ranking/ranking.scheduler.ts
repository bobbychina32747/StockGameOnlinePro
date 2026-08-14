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
        this.initialHandle = null;
        // FIX(F): 回调内 try/catch，避免 promise 拒绝产生未处理异常并中断后续计算
        this.handle = setInterval(async () => {
            try {
                await this.rankingService.calculateRankings();
                this.logger.log('排行榜已更新');
            }
            catch (e) {
                this.logger.error('排行榜计算失败: ' + (e && e.message ? e.message : e));
            }
        }, 30 * 1000);
        this.initialHandle = setTimeout(async () => {
            try {
                await this.rankingService.calculateRankings();
            }
            catch (e) {
                this.logger.error('排行榜初始化计算失败: ' + (e && e.message ? e.message : e));
            }
        }, 10000);
    }
    // FIX(F): 模块销毁时清理定时器，避免泄漏与重复计算
    onModuleDestroy() {
        if (this.handle) {
            clearInterval(this.handle);
            this.handle = null;
        }
        if (this.initialHandle) {
            clearTimeout(this.initialHandle);
            this.initialHandle = null;
        }
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

