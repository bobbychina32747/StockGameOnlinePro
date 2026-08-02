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

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import position_entity_1 = require("../../infrastructure/database/entities/position.entity");

import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");

import trading_engine_service_1 = require("../../core/trading-engine/trading-engine.service");

import constants_1 = require("../../common/constants");

let OrderService = class OrderService {
    [key: string]: any;
    constructor(accountRepo, positionRepo, orderRepo, txRepo, engine, dataSource) {
        this.accountRepo = accountRepo;
        this.positionRepo = positionRepo;
        this.orderRepo = orderRepo;
        this.txRepo = txRepo;
        this.engine = engine;
        this.dataSource = dataSource;
        this.logger = new common_1.Logger(OrderService.name);
    }
    async placeOrder(userId, mode, symbol, type, side, quantity, price, triggerPrice) {
        // S2 休市校验：非交易时段拒绝下单
        if (!(0, constants_1.isTradingTimeNow)()) {
            throw new common_1.BadRequestException('休市中（交易时段 9:30-11:30 / 13:00-15:00），无法下单');
        }
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            throw new common_1.NotFoundException(`账户不存在（${mode}）`);
        if (account.marketMode === 'CN' && (side === order_entity_1.OrderSide.SHORT || side === order_entity_1.OrderSide.COVER)) {
            return { success: false, error: 'A股模式不支持做空/融券' };
        }
        const result = await this.engine.submitOrder({ userId, accountId: account.id, symbol, type, side, quantity, price, triggerPrice }, account);
        if (!result.success) {
            return { success: false, error: result.error };
        }
        if (type === order_entity_1.OrderType.MARKET) {
            // 统一走引擎结算（submitOrder 已撮合并返回 fill，避免二次撮合）
            return this.engine.settleFill(account.id, symbol, side, result.fill, account.marketMode);
        }
        return { success: true, order: result.order };
    }
    async cancelOrder(userId, orderId, mode) {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            throw new common_1.NotFoundException('账户不存在');
        const ok = await this.engine.cancelOrder(orderId, account.id);
        return { success: ok };
    }
    async getHistory(userId, mode) {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            return [];
        return this.txRepo.find({
            where: { accountId: account.id },
            order: { createdAt: 'DESC' },
            take: 100,
        });
    }
    async getPendingOrders(userId, mode) {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            return [];
        return this.engine.getPendingOrders(account.id);
    }
};

export { OrderService };

OrderService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(position_entity_1.Position)),
    __param(2, (0, typeorm_1.InjectRepository)(order_entity_1.Order)),
    __param(3, (0, typeorm_1.InjectRepository)(transaction_entity_1.Transaction)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        trading_engine_service_1.TradingEngineService,
        typeorm_2.DataSource])
],
OrderService
);

