var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import user_entity_1 = require("./entities/user.entity");

import account_entity_1 = require("./entities/account.entity");

import position_entity_1 = require("./entities/position.entity");

import order_entity_1 = require("./entities/order.entity");

import transaction_entity_1 = require("./entities/transaction.entity");

import kline_entity_1 = require("./entities/kline.entity");

import stock_entity_1 = require("./entities/stock.entity");

import daily_snapshot_entity_1 = require("./entities/daily-snapshot.entity");

import fund_holding_entity_1 = require("./entities/fund-holding.entity");

const entities = [
    user_entity_1.User, account_entity_1.Account, position_entity_1.Position, order_entity_1.Order,
    transaction_entity_1.Transaction, kline_entity_1.Kline, stock_entity_1.Stock, daily_snapshot_entity_1.DailySnapshot,
    fund_holding_entity_1.FundHolding,
];
let DatabaseModule = class DatabaseModule {
    [key: string]: any;
};

export { DatabaseModule };

DatabaseModule = __decorate(
[
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [typeorm_1.TypeOrmModule.forFeature(entities)],
        exports: [typeorm_1.TypeOrmModule],
    })
],
DatabaseModule
);

