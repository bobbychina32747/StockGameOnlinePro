var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import common_1 = require("@nestjs/common");

import jwt_1 = require("@nestjs/jwt");

import passport_1 = require("@nestjs/passport");

import typeorm_1 = require("@nestjs/typeorm");

import config_1 = require("@nestjs/config");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import auth_controller_1 = require("./auth.controller");

import auth_service_1 = require("./auth.service");

import jwt_strategy_1 = require("./strategies/jwt.strategy");

let AuthModule = class AuthModule {
    [key: string]: any;
};

export { AuthModule };

AuthModule = __decorate(
[
    (0, common_1.Module)({
        imports: [
            passport_1.PassportModule.register({ defaultStrategy: 'jwt' }),
            typeorm_1.TypeOrmModule.forFeature([user_entity_1.User, account_entity_1.Account]),
            jwt_1.JwtModule.registerAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    // SECURITY(I): 去掉默认 secret 回退；JWT_SECRET 缺失/过弱由 jwt.strategy 启动强校验兜底
                    secret: config.get('JWT_SECRET'),
                    signOptions: { expiresIn: config.get('JWT_EXPIRES_IN', '24h') },
                }),
            }),
        ],
        controllers: [auth_controller_1.AuthController],
        providers: [auth_service_1.AuthService, jwt_strategy_1.JwtStrategy],
        exports: [auth_service_1.AuthService, jwt_1.JwtModule],
    })
],
AuthModule
);

