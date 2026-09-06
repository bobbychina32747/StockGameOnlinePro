var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import season_entity_1 = require("../../infrastructure/database/entities/season.entity");

import season_entry_entity_1 = require("../../infrastructure/database/entities/season-entry.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import season_service_1 = require("./season.service");

import season_controller_1 = require("./season.controller");

import season_scheduler_1 = require("./season.scheduler");

let SeasonModule = class SeasonModule {
    [key: string]: any;
};

export { SeasonModule };

SeasonModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([season_entity_1.Season, season_entry_entity_1.SeasonEntry, account_entity_1.Account])],
        controllers: [season_controller_1.SeasonController],
        providers: [season_service_1.SeasonService, season_scheduler_1.SeasonScheduler],
        exports: [season_service_1.SeasonService],
    })
],
SeasonModule
);
