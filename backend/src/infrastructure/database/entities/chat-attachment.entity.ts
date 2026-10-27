import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 私线附件（2026-10-27）。
 *
 * 上传与发送分两步：先 POST /api/chat/upload 落盘并建行（messageId 为空），
 * 再 POST /api/chat/messages {kind:'file', attachmentId} 绑定到消息。
 * 好处是上传进度与消息发送解耦，失败重试不会产生半条消息；代价是要清理「传了没发」的孤儿文件，
 * 由 ChatService 的定时清理负责（48 小时）。
 *
 * 落盘路径：CHAT_UPLOAD_DIR/<threadId>/<随机 32 hex><安全扩展名>，库里只存相对 key，
 * 原始文件名单独存（不参与路径，避免路径穿越与同名覆盖）。
 */
@Entity('chat_attachments')
export class ChatAttachment {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'varchar', length: 36 })
    threadId: string;

    @Column({ type: 'varchar', length: 36 })
    uploaderId: string;

    // 展示用原始文件名（已做控制字符/路径分隔符清洗，最长 200 字符）
    @Column({ type: 'varchar', length: 200 })
    filename: string;

    @Column({ type: 'varchar', length: 120 })
    mime: string;

    @Column({ type: 'integer' })
    size: number;

    // 相对 CHAT_UPLOAD_DIR 的路径（形如 <threadId>/<32hex>.png）
    @Column({ type: 'varchar', length: 128 })
    storageKey: string;

    @Index()
    @Column({ type: 'varchar', length: 36, nullable: true })
    messageId: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
