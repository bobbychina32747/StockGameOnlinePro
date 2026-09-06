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

import season_service_1 = require("./season.service");

// Phase C: 赛季调度——30s 轮询游戏日推进，任一市场跑满时长即结算并自动开新赛季
let SeasonScheduler = class SeasonScheduler {
    [key: string]: any;
    constructor(seasonService) {
        this.seasonService = seasonService;
        this.logger = new common_1.Logger(SeasonScheduler.name);
    }
    onModuleInit() {
        // 启动即确保存在报名中赛季
        this.seasonService.ensureSeason().catch((e) => this.logger.warn('赛季初始化失败: ' + (e && e.message ? e.message : e)));
        this.timer = setInterval(async () => {
            try {
                await this.seasonService.maybeSettleByClock();
            }
            catch (e) {
                this.logger.warn('赛季调度异常: ' + (e && e.message ? e.message : e));
            }
        }, 30000);
    }
    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
    }
};

export { SeasonScheduler };

SeasonScheduler = __decorate(
[
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [season_service_1.SeasonService])
],
SeasonScheduler
);
