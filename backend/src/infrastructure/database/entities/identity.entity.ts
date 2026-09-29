import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

// 统一身份模块（spec: 统一身份 MVP）：一个登录主体一行。
// email 与 github 是两种 provider，各自占一行；后续绑定/合并走 claim_account 流程（MVP 只落 email）。
export enum IdentityProvider {
    EMAIL = 'email',
    GITHUB = 'github',
}

export enum IdentityStatus {
    PENDING = 'pending', // 已注册但邮箱未验证：不签发会话，用户名只是「预留」
    ACTIVE = 'active',
    DISABLED = 'disabled',
}

@Entity('identities')
// (provider, providerUid) 唯一：GitHub 绑定后同一 GH 账号不能落到两条身份上。
// email provider 的 providerUid 为 NULL，SQLite 唯一索引视 NULL 互不相等，故不影响邮箱注册。
@Unique(['provider', 'providerUid'])
export class Identity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // 唯一且可空（GitHub 身份可能尚未拿到邮箱）；SQLite 唯一索引允许多个 NULL
    @Column({ type: 'varchar', length: 254, nullable: true, unique: true })
    email: string | null;

    @Column('datetime', { nullable: true })
    emailVerifiedAt: Date | null;

    // 唯一且可空：pending 过期后由 sweepExpiredPendings 置 NULL 释放账号名，故不能 NOT NULL
    @Column({ type: 'varchar', length: 50, nullable: true, unique: true })
    username: string | null;

    @Column({ type: 'simple-enum', enum: IdentityProvider, default: IdentityProvider.EMAIL })
    provider: IdentityProvider;

    // GitHub 用户 id（字符串存，避免数值型 id 溢出）；邮箱身份为 NULL
    @Column({ type: 'varchar', length: 64, nullable: true })
    providerUid: string | null;

    @Column({ type: 'simple-enum', enum: IdentityStatus, default: IdentityStatus.PENDING })
    status: IdentityStatus;

    // pending 身份的存活期：到期即失效并释放用户名（未验证邮箱不得长期占用账号名）
    @Column('datetime', { nullable: true })
    pendingExpiresAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
