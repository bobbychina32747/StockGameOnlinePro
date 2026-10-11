import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Repository } from 'typeorm';

import { User } from '../../../infrastructure/database/entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(
        config: ConfigService,
        @InjectRepository(User) private readonly userRepo: Repository<User>,
    ) {
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
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            secretOrKey: secret,
        });
    }

    async validate(payload: any) {
        const user = await this.userRepo.findOne({ where: { id: payload.sub } });
        if (!user || !user.isActive)
            throw new UnauthorizedException();
        return user;
    }
}
