import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Account } from './account.entity';
import { Order } from './order.entity';

export enum UserRole {
    USER = 'user',
    ADMIN = 'admin',
}

@Entity('users')
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true, length: 50 })
    username: string;

    @Column()
    password: string;

    @Column({ type: 'simple-enum', enum: UserRole, default: UserRole.USER })
    role: UserRole;

    @Column({ default: true })
    isActive: boolean;

    // Phase G-2: 机器人玩家标记（算法盘 / 假人用户）。
    // 语义：机器人是**真实的 users 行**（同一套权限、真实账户与委托，走 OrderService 全量校验），
    // 该列只用于「展示标识 + 运营统计分离」，不参与任何权限判断（同台竞技前提下与真人同权）。
    @Column({ default: false })
    isBot: boolean;

    @OneToMany(() => Account, (acc) => acc.user)
    accounts: Account[];

    @OneToMany(() => Order, (order) => order.user)
    orders: Order[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
