import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';

// 令牌规格（C10）：
//  1) 明文只用 CSPRNG 生成（256bit ≥ 规格下限 128bit），只在签发那一刻出现在响应/邮件里；
//  2) 落库一律 sha256 哈希——库被读走也换不出可用令牌；
//  3) 身份令牌 TTL ≤ 30 分钟，且一次一废（identity_tokens.usedAt）。
export const IDENTITY_TOKEN_TTL_MS = 30 * 60 * 1000;

// 会话令牌 TTL：规格未定，取 30 天（滑动续期/MVP 不续期，过期即需重新登录）
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class TokenService {
    /** 生成的明文令牌长度（字节）；32 字节 = 256bit */
    readonly TOKEN_BYTES = 32;

    /** 新的明文令牌（base64url，无 +/ 便于放进 URL 与请求头） */
    newToken(): string {
        return randomBytes(this.TOKEN_BYTES).toString('base64url');
    }

    /** 入库/查询统一的哈希口径：sha256 hex（查表即等值命中索引） */
    sha256(token: string): string {
        return createHash('sha256').update(String(token), 'utf8').digest('hex');
    }

    isUsable(row: { expiresAt?: Date | string | null; usedAt?: Date | string | null; revokedAt?: Date | string | null }, now = Date.now()): boolean {
        if (!row)
            return false;
        if (row.usedAt)
            return false;
        if (row.revokedAt)
            return false;
        if (!row.expiresAt)
            return true;
        return new Date(row.expiresAt).getTime() > now;
    }

    expiryFromNow(ttlMs: number, now = Date.now()): Date {
        return new Date(now + ttlMs);
    }
}
