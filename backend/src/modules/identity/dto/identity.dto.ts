import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// DTO 写法与既有 auth.controller 保持一致（class-validator + 全局 ValidationPipe(whitelist)）。
// 注意：所有错误文案都不含内部细节（不区分「邮箱不存在」与「密码错误」）。

// Turnstile 人机验证 token（CF widget 产出）。
// **必须**出现在 DTO 里：全局 ValidationPipe 开了 whitelist + forbidNonWhitelisted，
// 前端一旦带上没声明的字段，请求会被 400 拒掉（表现为"上线人机验证后注册全挂"）。
// 三个入口都声明：登录目前不强制校验，但前端可能统一挂上 widget，先留好接收位。
class TurnstileTokenField {
    @IsOptional()
    @IsString()
    @MaxLength(4096)
    cfToken?: string;
}

export class RegisterDto extends TurnstileTokenField {
    @IsEmail({}, { message: '邮箱格式不正确' })
    @MaxLength(254)
    email: string;

    // 口令长度上限 72 与既有注册口径一致（argon2 本身无长度限制，此处只做统一约束）
    @IsString()
    @MinLength(8, { message: '密码至少 8 位' })
    @MaxLength(72)
    password: string;
}

export class VerifyDto {
    @IsString()
    @MinLength(16)
    @MaxLength(200)
    token: string;
}

export class LoginDto extends TurnstileTokenField {
    @IsOptional()
    @IsEmail({}, { message: '邮箱格式不正确' })
    @MaxLength(254)
    email?: string;

    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    username?: string;

    // 登录仅要求非空：避免历史弱口令用户被挡在登录之外（注册侧已有 >=8 位强校验）
    @IsString()
    @MinLength(1)
    password: string;
}

export class ResetRequestDto extends TurnstileTokenField {
    @IsEmail({}, { message: '邮箱格式不正确' })
    @MaxLength(254)
    email: string;
}

export class ResetPasswordDto {
    @IsString()
    @MinLength(16)
    @MaxLength(200)
    token: string;

    @IsString()
    @MinLength(8, { message: '密码至少 8 位' })
    @MaxLength(72)
    password: string;
}

export class ChangePasswordDto {
    @IsString()
    @MinLength(1)
    @MaxLength(72)
    oldPassword: string;

    @IsString()
    @MinLength(8, { message: '密码至少 8 位' })
    @MaxLength(72)
    newPassword: string;
}
