var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import daily_snapshot_entity_1 = require("../../infrastructure/database/entities/daily-snapshot.entity");

import ranking_controller_1 = require("./ranking.controller");

import ranking_service_1 = require("./ranking.service");

import ranking_scheduler_1 = require("./ranking.scheduler");

let RankingModule = class RankingModule {
    [key: string]: any;
};

export { RankingModule };

RankingModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([account_entity_1.Account, daily_snapshot_entity_1.DailySnapshot])],
        controllers: [ranking_controller_1.RankingController],
        providers: [ranking_service_1.RankingService, ranking_scheduler_1.RankingScheduler],
        exports: [ranking_service_1.RankingService],
    })
],
RankingModule
);

