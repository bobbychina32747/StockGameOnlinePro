import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum SeasonStatus {
    ENROLLING = 'enrolling',
    RUNNING = 'running',
    SETTLED = 'settled',
}

// Phase E: 赛季类型（weekly=5 / biweekly=10 / monthly=20 游戏日；轮换开赛见 season.service）
export enum SeasonType {
    WEEKLY = 'weekly',
    BIWEEKLY = 'biweekly',
    MONTHLY = 'monthly',
}

// Phase C: 模拟大赛赛季（快照净值赛 MVP：10 游戏日滚动赛季，手动报名）
@Entity('seasons')
@Unique(['seq'])
export class Season {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column('int', { default: 0 })
    seq: number;

    @Column({ default: '赛季' })
    name: string;

    @Column({ type: 'simple-enum', enum: SeasonStatus, default: SeasonStatus.ENROLLING })
    status: SeasonStatus;

    // Phase E: 赛季类型；durationDays 列保留（读侧零改动，开赛时由 type 同步写入）
    @Column({ type: 'simple-enum', enum: SeasonType, default: SeasonType.BIWEEKLY })
    type: SeasonType;

    // 开赛时各市场 gameDay（JSON：{CN,HK,US}），赛季结束判定 = 任一市场 gameDay ≥ anchor+duration
    @Column({ type: 'text', default: '{}' })
    anchorDay: string;

    @Column('int', { default: 10 })
    durationDays: number;

    @CreateDateColumn()
    startedAt: Date;

    @Column('datetime', { nullable: true })
    endedAt?: Date;

    @Column('datetime', { nullable: true })
    settledAt?: Date;
}
