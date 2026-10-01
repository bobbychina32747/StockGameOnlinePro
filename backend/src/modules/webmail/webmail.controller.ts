import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

import { WebmailService } from './webmail.service';
// 复用写作台那道闸：站点身份（站主）优先，旧的写作台管理员 JWT 也可（都是"站主级"凭据）
import { BlogAdminGuard } from '../blog-admin/blog-admin.guard';

/** DTO 必须声明每个字段：全局 ValidationPipe 开了 whitelist + forbidNonWhitelisted */
class SendDto {
    @IsEmail({}, { message: '收件人邮箱格式不对' })
    @MaxLength(254)
    to: string;

    @IsString()
    @MaxLength(200)
    subject: string;

    @IsString()
    @MaxLength(100_000)
    text: string;

    /** 可选：回信地址（默认就是发件地址本身） */
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    replyTo?: string;
}

/**
 * 站内发信（/api/admin/mail/*）
 * nginx 需把 ^~ /api/admin/mail/ 反代到本机 Nest（否则会打到游戏厅 Worker 变 401）。
 */
@Controller('admin/mail')
@UseGuards(BlogAdminGuard)
export class WebmailController {
    constructor(private readonly mail: WebmailService) {}

    /** 面板显示用：当前以哪个地址发信 */
    @Get('config')
    async config() {
        return { from: this.mail.fromHeader(), address: this.mail.fromAddress() };
    }

    @Post('send')
    @HttpCode(HttpStatus.OK)
    async send(@Body() dto: SendDto) {
        return { ok: true, ...(await this.mail.send({ to: dto.to, subject: dto.subject, text: dto.text, replyTo: dto.replyTo })) };
    }
}
