import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { Identity } from '../../infrastructure/database/entities/identity.entity';
import { CurrentIdentity, SessionAuthGuard } from '../identity/session-auth.guard';
import { ArcadeService } from './arcade.service';

/**
 * 游戏厅凭据桥（/api/games/*）——只有**已登录的站点身份**能拿，用于让游戏厅免二次登录。
 * nginx 需把 ^~ /api/games/ 反代到本机 Nest（与 /api/blog/ 同理，否则打到游戏厅 Worker 变 401）。
 */

class BindDto {
    @IsString()
    @MinLength(2)
    @MaxLength(24)
    name: string;
}

@Controller('games')
@UseGuards(SessionAuthGuard)
export class ArcadeController {
    constructor(private readonly arcade: ArcadeService) {}

    /** 当前身份对应的游戏厅账号名与派生口令（客户端拿它走原有的登录/注册流程） */
    @Get('arcade')
    async credential(@CurrentIdentity() identity: Identity) {
        return this.arcade.current(identity.id);
    }

    /** 绑定已有游戏厅账号（客户端已确认用派生口令能登上它） */
    @Post('arcade/link')
    @HttpCode(HttpStatus.OK)
    async link(@CurrentIdentity() identity: Identity, @Body() dto: BindDto) {
        return this.arcade.bind(identity.id, dto.name);
    }

    /** 解绑 */
    @Delete('arcade/link')
    async unlink(@CurrentIdentity() identity: Identity) {
        return this.arcade.unbind(identity.id);
    }
}
