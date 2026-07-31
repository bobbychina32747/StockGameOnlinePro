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

import jwt_auth_guard_1 = require("../../common/guards/jwt-auth.guard");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import fund_service_1 = require("./fund.service");

let FundController = class FundController {
    [key: string]: any;
    constructor(fundService) {
        this.fundService = fundService;
    }
    getFunds() {
        return this.fundService.getFunds();
    }
    getFund(id) {
        return this.fundService.getFund(id);
    }
    subscribe(user, id, amount, mode) {
        return this.fundService.subscribe(user.id, mode, id, amount);
    }
    redeem(user, id, shares, mode) {
        return this.fundService.redeem(user.id, mode, id, shares);
    }
};
__decorate([
    (0, common_1.Get)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], FundController.prototype, "getFunds", null);
__decorate([
    (0, common_1.Get)(':id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], FundController.prototype, "getFund", null);
__decorate([
    (0, common_1.Post)(':id/subscribe'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Query)('amount')),
    __param(3, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, Number, String]),
    __metadata("design:returntype", void 0)
], FundController.prototype, "subscribe", null);
__decorate([
    (0, common_1.Post)(':id/redeem'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Query)('shares')),
    __param(3, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, Number, String]),
    __metadata("design:returntype", void 0)
], FundController.prototype, "redeem", null);

export { FundController };

FundController = __decorate(
[
    (0, common_1.Controller)('fund'),
    __metadata("design:paramtypes", [fund_service_1.FundService])
],
FundController
);

