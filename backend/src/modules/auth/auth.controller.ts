import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';

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
    constructor(private readonly authService: AuthService) {}

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
