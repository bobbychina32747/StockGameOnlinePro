import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Observable, catchError, throwError } from 'rxjs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { resourceDir } from './resource-paths';

// multer 随 @nestjs/platform-express 安装，仓库里没有 @types/multer，用 require 拿到运行时值即可
const multer = require('multer');

/** 单文件上限 64MB（契约 §1） */
export const RESOURCE_FILE_LIMIT = 64 * 1024 * 1024;

const InnerFileInterceptor: any = FileInterceptor('file', {
    storage: multer.diskStorage({
        destination: (_req: any, _file: any, cb: any) => {
            const dir = resourceDir();
            fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), (e) => cb(e, dir));
        },
        filename: (_req: any, file: any, cb: any) => {
            // 随机 key = 32 hex + 白名单扩展名；原始文件名单独存库，不参与落盘路径
            const ext = path.extname(String(file?.originalname || ''));
            const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext.toLowerCase() : '';
            cb(null, crypto.randomBytes(16).toString('hex') + safeExt);
        },
    }),
    limits: { fileSize: RESOURCE_FILE_LIMIT, files: 1, fields: 8, parts: 9, fieldNameSize: 100, ...{ fieldNestingDepth: 0 } },
});

function mapUploadError(err: any) {
    const code = err?.code || '';
    if (err?.name === 'MulterError' || code === 'LIMIT_FILE_SIZE') {
        if (code === 'LIMIT_FILE_SIZE')
            return new PayloadTooLargeException('文件超过 64MB 上限');
        return new BadRequestException(`上传失败：${code || '格式不正确'}`);
    }
    return err;
}

/**
 * 上传拦截器：包一层 FileInterceptor，把 multer 的错误翻译成 HTTP 语义。
 * 不包的话超限会变成 500（multer 的 MulterError 不是 HttpException），验收要求 4xx。
 */
@Injectable()
export class ResourceUploadInterceptor implements NestInterceptor {
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
