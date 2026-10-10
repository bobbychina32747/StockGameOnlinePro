import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { SiteGameAuthService } from './site-game-auth.service';
import { CurrentSession, SessionAuthGuard } from '../identity/session-auth.guard';
import { Session } from '../../infrastructure/database/entities/session.entity';

class SiteSessionDto {
    @IsOptional()
    @IsBoolean()
    create?: boolean;
}

class RegisterDto {
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    username: string;

    @IsString()
    @MinLength(8)
    @MaxLength(72)
    password: string;
}

class LoginDto {
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    username: string;

    @IsString()
    // 登录仅要求非空：避免历史弱密码用户被锁死在登录外（注册侧已有 >=8 位强校验）
    @MinLength(1)
    password: string;
}

@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService, private readonly siteAuth: SiteGameAuthService) {}

    @Post('site-session')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async siteSession(@CurrentSession() session: Session, @Body() dto: SiteSessionDto, @Req() req: any, @Res({ passthrough: true }) res: any) {
        this.assertGameOrigin(req);
        res.setHeader('Cache-Control', 'no-store');
        return this.siteAuth.session(session, dto?.create === true);
    }

    @Post('site-link')
    @HttpCode(HttpStatus.OK)
    @UseGuards(SessionAuthGuard)
    async siteLink(@CurrentSession() session: Session, @Body() dto: LoginDto, @Req() req: any, @Res({ passthrough: true }) res: any) {
        this.assertGameOrigin(req);
        res.setHeader('Cache-Control', 'no-store');
        return this.siteAuth.link(session, dto.username, dto.password, req.ip);
    }

    @Get(['site-return', 'identity/game-return'])
    siteReturn(@Query('origin') origin: string, @Res() res: any) {
        const allowed = ['https://game.bobbycn.cc', 'https://staging.bobbycn.cc', 'http://localhost:5173', 'http://localhost:3000'];
        if (!allowed.includes(origin)) throw new BadRequestException('不支持的游戏回跳地址');
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, origin + '/login');
    }

    private assertGameOrigin(req: any) {
        const origin = req.headers?.origin;
        if (origin && !['https://game.bobbycn.cc', 'https://staging.bobbycn.cc', 'http://localhost:5173',
            'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000'].includes(origin)) {
            throw new BadRequestException('不支持的游戏来源');
        }
    }

    @Post('register')
    async register(@Body() dto: RegisterDto) {
        return this.authService.register(dto.username, dto.password);
    }

    @Post('login')
    @HttpCode(HttpStatus.OK)
    // R5-④: 传入 req.ip 参与锁定计数（计数键 = 用户名|IP），使攻击者无法从任意 IP 锁死他人账号。
    // trust proxy 不在此处处理：main.ts 已按 TRUST_PROXY 统一 set('trust proxy')，开启后 req.ip
    // 才是 X-Forwarded-For 里的真实客户端 IP，否则为直连地址（本地/内网部署即直连地址）。
    async login(@Body() dto: LoginDto, @Req() req: any) {
        return this.authService.login(dto.username, dto.password, req && req.ip);
    }
}
