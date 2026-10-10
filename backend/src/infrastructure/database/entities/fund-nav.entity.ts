import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// 净值、结算日与股票组合基准同源落库，重启后保留报价并防止重复结算。
@Entity('fund_navs')
export class FundNav {
    // 基金 ID 直接做主键（fund-1 / fund-2）：一只基金一行最新净值，repo.save 即天然幂等 upsert
    @PrimaryColumn()
    fundId: string;

    // 最新单位净值（CNY 计价，与 FundDefinition.nav 同口径）
    @Column('float')
    nav: number;

    @Column('integer', { nullable: true })
    settledDay: number | null;

    @Column('simple-json', { nullable: true })
    basketPrices: Record<string, number> | null;

    // 最后落库时间：仅供审计/排查（不参与申购赎回计价口径）
    @UpdateDateColumn()
    updatedAt: Date;
}
