import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 云存档（服务端托管，2026-10-08）
 *
 * 与老方案的差别：老云存档落在**用户自己的 GitHub Gist / OneDrive**，密钥由游戏厅口令派生；
 * 新方案存在自己库里，密钥由站点身份托管（见 IdentitySecret），授权令牌说了算。
 *
 * 密文口径（客户端加解密，服务端只做搬运 + 完整性校验）：
 *   · AES-256-GCM，密钥 = 身份托管密钥（32 字节），**每个槽位独立随机 IV**；
 *   · 落库的是 base64 密文；`sha256` 由服务端算，用于「这一版存档是不是变了」与去重；
 *   · 服务端**不持有也不解密**存档内容（只有密钥托管，不碰文件内容），故按 identityId 隔离即可。
 */
@Entity('game_saves')
@Unique(['identityId', 'game', 'slot'])
export class GameSave {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Index()
    @Column({ length: 64 })
    identityId: string;

    /** 游戏标识（如 zombie-survival / dreamcore），由客户端固定字符串给出 */
    @Index()
    @Column({ length: 64 })
    game: string;

    /** 槽位（如 auto / 1 / 2 / manual-1） */
    @Column({ length: 64 })
    slot: string;

    /** 密文（base64）；内容格式由客户端定义（AES-GCM 信封） */
    @Column({ type: 'text' })
    data: string;

    /** 明文密文的 sha256（服务端算），用于快速判断"有没有变" */
    @Column({ length: 64 })
    sha256: string;

    /** 字节数（密文长度），供配额与界面显示 */
    @Column({ type: 'int', default: 0 })
    bytes: number;

    /** 客户端声明的存档内元信息（如天数/等级），仅用于列表展示 */
    @Column({ type: 'simple-json', nullable: true })
    meta: Record<string, any> | null;

    /** 是否由老存档（游戏厅/Gist 时代）迁移而来 —— 迁移引导据此收敛 */
    @Column({ default: false })
    migrated: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
