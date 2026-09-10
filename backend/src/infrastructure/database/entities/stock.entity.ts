import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('stocks')
export class Stock {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true, length: 10 })
    symbol: string;

    @Column({ length: 100 })
    name: string;

    @Column({ length: 5, default: 'CN' })
    market: string;

    @Column({ length: 50, default: '综合' })
    industry: string;

    @Column({ length: 10, default: '' })
    code: string;

    @Column({ length: 20, default: '' })
    listDate: string;

    @Column('text', { default: '' })
    description: string;

    @Column('float')
    initialPrice: number;

    @Column('float')
    mu: number;

    @Column('float', { default: 0.015 })
    sigma: number;

    @Column('float', { default: 0.15 })
    theta: number;

    @Column({ default: true })
    isActive: boolean;
}
