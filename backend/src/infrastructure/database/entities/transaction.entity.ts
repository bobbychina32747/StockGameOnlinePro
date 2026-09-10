import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('transactions')
// Phase D: 流水按账户查询/日终批量指标计算索引
@Index(['accountId'])
export class Transaction {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    accountId: string;

    @Column({ nullable: true })
    orderId?: string;

    @Column({ length: 10 })
    symbol: string;

    @Column({ length: 10 })
    side: string;

    @Column()
    quantity: number;

    @Column('float')
    price: number;

    @Column('float')
    turnover: number;

    @Column('float', { default: 0 })
    commission: number;

    @Column('float', { default: 0 })
    stampDuty: number;

    @Column('float', { default: 0 })
    transferFee: number;

    @Column('float', { default: 0 })
    totalFees: number;

    @CreateDateColumn()
    createdAt: Date;
}
