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

import passport_1 = require("@nestjs/passport");

import passport_jwt_1 = require("passport-jwt");

import config_1 = require("@nestjs/config");

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import user_entity_1 = require("../../../infrastructure/database/entities/user.entity");

let JwtStrategy = class JwtStrategy extends (0, passport_1.PassportStrategy)(passport_jwt_1.Strategy) {
    [key: string]: any;
    constructor(config, userRepo) {
        const secret = config.get('JWT_SECRET');
        if (!secret) {
            throw new Error('JWT_SECRET 环境变量未配置！请在 .env 中设置强密钥');
        }
        // SECURITY(C3): 拒绝默认弱密钥，防止攻击者伪造 JWT
        const weakSecrets = ['change_this_to_a_random_secret_in_production', 'change_this_refresh_secret_too', 'dev-secret', 'secret', 'jwt-secret', 'REPLACE_WITH_STRONG_RANDOM_SECRET'];
        if (weakSecrets.includes(secret) || secret.length < 16) {
            throw new Error('JWT_SECRET 过弱（使用了默认占位值或长度不足 16），请设置强随机密钥');
        }
        super({
            jwtFromRequest: passport_jwt_1.ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: secret,
        });
        this.userRepo = userRepo;
    }
    async validate(payload) {
        const user = await this.userRepo.findOne({ where: { id: payload.sub } });
        if (!user || !user.isActive)
            throw new common_1.UnauthorizedException();
        return user;
    }
};

export { JwtStrategy };

JwtStrategy = __decorate(
[
    (0, common_1.Injectable)(),
    __param(1, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [config_1.ConfigService,
        typeorm_2.Repository])
],
JwtStrategy
);

