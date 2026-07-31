var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

import admin_controller_1 = require("./admin.controller");

import admin_service_1 = require("./admin.service");

let AdminModule = class AdminModule {
    [key: string]: any;
};

export { AdminModule };

AdminModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([user_entity_1.User, account_entity_1.Account, order_entity_1.Order])],
        controllers: [admin_controller_1.AdminController],
        providers: [admin_service_1.AdminService],
        exports: [admin_service_1.AdminService],
    })
],
AdminModule
);

