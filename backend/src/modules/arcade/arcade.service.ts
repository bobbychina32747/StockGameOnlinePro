import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, createHmac, randomBytes } from 'crypto';
import { Repository } from 'typeorm';

import { AppSecret } from '../../infrastructure/database/entities/app-secret.entity';
import { ArcadeLink } from '../../infrastructure/database/entities/arcade-link.entity';

/**
 * 站点身份 → 游戏厅凭据（见 ArcadeLink 的注释解释为什么是"派生口令"而不是 JWT 直通）。
 *
 * 派生规则：password = base64url(HMAC_SHA256(key, identityId))，key 稳定且**存在数据库里**
 * （环境变量 ARCADE_DERIVE_KEY 可覆盖；否则首次使用时生成 32 字节随机值写进 app_secrets）。
 *   · 放库里的原因：容器的 /keys 是只读挂载，写不进去；而这份 key 必须跟着数据库备份走 ——
 *     丢了等于把已自动开号的用户锁在门外（派生口令会变，老号登不进、也改不了密）。
 *   · 同一身份在任何设备/任何时候派生出同一份口令 → 客户端可以无感登录游戏厅；
 *   · 口令只在**已登录身份的会话**下返回（本接口挂 SessionAuthGuard）。
 */
@Injectable()
export class ArcadeService {
    private readonly logger = new Logger('Arcade');
    private cachedKey: Buffer | null = null;

    constructor(
        @InjectRepository(ArcadeLink) private readonly links: Repository<ArcadeLink>,
        @InjectRepository(AppSecret) private readonly secrets: Repository<AppSecret>,
    ) {}

    /** 取（或首次生成）派生密钥；进程内缓存，避免每次请求读库 */
    private async deriveKey(): Promise<Buffer> {
        if (this.cachedKey)
            return this.cachedKey;
        const inline = String(process.env.ARCADE_DERIVE_KEY || '').trim();
        if (inline) {
            this.cachedKey = createHash('sha256').update(inline).digest();
            return this.cachedKey;
        }
        const row = await this.secrets.findOne({ where: { name: 'arcade.derive' } });
        if (row && /^[0-9a-f]{64}$/i.test(String(row.value).trim())) {
            this.cachedKey = Buffer.from(String(row.value).trim(), 'hex');
            return this.cachedKey;
        }
        const fresh = randomBytes(32).toString('hex');
        try {
            if (row)
                await this.secrets.update({ name: 'arcade.derive' }, { value: fresh });
            else
                await this.secrets.insert({ name: 'arcade.derive', value: fresh });
            this.logger.log('已生成游戏厅凭据派生密钥（app_secrets: arcade.derive，随数据库备份走）');
        }
        catch (e: any) {
            // 落库失败也别 500：退回进程内随机键并告警（代价：重启后已自动开的号要人工处理）
            this.logger.error(`派生密钥落库失败（${e && e.message}）：本次使用临时键，重启后已自动开的号需人工处理`);
        }
        this.cachedKey = Buffer.from(fresh, 'hex');
        return this.cachedKey;
    }

    /** 自动开号时用的名字：u_ + sha256(identityId) 前 8 位（稳定、不可反推） */
    autoName(identityId: string): string {
        return 'u_' + createHash('sha256').update(String(identityId)).digest('hex').slice(0, 8);
    }

    async passwordFor(identityId: string): Promise<string> {
        const key = await this.deriveKey();
        const mac = createHmac('sha256', key).update('arcade:' + String(identityId)).digest();
        return mac.toString('base64url');   // 43 字符，足够熵且不含特殊符号
    }

    /** 游戏厅账号名的白名单口径（与 Worker 的 validName 一致：2~24 字，中文/字母/数字/._-） */
    validName(name: string): boolean {
        const s = String(name || '');
        return s.length >= 2 && s.length <= 24 && /^[\u4e00-\u9fa5A-Za-z0-9._-]+$/.test(s);
    }

    async current(identityId: string): Promise<{ name: string; password: string; auto: boolean; autoName: string }> {
        const autoName = this.autoName(identityId);
        const link = await this.links.findOne({ where: { identityId } });
        return {
            name: link ? link.name : autoName,
            password: await this.passwordFor(identityId),
            auto: link ? link.auto : true,
            autoName,
        };
    }

    /** 绑定一个已有的游戏厅账号名（客户端确认过它能用这个派生口令登录之后才调这里） */
    async bind(identityId: string, name: string): Promise<{ name: string; auto: boolean }> {
        const n = String(name || '').trim();
        if (!this.validName(n))
            throw new BadRequestException('游戏厅账号名不合法（2~24 字，中文/字母/数字/._-）');
        const existing = await this.links.findOne({ where: { identityId } });
        if (existing)
            await this.links.update({ identityId }, { name: n, auto: n === this.autoName(identityId) });
        else
            await this.links.insert({ identityId, name: n, auto: n === this.autoName(identityId) });
        this.logger.log(`身份已绑定游戏厅账号：${n}`);
        return { name: n, auto: n === this.autoName(identityId) };
    }

    /** 解绑（回落到自动开号的名字；老账号不受影响，只是不再自动登录它） */
    async unbind(identityId: string): Promise<{ ok: true }> {
        await this.links.delete({ identityId });
        return { ok: true };
    }
}
