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
        const [users, total] = await this.userRepo.findAndCount({
            skip: (page - 1) * limit,
            take: limit,
            order: { createdAt: 'DESC' },
        });
        return { users, total, page, limit };
    }
    async setUserActive(userId, isActive) {
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

