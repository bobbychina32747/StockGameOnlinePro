import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../../infrastructure/database/entities/user.entity';

@Injectable()
export class UserService {
    constructor(@InjectRepository(User) private readonly userRepo: Repository<User>) {}

    async getProfile(userId: string) {
        const user = await this.userRepo.findOne({ where: { id: userId } });
        if (!user)
            throw new NotFoundException('用户不存在');
        // SECURITY(H3): 排除密码哈希
        return { id: user.id, username: user.username, role: user.role, isActive: user.isActive, createdAt: user.createdAt, updatedAt: user.updatedAt };
    }

    async updateProfile(userId: string, data: any) {
        // SECURITY(C1): 仅允许更新白名单字段，防止 role/password/isActive 等敏感字段被越权覆盖（提权漏洞）
        const ALLOWED_FIELDS = ['username'];
        const patch = {};
        if (data && typeof data === 'object') {
            for (const field of ALLOWED_FIELDS) {
                if (data[field] !== undefined)
                    patch[field] = data[field];
            }
        }
        await this.userRepo.update(userId, patch);
        return this.getProfile(userId);
    }
}
