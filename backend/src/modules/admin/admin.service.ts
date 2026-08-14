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

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

let AdminService = class AdminService {
    [key: string]: any;
    constructor(userRepo, accountRepo, orderRepo) {
        this.userRepo = userRepo;
        this.accountRepo = accountRepo;
        this.orderRepo = orderRepo;
        this.logger = new common_1.Logger(AdminService.name);
    }
    async getStats() {
        const totalUsers = await this.userRepo.count();
        const totalAccounts = await this.accountRepo.count();
        const totalOrders = await this.orderRepo.count();
        const accounts = await this.accountRepo.find();
        const totalAssets = accounts.reduce((sum, a) => sum + Number(a.totalEquity), 0);
        return { totalUsers, totalAccounts, totalOrders, totalAssets: Number(totalAssets.toFixed(2)) };
    }
    async getUsers(page = 1, limit = 20) {
        // SECURITY(E): 手动钳制分页参数，非法值回退默认（page>=1，1<=limit<=100）
        const pageNum = Number(page);
        const limitNum = Number(limit);
        const p = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;
        const l = Number.isFinite(limitNum) ? Math.min(Math.max(Math.floor(limitNum), 1), 100) : 20;
        const [users, total] = await this.userRepo.findAndCount({
            skip: (p - 1) * l,
            take: l,
            order: { createdAt: 'DESC' },
        });
        // SECURITY(H3): 排除密码哈希
        const safeUsers = users.map((u) => ({ id: u.id, username: u.username, role: u.role, isActive: u.isActive, createdAt: u.createdAt, updatedAt: u.updatedAt }));
        return { users: safeUsers, total, page: p, limit: l };
    }
    async setUserActive(userId, isActive) {
        // SECURITY(E): 目标用户不存在时明确报 404
        const target = await this.userRepo.findOne({ where: { id: userId } });
        if (!target)
            throw new common_1.NotFoundException('用户不存在');
        // SECURITY(E): 禁止禁用最后一个活跃管理员（防止系统失去管理入口）
        if (target.role === user_entity_1.UserRole.ADMIN && isActive === false) {
            const activeAdmins = await this.userRepo.count({ where: { role: user_entity_1.UserRole.ADMIN, isActive: true } });
            if (activeAdmins <= 1)
                throw new common_1.BadRequestException('至少需要保留一名活跃管理员');
        }
        await this.userRepo.update(userId, { isActive });
        this.logger.log(`管理员 ${isActive ? '启用' : '禁用'} 用户 ${userId}`);
    }
};

export { AdminService };

AdminService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __param(1, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(2, (0, typeorm_1.InjectRepository)(order_entity_1.Order)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
],
AdminService
);

