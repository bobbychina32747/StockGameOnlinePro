import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors, Body } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { createReadStream, promises as fs } from 'node:fs';

import { CurrentIdentity, SessionAuthGuard } from '../identity/session-auth.guard';
import { ChatMessageKind } from '../../infrastructure/database/entities/chat-message.entity';
import { ChatService } from './chat.service';
import { ChatUploadInterceptor } from './chat-upload.interceptor';
import { ChatEventsService } from './chat-events.service';

export class SendMessageDto {
    @IsIn([ChatMessageKind.TEXT, ChatMessageKind.FILE, ChatMessageKind.LINK])
    kind: string;

    @IsOptional()
    @IsString()
    @MaxLength(4000)
    text?: string;

    @IsOptional()
    @IsString()
    @MaxLength(2048)
    linkUrl?: string;

    @IsOptional()
    @IsUUID()
    attachmentId?: string;
}

export class ListMessagesQueryDto {
    @IsOptional()
    @IsUUID()
    before?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number;
}

/**
 * 站内私线 HTTP 层（/api/chat/*，nginx 需反代到本机 Nest，见 deploy/nginx/chat.conf）。
 *
 * 全部端点都要站点会话（sid Cookie 或 Bearer）；能不能聊由 ChatService.resolveAccess 统一裁决，
 * 控制器只做「取参数 → 调服务 → 输出」，不重复写权限判据。
 */
@Controller('chat')
@UseGuards(SessionAuthGuard)
export class ChatController {
    constructor(
        private readonly chat: ChatService,
        private readonly events: ChatEventsService,
    ) {}

    /** 进页面第一个请求：能不能聊、对方是谁、未读数、各项上限 */
    @Get('access')
    async access(@CurrentIdentity() identity: any) {
        return this.chat.getAccess(identity);
    }

    /** 历史消息（倒序取一页，返回升序） */
    @Get('messages')
    async messages(@CurrentIdentity() identity: any, @Query() query: ListMessagesQueryDto) {
        return this.chat.listMessages(identity, { before: query.before, limit: query.limit });
    }

    /** 发送文本 / 链接 / 文件（文件需先走 upload 拿 attachmentId） */
    @Post('messages')
    @HttpCode(HttpStatus.OK)
    async send(@CurrentIdentity() identity: any, @Body() dto: SendMessageDto) {
        return { message: await this.chat.send(identity, dto) };
    }

    /** 上传附件（20MB 上限）：先落盘建行，发送时再绑定消息 */
    @Post('upload')
    @HttpCode(HttpStatus.OK)
    @UseInterceptors(ChatUploadInterceptor)
    async upload(@CurrentIdentity() identity: any, @UploadedFile() file: any) {
        return this.chat.registerUpload(identity, file);
    }

    /** 下载/预览附件：只有这条会话的两个参与者能取；`?download=1` 强制存盘 */
    @Get('files/:id')
    async file(
        @CurrentIdentity() identity: any,
        @Param('id') id: string,
        @Query('download') download: string,
        @Res() res: any,
    ) {
        const wantDownload = String(download || '') === '1';
        const { attachment, absPath } = await this.chat.openFile(identity, id);

        const stat = await fs.stat(absPath);
        const mime = this.safeMime(attachment.mime);
        // 能被浏览器当页面执行/渲染的类型一律强制下载，避免存储型 XSS（SVG/HTML）
        const executable = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|application\/xml|text\/xml)$/i.test(mime);
        const inline = !executable && !wantDownload && /^(image\/|application\/pdf$|text\/plain$|audio\/|video\/)/i.test(mime);
        const asciiName = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");

        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
        res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.status(HttpStatus.OK);

        const stream = createReadStream(absPath);
        stream.on('error', () => {
            try { res.destroy(); } catch { /* 连接已断，忽略 */ }
        });
        stream.pipe(res);
    }

    /** 已读回执（把对端消息全部标记为已读） */
    @Post('read')
    @HttpCode(HttpStatus.OK)
    async read(@CurrentIdentity() identity: any) {
        return this.chat.markRead(identity);
    }

    /** 输入中提示（瞬态，不落库） */
    @Post('typing')
    @HttpCode(HttpStatus.OK)
    async typing(@CurrentIdentity() identity: any) {
        return this.chat.typing(identity);
    }

    /**
     * 实时事件流（SSE）。浏览器原生 EventSource 带 Cookie 自动重连；
     * 前端 SSE 失败时退回轮询 /messages，不依赖任何第三方脚本。
     */
    @Get('stream')
    async stream(@CurrentIdentity() identity: any, @Res() res: any) {
        let access;
        try {
            access = await this.chat.resolveAccess(identity);
        }
        catch (e: any) {
            res.status(e?.status || HttpStatus.FORBIDDEN).json({ statusCode: e?.status || 403, message: e?.message || '无权使用对话' });
            return;
        }
        const unsubscribe = this.events.subscribe({
            identityId: String(identity.id),
            threadId: access.thread.id,
            res,
        });
        const close = () => unsubscribe();
        res.req?.on?.('close', close);
        res.req?.on?.('aborted', close);
    }

    private safeMime(raw: string): string {
        const mime = String(raw || 'application/octet-stream').toLowerCase();
        // 只接受形如 type/subtype 的合法形态，非法值一律回落二进制流（别把脏数据塞进响应头）
        return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'application/octet-stream';
    }
}
