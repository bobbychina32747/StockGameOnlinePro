import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    Unique,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Position } from './position.entity';
import { Order } from './order.entity';

@Entity('accounts')
@Unique(['userId', 'marketMode'])
export class Account {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.accounts)
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column('float', { default: 100000 })
    cash: number;

    @Column('float', { default: 0 })
    marginUsed: number;

    @Column('float', { default: 0 })
    shortCollateral: number;

    // Phase B: 融资负债（真杠杆：买入借入部分记账，卖出按比例偿还，日终计息、维持担保比强平）
    @Column('float', { default: 0 })
    borrowed: number;

    @Column('float', { default: 100000 })
    totalEquity: number;

    @Column('float', { default: 100000 })
    peakEquity: number;

    @Column('float', { default: 100000 })
    initialEquity: number;

    @Column({ default: 'US' })
    marketMode: string;

    @Column({ default: 1 })
    leverage: number;

    @Column({ default: 0 })
    currentDay: number;

    @Column('float', { default: 100000 })
    dayStartEquity: number;

    @Column('float', { default: 0 })
    dailyPnl: number;

    @Column('float', { default: 0 })
    totalPnl: number;

    // 段位系统：评分 + 段位 + 累计交易次数
    @Column({ default: '青铜' })
    tier: string;

    @Column('float', { default: 0 })
    tierScore: number;

    @Column({ default: 0 })
    totalTrades: number;

    // Phase E: 赛季积分（荣誉分，与 tierScore 段位分拆列——tierScore 由 computeTier 每日覆盖为段位口径，
    // 赛季奖励只写入 seasonPoints 仅赛季结算单一路径累加；三市场账户同额记账为 V1 兼容语义）
    @Column('float', { default: 0 })
    seasonPoints: number;

    // Phase A 防刷钱：重置冷却（按游戏日）与重置计数（审计）
    @Column('int', { default: 0 })
    lastResetDay: number;

    @Column('int', { default: 0 })
    resetCount: number;

    @OneToMany(() => Position, (pos) => pos.account)
    positions: Position[];

    @OneToMany(() => Order, (order) => order.account)
    orders: Order[];

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
