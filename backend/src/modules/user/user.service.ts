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

let UserService = class UserService {
    [key: string]: any;
    constructor(userRepo) {
        this.userRepo = userRepo;
    }
    async getProfile(userId) {
        const user = await this.userRepo.findOne({ where: { id: userId } });
        if (!user)
            throw new common_1.NotFoundException('用户不存在');
        // SECURITY(H3): 排除密码哈希
        return { id: user.id, username: user.username, role: user.role, isActive: user.isActive, createdAt: user.createdAt, updatedAt: user.updatedAt };
    }
    async updateProfile(userId, data) {
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
};

export { UserService };

UserService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [typeorm_2.Repository])
],
UserService
);

