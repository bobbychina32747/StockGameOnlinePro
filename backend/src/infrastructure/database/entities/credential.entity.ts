import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    OneToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { Identity } from './identity.entity';

// 凭据与身份 1:1 拆表：口令/二次验证材料与身份属性（邮箱、状态、provider）生命周期不同，
// 查询身份列表时不会顺手把口令哈希带出去（最小暴露面）。
@Entity('credentials')
export class Credential {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // unique 即 1:1 约束；CASCADE 让删除身份时凭据自动清理，不留孤儿密码
    @Column({ unique: true })
    identityId: string;

    @OneToOne(() => Identity, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'identityId' })
    identity: Identity;

    // argon2id PHC 字符串（算法/参数/盐都在串里），或兜底期的 scrypt 串，见 password.service.ts
    @Column({ type: 'text' })
    passwordHash: string;

    // TOTP 密钥密文（AES-256-GCM，见 PasswordService.encryptTotpSecret）；MVP 不做 TOTP，留空
    @Column({ type: 'text', nullable: true })
    totpSecretEnc: string | null;

    // 恢复码哈希数组的 JSON 文本（不存明文码；只读一次，用掉即从数组移除）
    @Column({ type: 'text', default: '[]' })
    recoveryCodes: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
