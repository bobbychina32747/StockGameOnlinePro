import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// Phase 14 P0 修复（净值持久化）：基金 NAV 原先只活在内存里（服务内硬编码初值 4.5 / 1.0），
// 60s 定时器只涨不跌地演化；进程重启后内存 NAV 回落到硬编码初值，而用户份额仍留在 fund_holdings，
// 重启前累计的涨幅被一次性抹掉（例：已涨到 5.2 的基金重启后回到 4.5，100 份持仓市值凭空少 70），属用户资产可见损失。
// 本表保存每只基金的最新净值：启动时回填内存、定时落库，保证重启前后净值连续。
@Entity('fund_navs')
export class FundNav {
    // 基金 ID 直接做主键（fund-1 / fund-2）：一只基金一行最新净值，repo.save 即天然幂等 upsert
    @PrimaryColumn()
    fundId: string;

    // 最新单位净值（CNY 计价，与 FundDefinition.nav 同口径）
    @Column('float')
    nav: number;

    // 最后落库时间：仅供审计/排查（不参与申购赎回计价口径）
    @UpdateDateColumn()
    updatedAt: Date;
}
