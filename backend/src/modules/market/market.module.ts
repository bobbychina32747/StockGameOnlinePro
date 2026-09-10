import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../infrastructure/database/entities/user.entity';

import { MarketController } from './market.controller';
import { MarketGateway } from './market.gateway';
import { MarketService } from './market.service';
import { NewsService } from './news.service';

@Module({
    imports: [
        // SECURITY(C): 为 WS 网关提供 JWT 校验能力（global:false，仅本模块可见）
        JwtModule.registerAsync({
            global: false,
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                secret: config.get('JWT_SECRET'),
            }),
        }),
        // Phase D: WS 握手校验 isActive 需要 User repo（autoLoadEntities 下 forFeature 全局可用）
        TypeOrmModule.forFeature([User]),
    ],
    controllers: [MarketController],
    providers: [MarketGateway, MarketService, NewsService],
    exports: [MarketService, NewsService],
})
export class MarketModule {}
