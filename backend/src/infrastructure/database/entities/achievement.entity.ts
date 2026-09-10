import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

// Phase C: 成就服务端化（跨设备持久 + 幂等 UNIQUE(userId, code)）
@Entity('achievements')
@Unique(['userId', 'code'])
export class Achievement {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @Column({ length: 40 })
    code: string;

    @CreateDateColumn()
    unlockedAt: Date;
}
