import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ChatAttachment } from '../../infrastructure/database/entities/chat-attachment.entity';
import { ChatMessage, ChatMessageKind } from '../../infrastructure/database/entities/chat-message.entity';
import { ChatThread } from '../../infrastructure/database/entities/chat-thread.entity';
import { Identity, IdentityRole, IdentityStatus } from '../../infrastructure/database/entities/identity.entity';
import { IdentityService } from '../identity/identity.service';
import { ChatEventsService } from './chat-events.service';

/** 正文上限（字符）：够长，但不给「用聊天框当网盘」留口子 */
export const CHAT_TEXT_MAX = 4000;
/** 文件/链接附带的说明文字上限 */
export const CHAT_CAPTION_MAX = 500;
export const CHAT_LINK_MAX = 2048;
/** 单文件上限 20MB：图片直传够用，超出走网盘/链接 */
export const CHAT_FILE_LIMIT = 20 * 1024 * 1024;
export const CHAT_PAGE_MAX = 100;
/** 孤儿附件（传了没发）保留时长 */
export const CHAT_ORPHAN_TTL_MS = 48 * 60 * 60 * 1000;

export interface ChatAccess {
    thread: ChatThread;
    side: 'owner' | 'peer';
    me: { id: string; username: string; role: string };
    peer: { id: string; username: string };
}

export interface ChatMessageDto {
    id: string;
    kind: ChatMessageKind;
    text: string | null;
    linkUrl: string | null;
    attachment: { id: string; filename: string; mime: string; size: number; url: string } | null;
    sender: { id: string; username: string };
    createdAt: string;
    readAt: string | null;
}

export interface SendMessageInput {
    kind?: string;
    text?: string;
    linkUrl?: string;
    attachmentId?: string;
}

/**
 * 站内私线（2026-10-27）。
 *
 * 规则只有三条：
 *   1. 参与者只有两类：站主（IdentityService.isOwnerIdentity）与 role=subadmin 的受邀身份；
 *      其它任何已登录账号一律 403。这正是用户要的「只有她能跟我聊天」。
 *   2. 一对 (owner, peer) 一条 thread，按需创建（不预置），不提供群聊与会话列表。
 *   3. 上行（发消息/上传/已读/输入中）全走 REST，下行推送走 SSE —— 权限与校验只有一份实现。
 */
