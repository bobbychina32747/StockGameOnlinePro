import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// Phase A 分红事件落库：除权/发息事件持久化，防重启丢失（原 dividends Map 为内存态）
@Entity('dividend_events')
@Unique(['symbol', 'exDay'])
export class DividendEvent {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    symbol: string;

    @Column('float', { default: 0 })
    perShare: number;

    @Column('int', { default: 0 })
    announceDay: number;

    @Column('int', { default: 0 })
    exDay: number;

    // 除权是否已在 exDay 开盘执行（幂等：重启后不重复调价）
    @Column({ default: false })
    applied: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
