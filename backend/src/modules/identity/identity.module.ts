import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Identity } from '../../infrastructure/database/entities/identity.entity';
import { Credential } from '../../infrastructure/database/entities/credential.entity';
import { Session } from '../../infrastructure/database/entities/session.entity';
import { IdentityToken } from '../../infrastructure/database/entities/identity-token.entity';

import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityJwtService } from './jwt.service';
import { KeysService } from './keys.service';
import { LogMailerService, MAILER, ResendMailerService } from './mailer.service';
import { PasswordService } from './password.service';
import { RateLimitService } from './rate-limit.service';
import { SessionAuthGuard } from './session-auth.guard';
import { TokenExchangeService } from './token-exchange.service';
import { TokenService } from './token.service';
import { TurnstileService } from './turnstile.service';

// 邮件通道工厂：有 RESEND_API_KEY 走真实发信，否则只写日志（本机/测试不误发真实邮件）。
// 密钥只在环境变量里；此处的日志只说明「选了哪条通道」，不打印密钥本身。
const mailerProvider = {
    provide: MAILER,
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
        const logger = new Logger('IdentityMailer');
        if (config.get('RESEND_API_KEY')) {
            logger.log('邮件通道：Resend（RESEND_API_KEY 已配置）');
            return new ResendMailerService(config);
        }
        logger.warn('邮件通道：LogMailer（未配置 RESEND_API_KEY，验证/重置邮件只会写日志）');
        return new LogMailerService();
    },
};

@Module({
    imports: [
        ConfigModule,
        TypeOrmModule.forFeature([Identity, Credential, Session, IdentityToken]),
    ],
    controllers: [IdentityController],
    providers: [
        IdentityService,
        PasswordService,
        TokenService,
        RateLimitService,
        SessionAuthGuard,
        KeysService,
        IdentityJwtService,
        TokenExchangeService,
        TurnstileService,
        mailerProvider,
    ],
    // 导出供其它模块（如把身份挂到业务账号上）复用；MVP 暂无人消费
    // 阶段一追加：密钥/JWT 服务导出，便于后续在同进程内做"内部服务间验签"
    // 2026-09-29 追加：SessionAuthGuard 导出，博客评论（blog-public）用它做"登录才能发"
    exports: [IdentityService, PasswordService, TokenService, RateLimitService, KeysService, IdentityJwtService, TokenExchangeService, TurnstileService, SessionAuthGuard],
})
export class IdentityModule {}
