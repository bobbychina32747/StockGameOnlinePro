import {
    Body, CanActivate, Controller, Delete, ExecutionContext, Get, HttpCode, HttpStatus,
    Injectable, Post, Put, Query, Req, UnauthorizedException, UseGuards, createParamDecorator,
} from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

import { OauthService } from '../identity/oauth.service';
import { GameSavesService } from './game-saves.service';

/**
 * 云存档 HTTP 层（2026-10-08）
 *
 * 路径：`/api/auth/identity/saves/*` —— 与授权端点同一个 nginx 前缀（`^~ /api/auth/identity/`
 * 已反代到本机 NestJS），所以**不需要改 nginx** 就能上线。
 *
 * 鉴权：`Authorization: Bearer <access_token>`（授权系统签发的 EdDSA 令牌），
 * 且必须带 `saves` scope。令牌带 sid，因此"用户撤销了授权/登出"会立刻反映到下一次请求上。
 */
@Injectable()
export class SaveTokenGuard implements CanActivate {
    constructor(private readonly oauth: OauthService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const header = String((req.headers && req.headers.authorization) || '');
        const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : String((req.query && req.query.access_token) || '');
        if (!token)
            throw new UnauthorizedException('缺少访问令牌');
        // 必须是**授权系统签发的带 saves scope 的令牌**：客户端不该拿会话令牌来读写云存档
        const claims = await this.oauth.requireScope(token, 'saves');
        req.saveClaims = claims;
        return true;
    }
}

export const CurrentClaims = createParamDecorator((data: string, ctx: ExecutionContext) => {
    const claims = ctx.switchToHttp().getRequest().saveClaims;
    return data ? claims?.[data] : claims;
});

/**
 * 请求体 DTO：全局 ValidationPipe 开了 whitelist + forbidNonWhitelisted，
 * 没有装饰器的字段会被**剥掉**（表现为"上传成功但存档是空的"），故必须显式声明。
 * 这里只声明形状，具体校验（体积、槽位名、配额）在 GameSavesService 里。
 */
class SaveBody {
    @IsString()
    @MaxLength(4 * 1024 * 1024)
    data: string;

    @IsOptional()
    @IsObject()
    meta?: Record<string, any> | null;

    @IsOptional()
    @IsBoolean()
    migrated?: boolean;
}

@Controller('auth/identity/saves')
@UseGuards(SaveTokenGuard)
export class GameSavesController {
    constructor(private readonly saves: GameSavesService) {}

    /** 存档密钥（客户端只取一次，缓存在内存里；服务端不拿它解密文件内容） */
    @Get('key')
    async key(@CurrentClaims('sub') identityId: string) {
        return this.saves.keyForClient(identityId);
    }

    @Get('quota')
    quota(@CurrentClaims('sub') identityId: string) {
        return this.saves.quota(identityId);
    }

    /** 全部存档概览 + 迁移状态（前端启动时问它一次，决定是否引导迁移） */
    @Get('summary')
    summary(@CurrentClaims('sub') identityId: string) {
        return this.saves.migrationStatus(identityId);
    }

    @Get('migration')
    migration(@CurrentClaims('sub') identityId: string) {
        return this.saves.migrationStatus(identityId);
    }

    @Get()
    list(@CurrentClaims('sub') identityId: string, @Query('game') game: string) {
        return this.saves.list(identityId, game);
    }

    @Get('one')
    one(@CurrentClaims('sub') identityId: string, @Query('game') game: string, @Query('slot') slot: string) {
        return this.saves.get(identityId, game, slot);
    }

    /** 上传/覆盖一份存档（密文）。migrated=true 表示由老存档迁移而来 */
    @Put()
    @HttpCode(HttpStatus.OK)
    async put(@CurrentClaims('sub') identityId: string, @Query('game') game: string, @Query('slot') slot: string, @Body() body: SaveBody) {
        return this.saves.put(identityId, game, slot, body && body.data, body && body.meta, !!(body && body.migrated));
    }

    /** 与 PUT 等价的表单式入口（老客户端只有 POST 能力时用） */
    @Post()
    @HttpCode(HttpStatus.OK)
    async post(@CurrentClaims('sub') identityId: string, @Query('game') game: string, @Query('slot') slot: string, @Body() body: SaveBody) {
        return this.saves.put(identityId, game, slot, body && body.data, body && body.meta, !!(body && body.migrated));
    }

    @Delete()
    @HttpCode(HttpStatus.OK)
    remove(@CurrentClaims('sub') identityId: string, @Query('game') game: string, @Query('slot') slot: string) {
        return this.saves.remove(identityId, game, slot);
    }
}
