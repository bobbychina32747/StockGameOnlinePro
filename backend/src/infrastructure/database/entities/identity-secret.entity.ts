import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 站点身份的服务端密钥材料（2026-10-08）
 *
 * 用途一：云存档的文件密钥（`saveKey`）。老方案把存档密钥绑在"游戏厅口令"上——
 * 改密码就换钥匙、换设备没口令就解不开、站点账号授权也拿不到那把钥匙。
 * 新方案把**密钥托管到服务端**：客户端凭站点授权令牌取一次密钥，之后所有存档
 * 都用同一把钥匙加解密，口令/第三方登录怎么变都不影响老存档。
 *
 * 用途二（预留）：以后要给用户的东西做服务端加密时，统一用这一行里的材料，不再新开表。
 *
 * 存储口径：`wrapKey`（由服务端主密钥派生）做 AES-256-GCM 包裹后的密文，
 * 明文密钥只在「已登录的站点身份」请求下解封一次、经 TLS 返回给客户端。
 * 服务端主密钥见 GameSavesService.masterKey()（环境变量优先，其次落库，绝不硬编码）。
 */
@Entity('identity_secrets')
export class IdentitySecret {
    @PrimaryColumn({ length: 64 })
    identityId: string;

    /** 云存档文件密钥的包裹密文（base64url：iv.tag.ciphertext） */
    @Column({ type: 'text', nullable: true })
    saveKey: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
