import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable, catchError, throwError } from 'rxjs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { CHAT_FILE_LIMIT } from './chat.service';

// multer 随 @nestjs/platform-express 安装，仓库里没有 @types/multer，用 require 拿运行时值即可
const multer = require('multer');

/** 上传落点：<CHAT_UPLOAD_DIR>/incoming/<随机 32hex><安全扩展名>，随后由 ChatService 归档到会话目录 */
function incomingDir(): string {
    const base = process.env.CHAT_UPLOAD_DIR || path.join(process.cwd(), 'data', 'chat-uploads');
    return path.join(base, 'incoming');
}

const InnerFileInterceptor: any = FileInterceptor('file', {
    storage: multer.diskStorage({
        destination: (_req: any, _file: any, cb: any) => {
            const dir = incomingDir();
            fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), (e) => cb(e, dir));
        },
        filename: (_req: any, file: any, cb: any) => {
            // 随机名落盘；原始文件名单独存库（不参与路径，避免路径穿越与同名覆盖）
            const ext = path.extname(String(file?.originalname || ''));
            const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
            cb(null, crypto.randomBytes(16).toString('hex') + safeExt);
        },
    }),
    limits: { fileSize: CHAT_FILE_LIMIT, files: 1, fields: 8, parts: 9, fieldNameSize: 100, ...{ fieldNestingDepth: 0 } },
});

function mapUploadError(err: any) {
    const code = err?.code || '';
    if (err?.name === 'MulterError' || code === 'LIMIT_FILE_SIZE') {
        if (code === 'LIMIT_FILE_SIZE')
            return new PayloadTooLargeException(`文件超过 ${Math.floor(CHAT_FILE_LIMIT / 1048576)}MB 上限`);
        return new BadRequestException(`上传失败：${code || '格式不正确'}`);
    }
    return err;
}

/** 把 multer 的错误翻译成 HTTP 语义（否则超限会变成 500） */
@Injectable()
export class ChatUploadInterceptor implements NestInterceptor {
    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
        try {
            const stream$ = await new InnerFileInterceptor().intercept(context, next);
            return (stream$ as Observable<any>).pipe(catchError((err) => throwError(() => mapUploadError(err))));
        }
        catch (err) {
            throw mapUploadError(err);
        }
    }
}
