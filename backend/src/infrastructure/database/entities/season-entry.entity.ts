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

    // Phase 13 P1: 结算发奖幂等标记——旧实现"先发 seasonPoints、最后才落 season.status=SETTLED"，
    // 中途抛错/进程重启会再次读到 RUNNING 并重复发分；该列随 synchronize 自动加列，
    // 存量行 default false（视为未发奖，下次结算按正常规则补发一次）
    @Column({ default: false })
    rewarded: boolean;

    @CreateDateColumn()
    enrolledAt: Date;
}
