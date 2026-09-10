import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('klines')
@Index(['symbol', 'timeframe', 'time'])
export class Kline {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ length: 10 })
    symbol: string;

    @Column({ length: 10 })
    timeframe: string;

    @Column()
    time: Date;

    @Column('float')
    open: number;

    @Column('float')
    high: number;

    @Column('float')
    low: number;

    @Column('float')
    close: number;

    @Column({ default: 0 })
    volume: number;
}
