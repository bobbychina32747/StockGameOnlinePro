import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 消息类型：纯文本 / 文件（可带一句说明） / 链接（可带一句说明） */
export enum ChatMessageKind {
    TEXT = 'text',
    FILE = 'file',
    LINK = 'link',
}

/**
 * 一条私线消息（2026-10-27）。
 *
 * 不存「会话参与者」冗余列：归属由 threadId 决定，权限判断统一走 ChatService.resolveAccess，
 * 避免多处各写一套「我能不能看这条」的判据。
 */
@Entity('chat_messages')
export class ChatMessage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ type: 'varchar', length: 36 })
    threadId: string;

    @Index()
    @Column({ type: 'varchar', length: 36 })
    senderId: string;

    @Column({ type: 'varchar', length: 16, default: ChatMessageKind.TEXT })
    kind: ChatMessageKind;

    // 单调序号：毫秒级 createdAt 在同一毫秒内会撞车，只靠 (createdAt, uuid) 排序会把
    // 「先发的」排到后面（提交钩子跑全量测试时抓到过）。seq 由 ChatService 在单进程内
    // 严格递增分配，重启时从库里 MAX(seq) 续上，排序与分页游标都只认它。
    @Index()
    @Column({ type: 'integer', default: 0 })
    seq: number;

    @Column({ type: 'text', nullable: true })
    text: string | null;

    // kind=link 时的目标地址（只允许 http/https，服务端校验）
    @Column({ type: 'varchar', length: 2048, nullable: true })
    linkUrl: string | null;

    // kind=file 时指向 chat_attachments.id；发送成功时才回填附件行的 messageId
    @Column({ type: 'varchar', length: 36, nullable: true })
    attachmentId: string | null;

    // 对端读过的时间；null = 未读。个人站两人对话，已读回执用一条列就够
    @Column('datetime', { nullable: true })
    readAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
