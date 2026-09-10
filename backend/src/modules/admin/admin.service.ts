import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../../infrastructure/database/entities/user.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Order } from '../../infrastructure/database/entities/order.entity';

@Injectable()
export class AdminService {
    private readonly logger = new Logger(AdminService.name);

    constructor(
        @InjectRepository(User) private readonly userRepo: Repository<User>,
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
    ) {}

    async getStats() {
        const totalUsers = await this.userRepo.count();
        const totalAccounts = await this.accountRepo.count();
        const totalOrders = await this.orderRepo.count();
        const accounts = await this.accountRepo.find();
        const totalAssets = accounts.reduce((sum, a) => sum + Number(a.totalEquity), 0);
        return { totalUsers, totalAccounts, totalOrders, totalAssets: Number(totalAssets.toFixed(2)) };
    }

    async getUsers(page: number = 1, limit: number = 20) {
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

    async setUserActive(userId: string, isActive: boolean) {
        // SECURITY(E): 目标用户不存在时明确报 404
        const target = await this.userRepo.findOne({ where: { id: userId } });
        if (!target)
            throw new NotFoundException('用户不存在');
        // SECURITY(E): 禁止禁用最后一个活跃管理员（防止系统失去管理入口）
        if (target.role === UserRole.ADMIN && isActive === false) {
            const activeAdmins = await this.userRepo.count({ where: { role: UserRole.ADMIN, isActive: true } });
            if (activeAdmins <= 1)
                throw new BadRequestException('至少需要保留一名活跃管理员');
        }
        await this.userRepo.update(userId, { isActive });
        this.logger.log(`管理员 ${isActive ? '启用' : '禁用'} 用户 ${userId}`);
    }
}
