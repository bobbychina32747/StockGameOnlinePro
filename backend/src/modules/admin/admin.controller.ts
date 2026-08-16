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

import debug_mode_service_1 = require("../../common/debug-mode/debug-mode.service");

import admin_service_1 = require("./admin.service");

let AdminController = class AdminController {
    [key: string]: any;
    constructor(adminService, debugMode) {
        this.adminService = adminService;
        this.debugMode = debugMode;
    }
    async getStats(user) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException('无权限');
        return this.adminService.getStats();
    }
    async getUsers(user, page, limit) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException('无权限');
        return this.adminService.getUsers(page, limit);
    }
    async toggleUser(admin, userId, isActive) {
        if (admin.role !== user_entity_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException('无权限');
        // SECURITY(E): 禁止管理员禁用自己（避免失去管理入口）
        if (isActive === false && userId === admin.id)
            throw new common_1.BadRequestException('不能禁用当前登录的管理员账号');
        await this.adminService.setUserActive(userId, isActive);
        return { success: true };
    }
    // 调试模式：休市期间可生成行情/下单（管理员专用）
    async setDebug(user, on) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException('无权限');
        // SECURITY(D): 调试模式只对开启它的管理员生效（bypassUserIds 白名单），关闭时清空白名单并复位全局开关
        if (on === true) {
            this.debugMode.set(true);
            this.debugMode.addBypassUser(user.id);
        }
        else {
            this.debugMode.clearBypassUsers();
            this.debugMode.set(false);
            // P4 修复：关闭调试模式时同步复位全服休市交易（与注释承诺一致，避免遗留全局旁路）
            this.debugMode.setGlobalBypass(false);
        }
        return { success: true, debug: this.debugMode.get(), globalBypass: this.debugMode.getGlobalBypass() };
    }
    async getDebug(user) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException('无权限');
        return { debug: this.debugMode.get(), globalBypass: this.debugMode.getGlobalBypass() };
    }
    // P6 全服休市交易：开启后所有用户均可休市下单（行情全时生成）
    async setDebugGlobal(user, on) {
        if (user.role !== user_entity_1.UserRole.ADMIN)
            throw new common_1.ForbiddenException('无权限');
        this.debugMode.setGlobalBypass(on === true);
        if (on === true) {
            this.debugMode.set(true); // 全服休市交易依赖行情运行
        }
        return { success: true, debug: this.debugMode.get(), globalBypass: this.debugMode.getGlobalBypass() };
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
    __param(2, (0, common_1.Body)('isActive', common_1.ParseBoolPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, String, Boolean]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "toggleUser", null);
__decorate([
    (0, common_1.Post)('debug'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Body)('on')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, Boolean]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "setDebug", null);
__decorate([
    (0, common_1.Get)('debug'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "getDebug", null);
__decorate([
    (0, common_1.Post)('debug/global'),
    __param(0, (0, jwt_auth_guard_1.CurrentUser)()),
    __param(1, (0, common_1.Body)('on', common_1.ParseBoolPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [user_entity_1.User, Boolean]),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "setDebugGlobal", null);

export { AdminController };

AdminController = __decorate(
[
    (0, common_1.Controller)('admin'),
    (0, common_1.UseGuards)(jwt_auth_guard_1.JwtAuthGuard),
    __metadata("design:paramtypes", [admin_service_1.AdminService, debug_mode_service_1.DebugModeService])
],
AdminController
);

