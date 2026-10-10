import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, PayloadTooLargeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';

import { AppSecret } from '../../infrastructure/database/entities/app-secret.entity';
import { GameSave } from '../../infrastructure/database/entities/game-save.entity';
import { IdentitySecret } from '../../infrastructure/database/entities/identity-secret.entity';

/** 单份存档上限（密文长度）：与老方案一致的 1MB 量级，避免误传大文件把库撑爆 */
export const MAX_SAVE_BYTES = 2 * 1024 * 1024;
/** 每个身份最多保留多少槽位（全局配额，防止刷库） */
export const MAX_SLOTS_PER_IDENTITY = 200;
/** 主密钥的落库名字（环境变量缺失时使用） */
const MASTER_SECRET_NAME = 'saves.master';

/**
 * 云存档服务（2026-10-08）
 *
 * 三件事：
 *  1. **密钥托管**：给已授权客户端下发该身份的存档密钥（服务端只保管、不用于解密文件内容）；
 *  2. **存档读写**：按 (identityId, game, slot) 存密文，服务端做体积/配额/哈希校验；
 *  3. **迁移**：老存档（游戏厅口令派生密钥加密）由客户端解密后用新密钥重新加密上传，标记 migrated。
 *
 * 为什么密钥要托管而不是让客户端自己派生：
 *   老方案把密钥绑在"游戏厅口令"上 —— 换设备、改口令、换成第三方登录都会把老存档锁死。
 *   托管之后**钥匙跟着账号走**，与登录方式（口令 / GitHub / 以后的任何 provider）完全解耦。
 *   代价：服务端理论上能看到密钥 ⇒ 能解密存档。对"个人站 + 游戏存档"是可接受的取舍，
 *   且比"用户丢档"好；真要端到端零知识，就需要用户再记一个独立口令（回到今天的问题）。
 */
@Injectable()
export class GameSavesService implements OnModuleInit {
    private readonly logger = new Logger('GameSaves');
    private cachedMaster: Buffer | null = null;

    constructor(
        @InjectRepository(GameSave) private readonly saves: Repository<GameSave>,
        @InjectRepository(IdentitySecret) private readonly secrets: Repository<IdentitySecret>,
        @InjectRepository(AppSecret) private readonly appSecrets: Repository<AppSecret>,
    ) {}

    async onModuleInit(): Promise<void> {
        try {
            await this.masterKey();
        }
        catch (e: any) {
            this.logger.error(`存档主密钥初始化失败：${e && e.message ? e.message : String(e)}`);
        }
    }

    // ───────────────────────── 主密钥（服务端） ─────────────────────────

    /**
     * 服务端主密钥（32 字节）：用于包裹每个身份的存档密钥。
     * 优先级：`SAVES_MASTER_KEY`（hex，部署侧首选）→ `IDENTITY_ENC_KEY`（既有身份加密密钥，复用）→ 落库随机值。
     * 落库是为了"零配置也能立刻跑"；部署侧一旦配上环境变量，落库值就不再被读取（新身份用新密钥包裹）。
     */
    async masterKey(): Promise<Buffer> {
        if (this.cachedMaster)
            return this.cachedMaster;
        const inline = String(process.env.SAVES_MASTER_KEY || process.env.IDENTITY_ENC_KEY || '').trim();
        if (inline) {
            this.cachedMaster = createHash('sha256').update(inline, 'utf8').digest();
            return this.cachedMaster;
        }
        const row = await this.appSecrets.findOne({ where: { name: MASTER_SECRET_NAME } });
        if (row && /^[0-9a-f]{64}$/i.test(String(row.value).trim())) {
            this.cachedMaster = Buffer.from(String(row.value).trim(), 'hex');
            return this.cachedMaster;
        }
        // Never overwrite existing key material or serve an unpersisted key.
        if (row) throw new Error('存档主密钥格式损坏，已拒绝重新生成');
        await this.appSecrets.createQueryBuilder().insert()
            .values({ name: MASTER_SECRET_NAME, value: randomBytes(32).toString('hex') })
            .orIgnore().execute();
        const persisted = await this.appSecrets.findOne({ where: { name: MASTER_SECRET_NAME } });
        if (!persisted || !/^[0-9a-f]{64}$/i.test(String(persisted.value).trim()))
            throw new Error('存档主密钥未能持久化');
        this.cachedMaster = Buffer.from(String(persisted.value).trim(), 'hex');
        return this.cachedMaster;
    }

