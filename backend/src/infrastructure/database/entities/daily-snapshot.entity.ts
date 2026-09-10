import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('daily_snapshots')
@Index(['userId', 'day'])
export class DailySnapshot {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @Column()
    day: number;

    @Column('float')
    equity: number;

    @Column('float', { nullable: true })
    dailyReturn?: number;

    @CreateDateColumn()
    recordedAt: Date;
}
