import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Identity } from './identity.entity';

// 会话表：只存令牌哈希。库被读走也无法反推出可用令牌（C10：令牌仅以哈希落库）
@Entity('sessions')
export class Session {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    identityId: string;

    @ManyToOne(() => Identity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'identityId' })
    identity: Identity;

    // sha256 hex = 64 字符；unique 让鉴权查询走索引且天然防止重复令牌
    @Index()
    @Column({ type: 'varchar', length: 64, unique: true })
    tokenHash: string;

    @Column('datetime')
    expiresAt: Date;

    @Column('datetime', { nullable: true })
    revokedAt: Date | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    ua: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    ip: string | null;

    @CreateDateColumn()
    createdAt: Date;
}
