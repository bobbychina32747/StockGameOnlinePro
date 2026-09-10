import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
    async login(@Body() dto: LoginDto) {
        return this.authService.login(dto.username, dto.password);
    }
}
