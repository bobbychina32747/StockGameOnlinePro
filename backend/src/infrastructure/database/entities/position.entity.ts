import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
} from 'typeorm';
import { Account } from './account.entity';

@Entity('positions')
@Unique(['accountId', 'symbol'])
export class Position {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    accountId: string;

    @ManyToOne(() => Account, (acc) => acc.positions)
    @JoinColumn({ name: 'accountId' })
    account: Account;

    @Column({ length: 10 })
    symbol: string;

    @Column({ default: 0 })
    longQty: number;

    @Column({ default: 0 })
    shortQty: number;

    @Column('float', { default: 0 })
    longCost: number;

    @Column('float', { default: 0 })
    shortCost: number;

    @Column({ default: 0 })
    boughtToday: number;

    @Column({ default: 0 })
    lockDay: number;
}
