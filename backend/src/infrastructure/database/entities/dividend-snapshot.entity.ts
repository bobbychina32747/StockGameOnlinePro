import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// Phase A 分红登记日持仓快照：exDay-1 收盘拍全市场净持仓，exDay 盘后按快照发息（封堵"除权日买入白拿息"套利）
@Entity('dividend_snapshots')
@Unique(['accountId', 'symbol', 'exDay'])
export class DividendSnapshot {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    accountId: string;

    @Column()
    symbol: string;

    @Column('int', { default: 0 })
    exDay: number;

    @Column('float', { default: 0 })
    longQty: number;

    @Column('float', { default: 0 })
    shortQty: number;

    // Phase C: 快照时点的建仓日（红利税持有期近似：0=无记录按当日建仓）
    @Column('int', { default: 0 })
    lockDay: number;

    // 发息幂等标记：防止重复日终结算重复发息
    @Column({ default: false })
    paid: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
