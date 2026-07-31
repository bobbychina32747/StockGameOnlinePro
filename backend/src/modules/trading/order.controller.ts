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

import class_validator_1 = require("class-validator");

import jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import order_service_1 = require("./order.service");

import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

class PlaceOrderDto {
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(1),
    __metadata("design:type", String)
], PlaceOrderDto.prototype, "symbol", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(order_entity_1.OrderType),
    __metadata("design:type", String)
], PlaceOrderDto.prototype, "type", void 0);
__decorate([
    (0, class_validator_1.IsEnum)(order_entity_1.OrderSide),
    __metadata("design:type", String)
], PlaceOrderDto.prototype, "side", void 0);
__decorate([
    (0, class_validator_1.IsInt)(),
    (0, class_validator_1.Min)(1),
    __metadata("design:type", Number)
], PlaceOrderDto.prototype, "quantity", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], PlaceOrderDto.prototype, "price", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsNumber)(),
    __metadata("design:type", Number)
], PlaceOrderDto.prototype, "triggerPrice", void 0);
let OrderController = class OrderController {
    [key: string]: any;
    constructor(orderService) {
        this.orderService = orderService;
    }
    placeOrder(user, dto, mode) {
        return this.orderService.placeOrder(user.id, mode || 'US', dto.symbol, dto.type, dto.side, dto.quantity, dto.price, dto.triggerPrice);
    }
    cancelOrder(user, id, mode) {
        return this.orderService.cancelOrder(user.id, id, mode || 'US');
    }
    getPending(user, mode) {
        return this.orderService.getPendingOrders(user.id, mode || 'US');
    }
    getHistory(user, mode) {
        return this.orderService.getHistory(user.id, mode || 'US');
    }
};
__decorate([
    (0, common_1.Post)('order'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, PlaceOrderDto, String]),
    __metadata("design:returntype", void 0)
], OrderController.prototype, "placeOrder", null);
__decorate([
    (0, common_1.Delete)('order/:id'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, String]),
    __metadata("design:returntype", void 0)
], OrderController.prototype, "cancelOrder", null);
__decorate([
    (0, common_1.Get)('orders/pending'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String]),
    __metadata("design:returntype", void 0)
], OrderController.prototype, "getPending", null);
__decorate([
    (0, common_1.Get)('history'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String]),
    __metadata("design:returntype", void 0)
], OrderController.prototype, "getHistory", null);

export { OrderController };

OrderController = __decorate(
[
    (0, common_1.Controller)('trading'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [order_service_1.OrderService])
],
OrderController
);

