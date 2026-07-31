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

import admin_service_1 = require("./admin.service");

let AdminController = class AdminController {
    [key: string]: any;
    constructor(adminService) {
        this.adminService = adminService;
    }
    async getStats(user) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new Error('无权限');
        return this.adminService.getStats();
    }
    async getUsers(user, page, limit) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new Error('无权限');
        return this.adminService.getUsers(page, limit);
    }
    async toggleUser(admin, userId, isActive) {
        if (admin.role !== user_entity_1.UserRole.ADMIN)
            throw new Error('无权限');
        await this.adminService.setUserActive(userId, isActive);
        return { success: true };
    }
};
__decorate([
    (0, common_1.Get)('stats'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "getStats", null);
__decorate([
    (0, common_1.Get)('users'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Query)('page')),
    __param(2, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, Number, Number]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "getUsers", null);
__decorate([
    (0, common_1.Post)('users/:id/toggle'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Param)('id')),
    __param(2, (0, common_1.Body)('isActive')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, Boolean]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "toggleUser", null);

export { AdminController };

AdminController = __decorate(
[
    (0, common_1.Controller)('admin'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [admin_service_1.AdminService])
],
AdminController
);

