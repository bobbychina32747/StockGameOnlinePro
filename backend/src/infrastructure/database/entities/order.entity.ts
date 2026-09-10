import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Account } from './account.entity';

export enum OrderType {
    MARKET = 'market',
    LIMIT = 'limit',
    STOP = 'stop',
    STOP_LIMIT = 'stop-limit',
    FOK = 'fok',
    IOC = 'ioc',
    ICEBERG = 'iceberg',
}

export enum OrderSide {
    BUY = 'buy',
    SELL = 'sell',
    SHORT = 'short',
    COVER = 'cover',
}

export enum OrderStatus {
    PENDING = 'pending',
    PARTIAL = 'partial',
    FILLED = 'filled',
    CANCELLED = 'cancelled',
    REJECTED = 'rejected',
}

@Entity('orders')
// Phase D: 账户维订单查询索引（getPendingOrders/账户重置查挂单/订单历史页）
@Index(['accountId', 'status'])
// Phase F: 挂单扫描索引——checkPendingOrders 按 (status=PENDING, type IN [limit,stop,stop-limit]) 过滤，
// 原仅有 (accountId,status) 复合索引无法命中该等值+枚举查询（挂单量增长后全表扫）
@Index(['status', 'type'])
export class Order {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => User)
    @JoinColumn({ name: 'userId' })
    user: User;

    @Column()
    accountId: string;

    @ManyToOne(() => Account, (acc) => acc.orders)
    @JoinColumn({ name: 'accountId' })
    account: Account;

    @Column({ length: 10 })
    symbol: string;

    @Column({ type: 'simple-enum', enum: OrderType })
    type: OrderType;

    @Column({ type: 'simple-enum', enum: OrderSide })
    side: OrderSide;

    @Column('float', { nullable: true })
    price?: number;

    @Column('float', { nullable: true })
    triggerPrice?: number;

    @Column()
    quantity: number;

    @Column({ default: 0 })
    filledQty: number;

    @Column({ type: 'simple-enum', enum: OrderStatus, default: OrderStatus.PENDING })
    status: OrderStatus;

    @Column('float', { nullable: true })
    avgFillPrice?: number;

    @Column({ type: 'text', nullable: true })
    rejectReason?: string;

    @Column('float', { nullable: true })
    displayQty?: number;

    @Column('float', { nullable: true })
    hiddenQty?: number;

    @Column({ type: 'text', nullable: true })
    triggerLog?: string;

    @Column({ default: 0 })
    triggerRetries: number;

    // Phase B: 盘后固定价格交易标记（15:00-15:30 收盘价撮合，15:30 未成交自动撤销）
    @Column({ default: false })
    postClose: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
