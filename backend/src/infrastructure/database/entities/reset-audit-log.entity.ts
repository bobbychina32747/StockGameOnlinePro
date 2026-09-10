import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// Phase A 账户重置审计：记录每次重置前后资金状态（防刷钱可追溯）
@Entity('reset_audit_logs')
export class ResetAuditLog {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @Column()
    marketMode: string;

    @Column()
    preset: string;

    @Column('float', { default: 0 })
    prevCash: number;

    @Column('float', { default: 0 })
    prevEquity: number;

    @Column('float', { default: 0 })
    prevPeak: number;

    @Column('float', { default: 0 })
    fundValueAtReset: number;

    @CreateDateColumn()
    createdAt: Date;
}