    // ───────────────────────── 身份密钥 ─────────────────────────

    /** 该身份的存档密钥（明文 32 字节）；首次访问时生成并包裹落库 */
    async identityKey(identityId: string): Promise<Buffer> {
        const id = String(identityId || '').trim();
        if (!id)
            throw new BadRequestException('缺少身份');
        const master = await this.masterKey();
        const row = await this.secrets.findOne({ where: { identityId: id } });
        if (row && row.saveKey) {
            try {
                return this.unwrap(master, row.saveKey);
            }
            catch {
                // 包裹串坏掉/主密钥换过：不能静默生成新的（否则老存档全废），明确报错让人来处理
                this.logger.error(`身份 ${id} 的存档密钥无法解封（主密钥变更或密文损坏），已拒绝生成新密钥`);
                throw new BadRequestException('存档密钥不可用，请联系管理员');
            }
        }
        const fresh = randomBytes(32);
        const wrapped = this.wrap(master, fresh);
        // The primary key and conditional update arbitrate across requests/processes.
        await this.secrets.createQueryBuilder().insert()
            .values({ identityId: id, saveKey: wrapped }).orIgnore().execute();
        await this.secrets.createQueryBuilder().update()
            .set({ saveKey: wrapped }).where('identityId = :id', { id })
            .andWhere('saveKey IS NULL').execute();
        const persisted = await this.secrets.findOne({ where: { identityId: id } });
        if (!persisted || !persisted.saveKey) throw new BadRequestException('存档密钥未能持久化');
        return this.unwrap(master, persisted.saveKey);
    }

    /** 客户端取密钥（仅在已授权 + saves scope 的请求下调用） */
    async keyForClient(identityId: string) {
        const key = await this.identityKey(identityId);
        return { key: key.toString('base64'), alg: 'AES-256-GCM', bytes: key.length, createdAt: new Date().toISOString() };
    }

