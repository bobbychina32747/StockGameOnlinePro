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

import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");

import order_controller_1 = require("./order.controller");

import order_service_1 = require("./order.service");

let TradingModule = class TradingModule {
    [key: string]: any;
};

export { TradingModule };

TradingModule = __decorate(
[
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature([account_entity_1.Account, position_entity_1.Position, order_entity_1.Order, transaction_entity_1.Transaction])],
        controllers: [order_controller_1.OrderController],
        providers: [order_service_1.OrderService],
        exports: [order_service_1.OrderService],
    })
],
TradingModule
);

