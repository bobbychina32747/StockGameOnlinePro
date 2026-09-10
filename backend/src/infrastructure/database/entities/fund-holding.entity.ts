import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('fund_holdings')
@Unique(['userId', 'marketMode', 'fundId'])
export class FundHolding {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @Column()
    marketMode: string;

    @Column()
    fundId: string;

    @Column('float', { default: 0 })
    shares: number;

    @Column('float', { default: 0 })
    totalInvested: number;

    // Phase C: 首次申购游戏日（赎回费持有期档位基准：<7交易日1.5% / 7-30日0.5% / ≥30日0）
    @Column('int', { default: 0 })
    firstBuyDay: number;
}