@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ChatService.name);
    private timer: any = null;
    /** 简化限流：identityId → 最近操作时间戳；只防手滑刷屏与脚本，不做精密配额 */
    private readonly buckets = new Map<string, number[]>();
    /** 消息序号发号器（毫秒*1000 + 进程内自增），保证同一毫秒内也严格递增 */
    private lastSeq = 0;

    constructor(
        @InjectRepository(ChatThread) private readonly threadRepo: Repository<ChatThread>,
        @InjectRepository(ChatMessage) private readonly messageRepo: Repository<ChatMessage>,
        @InjectRepository(ChatAttachment) private readonly attachmentRepo: Repository<ChatAttachment>,
        @InjectRepository(Identity) private readonly identityRepo: Repository<Identity>,
        private readonly identity: IdentityService,
        private readonly events: ChatEventsService,
    ) {}

    onModuleInit(): void {
        // 一小时清理一次「传了没发」的附件；unref 让定时器不拖住进程退出
        this.timer = setInterval(() => this.cleanupOrphans().catch(() => undefined), 60 * 60 * 1000);
        this.timer.unref?.();
        // 序号发号器从库里续上：重启后新消息仍然排在旧消息之后（不受系统时钟回拨影响）
        this.messageRepo.createQueryBuilder('m')
            .select('MAX(m.seq)', 'max')
            .getRawOne()
            .then((row) => {
                const max = Number(row?.max) || 0;
                if (max > this.lastSeq)
                    this.lastSeq = max;
                this.logger.log(`私线消息序号从 ${this.lastSeq} 续号`);
            })
            .catch(() => undefined);
    }

    /** 严格递增的消息序号：同一毫秒内连发也不会撞车（排序/分页只认它） */
    private nextSeq(): number {
        const base = Date.now() * 1000;
        this.lastSeq = base > this.lastSeq ? base : this.lastSeq + 1;
        return this.lastSeq;
    }

    onModuleDestroy(): void {
        if (this.timer)
            clearInterval(this.timer);
    }

    // ───────────────────────── 访问控制 ─────────────────────────

    /**
     * 解析当前会话在私线里的位置。任何写操作/读操作之前都必须先过这里。
     * owner 侧找不到 subadmin、或 peer 侧找不到站主时抛 409（部署后忘记建 tina 账号会在这里显形）。
     */
    async resolveAccess(identity: Identity): Promise<ChatAccess> {
        if (!identity || !identity.id)
            throw new ForbiddenException('需要登录后才能使用对话');

        const isOwner = await this.identity.isOwnerIdentity(identity);
        const isPeer = identity.role === IdentityRole.SUBADMIN;
        if (!isOwner && !isPeer)
            throw new ForbiddenException('对话仅对站主与受邀账号开放');

        let side: 'owner' | 'peer';
        let ownerId: string;
        let peerId: string;

        if (isOwner) {
            side = 'owner';
            ownerId = String(identity.id);
            const peer = await this.identityRepo.findOne({
                where: { role: IdentityRole.SUBADMIN, status: IdentityStatus.ACTIVE },
                order: { createdAt: 'ASC' },
            });
            if (!peer || peer.id === identity.id)
                throw new ConflictException('还没有受邀账号（role=subadmin），请先创建 tina');
            peerId = peer.id;
        }
        else {
            side = 'peer';
            peerId = String(identity.id);
            const oldest = await this.identity.findOldestActiveIdentityId();
            if (!oldest || oldest === identity.id)
                throw new ConflictException('站主身份尚未就绪（库里还没有更早注册的已验证身份）');
            ownerId = oldest;
        }

        const thread = await this.ensureThread(ownerId, peerId);
        const peerIdentity = await this.identityRepo.findOne({ where: { id: side === 'owner' ? peerId : ownerId } });

        return {
            thread,
            side,
            me: { id: String(identity.id), username: String(identity.username || ''), role: String(identity.role || IdentityRole.USER) },
            peer: {
                id: side === 'owner' ? peerId : ownerId,
                username: String(peerIdentity?.username || (side === 'owner' ? '朋友' : '站主')),
            },
        };
    }

    /** 前端进页面第一件事：我能不能聊、跟谁聊、有几条未读 */
    async getAccess(identity: Identity) {
        const access = await this.resolveAccess(identity);
        const unread = await this.countUnread(access);
        return {
            allowed: true,
            side: access.side,
            me: access.me,
            peer: access.peer,
            threadId: access.thread.id,
            unread,
            // 「对方在线」只算另一个身份的连接：自己开着页面不算对方在线
            online: this.events.peerOnline(access.thread.id, access.me.id),
            limits: { fileBytes: CHAT_FILE_LIMIT, textChars: CHAT_TEXT_MAX },
        };
    }

    private async ensureThread(ownerId: string, peerId: string): Promise<ChatThread> {
        const existing = await this.threadRepo.findOne({ where: { ownerId, peerId } });
        if (existing)
            return existing;
        try {
            return await this.threadRepo.save(this.threadRepo.create({ ownerId, peerId, lastMessageAt: null }));
        }
        catch (e) {
            // 并发首条消息：唯一索引保证只有一个赢家，输的一方重新读一次即可
            const again = await this.threadRepo.findOne({ where: { ownerId, peerId } });
            if (again)
                return again;
            throw e;
        }
    }

    // ───────────────────────── 读 ─────────────────────────

    /**
     * 分页读历史（倒序取 + 反转成升序返回，方便前端直接 append）。
     * before = 已加载的最早一条消息 id；不传则以最新一页开始。
     */
    async listMessages(identity: Identity, opts: { before?: string; limit?: number } = {}) {
        const access = await this.resolveAccess(identity);
        const limit = Math.min(CHAT_PAGE_MAX, Math.max(1, Number(opts.limit) || 30));

        let before: ChatMessage | null = null;
        if (opts.before) {
            before = await this.messageRepo.findOne({ where: { id: String(opts.before), threadId: access.thread.id } });
            if (!before)
                throw new BadRequestException('分页游标无效');
        }

        const qb = this.messageRepo.createQueryBuilder('m')
            .where('m.threadId = :threadId', { threadId: access.thread.id })
            .orderBy('m.seq', 'DESC')
            .take(limit + 1);
        if (before) {
            // 游标是消息 id（对客户端稳定），服务端换算成 seq 做严格更早的取数
            qb.andWhere('m.seq < :seq', { seq: before.seq });
        }
        const rows = await qb.getMany();
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit).reverse();
        const dtos = await this.toDtos(page);

        return {
            messages: dtos,
            hasMore,
            peer: access.peer,
            me: access.me,
            side: access.side,
            threadId: access.thread.id,
        };
    }

    private async countUnread(access: ChatAccess): Promise<number> {
        return this.messageRepo.createQueryBuilder('m')
            .where('m.threadId = :threadId', { threadId: access.thread.id })
            .andWhere('m.senderId != :me', { me: access.me.id })
            .andWhere('m.readAt IS NULL')
            .getCount();
    }

    private async toDtos(messages: ChatMessage[]): Promise<ChatMessageDto[]> {
        if (!messages.length)
            return [];
        const attachmentIds = messages.map((m) => m.attachmentId).filter(Boolean) as string[];
        const attachments = attachmentIds.length
            ? await this.attachmentRepo.find({ where: { id: In(attachmentIds) } })
            : [];
        const attachmentMap = new Map(attachments.map((a) => [a.id, a]));

        const senderIds = Array.from(new Set(messages.map((m) => m.senderId)));
        const senders = senderIds.length
            ? await this.identityRepo.find({ where: { id: In(senderIds) } })
            : [];
        const senderMap = new Map(senders.map((s) => [s.id, String(s.username || '')]));

        return messages.map((m) => {
            const attachment = m.attachmentId ? attachmentMap.get(m.attachmentId) : null;
            return {
                id: m.id,
                kind: m.kind,
                text: m.text,
                linkUrl: m.linkUrl,
                attachment: attachment
                    ? {
                        id: attachment.id,
                        filename: attachment.filename,
                        mime: attachment.mime,
                        size: attachment.size,
                        url: `/api/chat/files/${attachment.id}`,
                    }
                    : null,
                sender: { id: m.senderId, username: senderMap.get(m.senderId) || '' },
                createdAt: new Date(m.createdAt).toISOString(),
                readAt: m.readAt ? new Date(m.readAt).toISOString() : null,
            };
        });
    }

    // ───────────────────────── 写 ─────────────────────────

    async send(identity: Identity, input: SendMessageInput): Promise<ChatMessageDto> {
        const access = await this.resolveAccess(identity);
        this.assertRate(`msg:${access.me.id}`, 40, 60_000);

        const kind = String(input?.kind || ChatMessageKind.TEXT) as ChatMessageKind;
        if (![ChatMessageKind.TEXT, ChatMessageKind.FILE, ChatMessageKind.LINK].includes(kind))
            throw new BadRequestException('不支持的消息类型');

        let text: string | null = null;
        let linkUrl: string | null = null;
        let attachmentId: string | null = null;
        let attachment: ChatAttachment | null = null;

        if (kind === ChatMessageKind.TEXT) {
            text = this.normalizeText(input?.text, CHAT_TEXT_MAX, '消息内容不能为空');
            if (input?.linkUrl)
                throw new BadRequestException('文本消息不接受 linkUrl 字段');
        }
        else if (kind === ChatMessageKind.LINK) {
            linkUrl = this.validateLink(input?.linkUrl);
            text = this.maybeText(input?.text, CHAT_CAPTION_MAX);
            if (input?.attachmentId)
                throw new BadRequestException('链接消息不接受附件');
        }
        else {
            attachmentId = String(input?.attachmentId || '');
            if (!attachmentId)
                throw new BadRequestException('文件消息缺少 attachmentId');
            attachment = await this.attachmentRepo.findOne({ where: { id: attachmentId, threadId: access.thread.id } });
            if (!attachment)
                throw new BadRequestException('附件不存在或不属于这条会话');
            if (attachment.uploaderId !== access.me.id)
                throw new ForbiddenException('只能发送自己上传的附件');
            if (attachment.messageId)
                throw new BadRequestException('该附件已经发送过了');
            text = this.maybeText(input?.text, CHAT_CAPTION_MAX);
        }

        const saved = await this.messageRepo.save(this.messageRepo.create({
            threadId: access.thread.id,
            senderId: access.me.id,
            kind,
            text,
            linkUrl,
            attachmentId,
            readAt: null,
            // seq 只用于排序：毫秒创建时间在同一毫秒内会撞车，uuid 又不保序
            seq: this.nextSeq(),
            createdAt: new Date(),
        }));

        if (attachment) {
            attachment.messageId = saved.id;
            await this.attachmentRepo.save(attachment);
        }
        await this.threadRepo.update({ id: access.thread.id }, { lastMessageAt: saved.createdAt });

        const dto = (await this.toDtos([saved]))[0];
        this.events.publish(access.thread.id, 'message', dto);
        return dto;
    }

    /** 已读回执：把对端发给我、还没读的全部标成已读 */
    async markRead(identity: Identity) {
        const access = await this.resolveAccess(identity);
        const now = new Date();
        const res = await this.messageRepo.createQueryBuilder()
            .update()
            .set({ readAt: now })
            .where('threadId = :threadId', { threadId: access.thread.id })
            .andWhere('senderId != :me', { me: access.me.id })
            .andWhere('readAt IS NULL')
            .execute();
        const affected = res.affected || 0;
        if (affected > 0)
            this.events.publish(access.thread.id, 'read', { at: now.toISOString(), by: access.me.id, count: affected });
        return { success: true, affected, at: now.toISOString() };
    }

    /** 「对方正在输入」：纯瞬态事件，不落库（限流宽松，5 秒一次足够） */
    async typing(identity: Identity) {
        const access = await this.resolveAccess(identity);
        this.assertRate(`typing:${access.me.id}`, 12, 10_000);
        this.events.publish(access.thread.id, 'typing', { by: access.me.id, username: access.me.username, at: new Date().toISOString() });
        return { success: true };
    }

    // ───────────────────────── 附件 ─────────────────────────

    uploadDir(): string {
        return process.env.CHAT_UPLOAD_DIR || path.join(process.cwd(), 'data', 'chat-uploads');
    }

    incomingDir(): string {
        return path.join(this.uploadDir(), 'incoming');
    }

    /**
     * multer 已把文件落到 incoming/ 的临时名，这里做「归属 + 改名 + 建行」。
     * 先落临时目录再按 threadId 归档：上传拦截器拿不到 thread（要异步查库），
     * 而把它塞进拦截器会让上传路径变成两条异步链，出错更难定位。
     */
    async registerUpload(identity: Identity, file: { originalname?: string; mimetype?: string; size?: number; filename?: string }) {
        const access = await this.resolveAccess(identity);
        this.assertRate(`upload:${access.me.id}`, 12, 60_000);

        if (!file || !file.filename)
            throw new BadRequestException('没有收到文件');
        const size = Number(file.size) || 0;
        if (size <= 0)
            throw new BadRequestException('文件为空');
        if (size > CHAT_FILE_LIMIT)
            throw new BadRequestException(`文件超过 ${Math.floor(CHAT_FILE_LIMIT / 1048576)}MB 上限`);

        const tmpPath = path.join(this.incomingDir(), path.basename(file.filename));
        const dir = path.join(this.uploadDir(), access.thread.id);
        await fs.mkdir(dir, { recursive: true });
        const finalName = path.basename(file.filename);
        const finalPath = path.join(dir, finalName);
        await fs.rename(tmpPath, finalPath).catch(async (e) => {
            // 目标已存在（理论上随机名不会）或跨盘：降级为复制后删除
            if (e && e.code === 'EXDEV') {
                await fs.copyFile(tmpPath, finalPath);
                await fs.unlink(tmpPath).catch(() => undefined);
                return;
            }
            throw e;
        });

        const filename = this.safeFilename(file.originalname);
        const mime = String(file.mimetype || 'application/octet-stream').slice(0, 120);
        const saved = await this.attachmentRepo.save(this.attachmentRepo.create({
            threadId: access.thread.id,
            uploaderId: access.me.id,
            filename,
            mime,
            size,
            storageKey: `${access.thread.id}/${finalName}`,
            messageId: null,
        }));

        return {
            attachment: {
                id: saved.id,
                filename: saved.filename,
                mime: saved.mime,
                size: saved.size,
                url: `/api/chat/files/${saved.id}`,
            },
        };
    }

    /** 下载/预览：只有这条会话的两个参与者能取 */
    async openFile(identity: Identity, attachmentId: string) {
        const access = await this.resolveAccess(identity);
        const attachment = await this.attachmentRepo.findOne({ where: { id: String(attachmentId), threadId: access.thread.id } });
        if (!attachment)
            throw new NotFoundException('文件不存在');
        const absPath = this.resolveStoragePath(attachment.storageKey);
        try {
            await fs.access(absPath);
        }
        catch {
            throw new NotFoundException('文件已不在服务器上');
        }
        return { attachment, absPath };
    }

    /** storageKey 是我们自己生成的，仍然做一次形状校验，避免库里脏数据变成任意文件读取 */
    private resolveStoragePath(storageKey: string): string {
        const key = String(storageKey || '');
        if (!/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/.test(key))
            throw new NotFoundException('文件不存在');
        const base = this.uploadDir();
        const abs = path.resolve(base, key);
        if (!abs.startsWith(path.resolve(base) + path.sep))
            throw new NotFoundException('文件不存在');
        return abs;
    }

    /** 清理「传了没发」的附件 + incoming 里的临时残留（崩溃/中断留下） */
    async cleanupOrphans(): Promise<{ removedRows: number; removedFiles: number }> {
        const cutoff = new Date(Date.now() - CHAT_ORPHAN_TTL_MS);
        const rows = await this.attachmentRepo.find({ where: { messageId: IsNull() } });
        let removedRows = 0;
        let removedFiles = 0;
        for (const row of rows) {
            if (new Date(row.createdAt).getTime() > cutoff.getTime())
                continue;
            try {
                await fs.unlink(this.resolveStoragePath(row.storageKey));
                removedFiles += 1;
            }
            catch {
                // 文件已经不在（或被手工删过）也算清理成功，继续删行
            }
            await this.attachmentRepo.delete({ id: row.id });
            removedRows += 1;
        }

        // incoming 里的残留：按 mtime 判断，48 小时前的直接删
        try {
            const files = await fs.readdir(this.incomingDir());
            for (const name of files) {
                const p = path.join(this.incomingDir(), name);
                try {
                    const st = await fs.stat(p);
                    if (st.isFile() && Date.now() - st.mtimeMs > CHAT_ORPHAN_TTL_MS) {
                        await fs.unlink(p);
                        removedFiles += 1;
                    }
                }
                catch {
                    // 单个文件失败不影响其它
                }
            }
        }
        catch {
            // incoming 目录还不存在：正常
        }

        if (removedRows || removedFiles)
            this.logger.log(`私线清理：删除 ${removedRows} 条孤儿附件、${removedFiles} 个文件`);
        return { removedRows, removedFiles };
    }

    // ───────────────────────── 小工具 ─────────────────────────

    private normalizeText(raw: string | undefined, max: number, emptyMessage: string): string {
        const text = this.maybeText(raw, max);
        if (!text)
            throw new BadRequestException(emptyMessage);
        return text;
    }

    private maybeText(raw: string | undefined, max: number): string | null {
        if (raw === undefined || raw === null)
            return null;
        // 去掉除 \n \t 外的控制字符（防日志注入/终端转义混进消息体）
        const text = String(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n/g, '\n').trim();
        if (!text)
            return null;
        if (text.length > max)
            throw new BadRequestException(`内容超过 ${max} 字上限`);
        return text;
    }

    private validateLink(raw: string | undefined): string {
        const value = String(raw || '').trim();
        if (!value)
            throw new BadRequestException('请填写链接地址');
        if (value.length > CHAT_LINK_MAX)
            throw new BadRequestException('链接过长');
        let parsed: URL;
        try {
            parsed = new URL(value);
        }
        catch {
            throw new BadRequestException('链接格式不正确（需要 http:// 或 https:// 开头）');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            throw new BadRequestException('只支持 http/https 链接');
        return parsed.toString();
    }

    private safeFilename(raw: string | undefined): string {
        const name = this.decodeLatin1Utf8(String(raw || ''))
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .replace(/[\\/]/g, '_')
            .trim()
            .slice(0, 200);
        return name || 'file';
    }

    /**
     * multer/busboy 按 latin1 解 multipart 的 filename：浏览器发的是 UTF-8 字节，
     * 于是「私线测试.pdf」会变成「ç§çº¿æµè¯.pdf」。这里按 latin1 → Buffer → UTF-8 还原，
     * 只在「结果里没有替换字符」时采信（避免把真正的 latin1 文件名改坏）。
     */
    private decodeLatin1Utf8(value: string): string {
        if (!value || !/[\x80-\xff]/.test(value))
            return value;
        if (!/^[\x09\x0a\x0d\x20-\xff]*$/.test(value))
            return value; // 已含 >255 的字符：本来就是正确的 Unicode，不要动
        const utf8 = Buffer.from(value, 'latin1').toString('utf8');
        return utf8.includes('\uFFFD') ? value : utf8;
    }

    private assertRate(key: string, max: number, windowMs: number): void {
        const now = Date.now();
        const hits = (this.buckets.get(key) || []).filter((t) => now - t < windowMs);
        if (hits.length >= max)
            throw new HttpException('操作太频繁了，先歇一下', HttpStatus.TOO_MANY_REQUESTS);
        hits.push(now);
        this.buckets.set(key, hits);
        if (this.buckets.size > 5000) {
            // 简单防内存膨胀：超过阈值就清掉已经过期的桶
            for (const [k, arr] of this.buckets) {
                if (!arr.length || now - arr[arr.length - 1] > windowMs)
                    this.buckets.delete(k);
            }
        }
    }
}
