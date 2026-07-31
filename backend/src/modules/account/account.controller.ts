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

import account_service_1 = require("./account.service");

let AccountController = class AccountController {
    [key: string]: any;
    constructor(accountService) {
        this.accountService = accountService;
    }
    async getAccount(user, mode = 'US') {
        const account = await this.accountService.getAccount(user.id, mode);
        const positions = await this.accountService.getPositions(account.id);
        return { account, positions };
    }
    async getMetrics(user, mode = 'US') {
        return this.accountService.getMetrics(user.id, mode);
    }
    async setLeverage(user, mode, leverage) {
        return this.accountService.setLeverage(user.id, mode || 'US', leverage);
    }
    async resetAccount(user, mode, preset) {
        return this.accountService.resetAccount(user.id, mode || 'US', preset);
    }
};
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "getAccount", null);
__decorate([
    (0, common_1.Get)('metrics'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('mode')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "getMetrics", null);
__decorate([
    (0, common_1.Post)('leverage'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('mode')),
    __param(2, (0, common_1.Body)('leverage')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, Number]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "setLeverage", null);
__decorate([
    (0, common_1.Post)('reset'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('mode')),
    __param(2, (0, common_1.Body)('preset')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, String]),
    __metadata("design:returntype", Promise)
], AccountController.prototype, "resetAccount", null);

export { AccountController };

AccountController = __decorate(
[
    (0, common_1.Controller)('account'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [account_service_1.AccountService])
],
AccountController
);

