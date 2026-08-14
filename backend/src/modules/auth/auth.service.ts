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

import jwt_1 = require("@nestjs/jwt");

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import bcrypt = require("bcrypt");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import constants_1 = require("../../common/constants");

let AuthService = class AuthService {
    [key: string]: any;
    constructor(userRepo, accountRepo, jwtService) {
        this.userRepo = userRepo;
        this.accountRepo = accountRepo;
        this.jwtService = jwtService;
    }
    // 主应用启动自动确保管理员存在（防 DB 覆盖丢失）
    async onModuleInit() {
        try {
            const adminUsername = process.env.ADMIN_USERNAME || 'admin';
            const existing = await this.userRepo.findOne({ where: { username: adminUsername } });
            if (!existing) {
                const adminPassword = process.env.ADMIN_PASSWORD;
                const isStrong = !!adminPassword && adminPassword.length >= 8;
                const isDev = process.env.NODE_ENV === 'development';
                // SECURITY(C2): 仅 development 环境允许回退默认密码；production/staging/未设置等环境必须提供强 ADMIN_PASSWORD（>=8位），否则拒绝创建（避免默认后门）
                if (!isStrong && !isDev) {
                    console.error('[Seed] 当前环境（' + (process.env.NODE_ENV || '未设置') + '）未设置强 ADMIN_PASSWORD（>=8位），已拒绝创建默认管理员账号');
                    return;
                }
                const passwordToUse = isStrong ? adminPassword : 'admin123';
                if (!isStrong) {
                    console.warn('[Seed] 使用默认管理员密码 admin123（仅限 development 环境，其他环境请设置 ADMIN_PASSWORD 环境变量）');
                }
                const hashed = await bcrypt.hash(passwordToUse, 10);
                const admin = this.userRepo.create({
                    username: adminUsername,
                    password: hashed,
                    role: user_entity_1.UserRole.ADMIN,
                });
                await this.userRepo.save(admin);
                for (const mode of ['CN', 'HK', 'US']) {
                    const account = this.accountRepo.create({
                        userId: admin.id,
                        marketMode: mode,
                        cash: constants_1.RISK.initialCash,
                        totalEquity: constants_1.RISK.initialCash,
                        peakEquity: constants_1.RISK.initialCash,
                        initialEquity: constants_1.RISK.initialCash,
                        dayStartEquity: constants_1.RISK.initialCash,
                    });
                    await this.accountRepo.save(account);
                }
                console.log('[Seed] 管理员账号已创建: ' + adminUsername);
            }
            // 注：若 admin 用户已存在但密码较弱，此处不强制重置（避免影响既有登录会话），请运维手动轮换密码
        }
        catch (e) {
            console.error('[Seed] 管理员创建失败:', e.message);
        }
    }
    // SECURITY(H3): 序列化时排除密码哈希，避免泄露
    toSafeUser(user) {
        if (!user)
            return user;
        return {
            id: user.id,
            username: user.username,
            role: user.role,
            isActive: user.isActive,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };
    }
    async register(username, password) {
        const existing = await this.userRepo.findOne({ where: { username } });
        if (existing)
            throw new common_1.ConflictException('用户名已存在');
        const hashed = await bcrypt.hash(password, 10);
        const user = this.userRepo.create({ username, password: hashed });
        await this.userRepo.save(user);
        for (const mode of ['CN', 'HK', 'US']) { // B1 多市场：A股/港股/美股三账户
            const account = this.accountRepo.create({
                userId: user.id,
                marketMode: mode,
                cash: constants_1.RISK.initialCash,
                totalEquity: constants_1.RISK.initialCash,
                peakEquity: constants_1.RISK.initialCash,
                initialEquity: constants_1.RISK.initialCash,
                dayStartEquity: constants_1.RISK.initialCash,
            });
            await this.accountRepo.save(account);
        }
        const token = this.jwtService.sign({ sub: user.id, username: user.username, role: user.role });
        return { user: this.toSafeUser(user), token };
    }
    async login(username, password) {
        const user = await this.userRepo.findOne({ where: { username } });
        if (!user)
            throw new common_1.UnauthorizedException('用户名或密码错误');
        const valid = await bcrypt.compare(password, user.password);
        if (!valid)
            throw new common_1.UnauthorizedException('用户名或密码错误');
        const token = this.jwtService.sign({ sub: user.id, username: user.username, role: user.role });
        return { user: this.toSafeUser(user), token };
    }
};

export { AuthService };

AuthService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __param(1, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        jwt_1.JwtService])
],
AuthService
);

