import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCb) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// 口令哈希参数（OWASP 2024 推荐档）：argon2id、t=2、m=19MiB(19456KiB)、p=1、输出 32 字节。
// 数值字面量而非 Algorithm 枚举：@node-rs/argon2 的枚举是 const enum，运行时形态不稳定，
// 参数必须能被审计与冻结，故写成常量（2 = Argon2id，版本默认 0x13）。
export const ARGON2ID_OPTIONS = {
    algorithm: 2 /* Algorithm.Argon2id */,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
};

// 兜底 scrypt 参数（仅当 argon2 原生模块加载失败时启用）：N=2^15, r=8, p=1, 64 字节输出。
// maxmem 必须显式放宽：默认 32MiB 小于 128*N*r ≈ 33.5MiB，会直接报错。
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SCRYPT_TAG = 'scrypt';
const ARGON2_TAG = '$argon2';

// 原生模块加载失败不应让进程起不来（如目标平台缺预编译包）：降级为 scrypt 并在日志里显式告警。
let argon2: any = null;
try {
    argon2 = require('@node-rs/argon2');
}
catch (e) {
    argon2 = null;
}

@Injectable()
export class PasswordService {
    private readonly logger = new Logger(PasswordService.name);

    /** 当前生效的口令算法：argon2id（规格要求）或 scrypt（兜底，未达规格） */
    readonly algorithm: 'argon2id' | 'scrypt' = argon2 ? 'argon2id' : 'scrypt';

    constructor() {
        if (!argon2) {
            // 兜底路径必须吵闹：否则「密码其实没按规格哈希」这件事会一直被埋着
            this.logger.error('@node-rs/argon2 加载失败，口令哈希降级为 scrypt（未达规格，待补 argon2id）');
        }
    }

    async hash(password: string): Promise<string> {
        if (argon2) {
            return argon2.hash(password, ARGON2ID_OPTIONS);
        }
        // 格式：scrypt$N$r$p$<salt hex>$<hash hex>
        const salt = randomBytes(16);
        const derived = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
        return [SCRYPT_TAG, SCRYPT_OPTIONS.N, SCRYPT_OPTIONS.r, SCRYPT_OPTIONS.p, salt.toString('hex'), derived.toString('hex')].join('$');
    }

    async verify(storedHash: string, password: string): Promise<boolean> {
        if (!storedHash || typeof password !== 'string' || password.length === 0)
            return false;
        if (storedHash.startsWith(ARGON2_TAG)) {
            if (!argon2)
                return false; // 库里是 argon2 串但本进程加载不到原生模块：宁可拒绝也不放行
            try {
                return await argon2.verify(storedHash, password);
            }
            catch {
                return false; // 串损坏/参数非法一律当校验失败，不把内部错误抛给调用方
            }
        }
        if (storedHash.startsWith(SCRYPT_TAG + '$')) {
            const parts = storedHash.split('$');
            if (parts.length !== 6)
                return false;
            const [, n, r, p, saltHex, hashHex] = parts;
            try {
                const expected = Buffer.from(hashHex, 'hex');
                const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
                    N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_OPTIONS.maxmem,
                });
                // 定长比较：避免比较耗时泄露哈希前缀信息
                return derived.length === expected.length && timingSafeEqual(derived, expected);
            }
            catch {
                return false;
            }
        }
        return false; // 未知格式（含历史 bcrypt 串）：本项目身份模块不接管既有 users 表，不猜测
    }

    /** 需要重哈希判定（参数升级后平滑迁移）；MVP 未接自动升降级，留给后续 */
    needsRehash(storedHash: string): boolean {
        if (!argon2)
            return false;
        return !storedHash.startsWith('$argon2id$');
    }

    // ─── TOTP 密钥对称加密（规格：字段与加解密函数先留好，MVP 不做 TOTP）───
    // 密钥只从环境变量读（IDENTITY_ENC_KEY，32 字节 hex）；代码里不得出现任何密钥常量。
    private encryptionKey(): Buffer {
        const raw = process.env.IDENTITY_ENC_KEY;
        if (!raw)
            throw new Error('IDENTITY_ENC_KEY 未配置（TOTP 密钥加密所需，32 字节 hex）');
        const key = Buffer.from(raw, 'hex');
        if (key.length !== 32)
            throw new Error('IDENTITY_ENC_KEY 必须是 32 字节 hex（64 个 hex 字符）');
        return key;
    }

    /** 加密 TOTP 密钥：v1:<iv>:<tag>:<密文>（GCM 带认证标签，篡改会被解密拒绝） */
    encryptTotpSecret(plain: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
        const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
    }

    decryptTotpSecret(payload: string): string {
        const [version, ivB64, tagB64, ctB64] = String(payload || '').split(':');
        if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64)
            throw new Error('TOTP 密文格式非法');
        const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
    }

    // ─── 恢复码（规格：recoveryCodes 存哈希数组的 JSON 文本）───
    // 恢复码是高熵随机串（非人选口令），用带 pepper 的 sha256 足够，无需 argon2 级慢哈希。
    hashRecoveryCode(code: string): string {
        const pepper = process.env.IDENTITY_RECOVERY_PEPPER || '';
        return createHmac('sha256', pepper).update(String(code)).digest('hex');
    }

    verifyRecoveryCode(hashed: string, code: string): boolean {
        const expected = Buffer.from(this.hashRecoveryCode(code), 'hex');
        const actual = Buffer.from(String(hashed || ''), 'hex');
        return expected.length === actual.length && expected.length > 0 && timingSafeEqual(expected, actual);
    }
}
