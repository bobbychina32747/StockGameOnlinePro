import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum EntryStatus {
    ACTIVE = 'active',
    SETTLED = 'settled',
}

// Phase C: 赛季报名（报名时快照账户净值，赛季收益=净值相对变化，收益率口径排序）
@Entity('season_entries')
@Unique(['seasonId', 'accountId'])
export class SeasonEntry {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    seasonId: string;

    @Column()
    userId: string;

    @Column()
    accountId: string;

    @Column({ default: 'CN' })
    marketMode: string;

    @Column('float', { default: 0 })
    startEquity: number;

    @Column('int', { default: 0 })
    startDay: number;

    @Column({ type: 'simple-enum', enum: EntryStatus, default: EntryStatus.ACTIVE })
    status: EntryStatus;

    @Column('float', { nullable: true })
    finalEquity?: number;

    @Column('float', { nullable: true })
    finalReturn?: number;

    @Column('int', { nullable: true })
    finalRank?: number;

    @CreateDateColumn()
    enrolledAt: Date;
}
