var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import fund_holding_entity_1 = require("../../infrastructure/database/entities/fund-holding.entity");

import fund_controller_1 = require("./fund.controller");

import fund_service_1 = require("./fund.service");

let FundModule = class FundModule {
    [key: string]: any;
};

export { FundModule };

FundModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([account_entity_1.Account, fund_holding_entity_1.FundHolding])],
        controllers: [fund_controller_1.FundController],
        providers: [fund_service_1.FundService],
        exports: [fund_service_1.FundService],
    })
],
FundModule
);

