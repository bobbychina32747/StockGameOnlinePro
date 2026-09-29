import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 进程级小配置/密钥（键值表，2026-09-29）
 * 为什么放库里而不是文件：容器的 `/keys` 是**只读挂载**（身份私钥那种手工管理的放那儿合适），
 * 而"首次使用自动生成"的密钥必须能写、而且必须跟着数据库备份走 —— 丢了就等于把已自动开号的用户锁在门外。
 * 目前只存一把：arcade.derive（游戏厅派生口令的 HMAC 密钥）。
 */
@Entity('app_secrets')
export class AppSecret {
    @PrimaryColumn({ length: 64 })
    name: string;

    @Column({ type: 'text' })
    value: string;

    @UpdateDateColumn()
    updatedAt: Date;
}