    private wrap(master: Buffer, plain: Buffer): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', master, iv);
        const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
        return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    }

    private unwrap(master: Buffer, packed: string): Buffer {
        const parts = String(packed || '').split('.');
        if (parts.length !== 4 || parts[0] !== 'v1')
            throw new Error('包裹格式不识别');
        const iv = Buffer.from(parts[1], 'base64url');
        const tag = Buffer.from(parts[2], 'base64url');
        const ct = Buffer.from(parts[3], 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', master, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    }

    // ───────────────────────── 存档读写 ─────────────────────────

    /** 游戏标识白名单口径：字母数字与 . _ - ，2~64 位（防止用 game 字段拼奇怪的东西） */
    normalizeGame(game: string): string {
        const g = String(game || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{2,64}$/.test(g))
            throw new BadRequestException('游戏标识不合法');
        return g;
    }

    normalizeSlot(slot: string): string {
        const s = String(slot || '').trim();
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(s))
            throw new BadRequestException('槽位名不合法（1~64 位字母/数字/._-）');
        return s;
    }

    private sha256(text: string): string {
        return createHash('sha256').update(text, 'utf8').digest('hex');
    }

    async list(identityId: string, game: string) {
        const g = this.normalizeGame(game);
        const rows = await this.saves.find({ where: { identityId, game: g }, order: { updatedAt: 'DESC' } });
        return {
            game: g,
            slots: rows.map((r) => ({
                slot: r.slot,
                bytes: r.bytes,
                sha256: r.sha256,
                meta: r.meta || null,
                migrated: !!r.migrated,
                updatedAt: r.updatedAt,
            })),
        };
    }

    async get(identityId: string, game: string, slot: string) {
        const g = this.normalizeGame(game);
        const s = this.normalizeSlot(slot);
        const row = await this.saves.findOne({ where: { identityId, game: g, slot: s } });
        if (!row)
            throw new NotFoundException('没有这个存档');
        return { game: g, slot: row.slot, data: row.data, sha256: row.sha256, bytes: row.bytes, meta: row.meta || null, migrated: !!row.migrated, updatedAt: row.updatedAt };
    }

    async put(identityId: string, game: string, slot: string, data: string, meta?: Record<string, any> | null, migrated = false) {
        const g = this.normalizeGame(game);
        const s = this.normalizeSlot(slot);
        const payload = String(data || '');
        if (!payload)
            throw new BadRequestException('存档内容为空');
        const bytes = Buffer.byteLength(payload, 'utf8');
        if (bytes > MAX_SAVE_BYTES)
            throw new PayloadTooLargeException(`单份存档上限 ${Math.round(MAX_SAVE_BYTES / 1024)}KB`);

        const existing = await this.saves.findOne({ where: { identityId, game: g, slot: s } });
        if (!existing) {
            const count = await this.saves.count({ where: { identityId } });
            if (count >= MAX_SLOTS_PER_IDENTITY)
                throw new BadRequestException(`存档槽位已达上限（${MAX_SLOTS_PER_IDENTITY}）`);
        }
        const sha256 = this.sha256(payload);
        const row = existing || this.saves.create({ identityId, game: g, slot: s });
        row.data = payload;
        row.sha256 = sha256;
        row.bytes = bytes;
        row.meta = meta && typeof meta === 'object' ? meta : null;
        row.migrated = !!migrated || !!row.migrated;
        await this.saves.save(row);
        return { ok: true, game: g, slot: s, sha256, bytes, updatedAt: row.updatedAt };
    }

    async remove(identityId: string, game: string, slot: string) {
        const g = this.normalizeGame(game);
        const s = this.normalizeSlot(slot);
        const res = await this.saves.delete({ identityId, game: g, slot: s });
        return { ok: true, removed: res.affected || 0 };
    }

    /** 该身份所有游戏的存档概览（迁移引导与"换设备"页用） */
    async summary(identityId: string) {
        const rows = await this.saves.find({ where: { identityId }, order: { updatedAt: 'DESC' } });
        const byGame = new Map<string, { game: string; slots: number; bytes: number; migrated: number; lastUpdatedAt: Date }>();
        for (const r of rows) {
            const cur = byGame.get(r.game) || { game: r.game, slots: 0, bytes: 0, migrated: 0, lastUpdatedAt: r.updatedAt };
            cur.slots += 1;
            cur.bytes += r.bytes;
            if (r.migrated)
                cur.migrated += 1;
            if (new Date(r.updatedAt).getTime() > new Date(cur.lastUpdatedAt).getTime())
                cur.lastUpdatedAt = r.updatedAt;
            byGame.set(r.game, cur);
        }
        return { games: [...byGame.values()], totalSlots: rows.length, keyReady: true };
    }

    /** 老存档迁移标记（客户端解密后用新密钥重新上传时带 migrated=true） */
    async markMigrated(identityId: string, game: string, slot: string) {
        const g = this.normalizeGame(game);
        const s = this.normalizeSlot(slot);
        await this.saves.update({ identityId, game: g, slot: s }, { migrated: true });
        return { ok: true };
    }

    /** 迁移完成度（前端用它决定是否还弹迁移引导） */
    async migrationStatus(identityId: string) {
        const summary = await this.summary(identityId);
        return {
            ...summary,
            needsMigration: summary.totalSlots === 0,
            hint: summary.totalSlots === 0
                ? '还没有服务端存档：如果你在旧版游戏厅/GitHub 里存过档，用「迁移老存档」一次性搬过来'
                : '存档已经在服务端托管；旧设备上的老存档可以在设置里再迁移一次',
        };
    }

    /** 账本级配额信息（界面显示用） */
    quota(identityId: string) {
        return { maxSaveBytes: MAX_SAVE_BYTES, maxSlots: MAX_SLOTS_PER_IDENTITY, identityId };
    }
}
