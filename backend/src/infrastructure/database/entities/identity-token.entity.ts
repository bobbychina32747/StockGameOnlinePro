import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Identity } from './identity.entity';

// 一次性身份令牌（邮箱验证 / 改密 / 账号认领）。
// 规格原文只列了三张表——令牌必须落库且只存哈希（C10），故新增本表，见模块 README「有意的偏离」。
export enum IdentityTokenPurpose {
    VERIFY_EMAIL = 'verify_email',
    RESET_PASSWORD = 'reset_password',
    CLAIM_ACCOUNT = 'claim_account',
}

@Entity('identity_tokens')
export class IdentityToken {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    identityId: string;

    @ManyToOne(() => Identity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'identityId' })
    identity: Identity;

    // 令牌绑定用途：verify 令牌不能拿去重置密码（消费时按 purpose 匹配）
    @Column({ type: 'simple-enum', enum: IdentityTokenPurpose })
    purpose: IdentityTokenPurpose;

    @Index()
    @Column({ type: 'varchar', length: 64, unique: true })
    tokenHash: string;

    @Column('datetime')
    expiresAt: Date;

    // 非空 = 已用过（一次一废），保留行以便审计与「链接已被使用」判定
    @Column('datetime', { nullable: true })
    usedAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;
}
