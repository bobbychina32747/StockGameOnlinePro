import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 私线会话（2026-10-27 站内对话功能）。
 *
 * 设计取舍：个人站只有「站主 ↔ 受邀朋友」这种两人一对的关系，不需要群聊/多会话列表；
 * 但也不把两边 id 硬编码进配置——而是一对 (ownerId, peerId) 一行，未来 invite 第二个朋友
 * 自然就是第二条 thread，前端一个 `access` 请求就能知道该开哪条。
 *
 * ownerId 用「站主身份」（IdentityService.isOwnerIdentity 的判定结果），peerId 用 role=subadmin 的身份。
 */
@Entity('chat_threads')
@Unique(['ownerId', 'peerId'])
export class ChatThread {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 36 })
    ownerId: string;

    @Column({ type: 'varchar', length: 36 })
    peerId: string;

    // 列表排序 / 「有新消息」提示用；发送时更新，不做外键关联消息表（避免每次发送都要 count）
    @Column('datetime', { nullable: true })
    lastMessageAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
