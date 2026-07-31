var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import position_entity_1 = require("../../infrastructure/database/entities/position.entity");

import account_controller_1 = require("./account.controller");

import account_service_1 = require("./account.service");

let AccountModule = class AccountModule {
    [key: string]: any;
};

export { AccountModule };

AccountModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([account_entity_1.Account, position_entity_1.Position])],
        controllers: [account_controller_1.AccountController],
        providers: [account_service_1.AccountService],
        exports: [account_service_1.AccountService],
    })
],
AccountModule
);

