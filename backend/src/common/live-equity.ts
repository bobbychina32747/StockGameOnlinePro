/**
 * G-3：账户实时权益（市值重估）——排行榜 / 赛季榜共用同一口径，避免两处公式漂移。
 *
 * 为什么需要它：`accounts.totalEquity` 只在 ①开户 ②账户重置 ③**日终结算** 三处写库。
 * 两次日终之间（实时档约 4 小时）页面上所有人的市值重估都不反映，于是"刚买入就上涨"的账户
 * 在排行榜上仍显示 0.00%（用户实际反馈：AI 账户赚钱了榜上看不出来）。
 *
 * 口径与 `RiskManagerService.dailySettlement` 完全一致：
 *     equity = cash + 持仓市值 + 空头冻结保证金 − 融资负债
 * 严格返回 null 的三种情况（调用方据此回退"日终落库值"，绝不用半套估值）：
 *   ① 无行情（启动中/休市，prices 为空）
 *   ② 有持仓但拿不到其中任一标的的报价（部分按 0 会把浮盈算成亏损）
 *   ③ 算出的权益非有限值（脏数据）
 */
export function computeLiveEquity(
    account: any,
    positions: any[],
    prices: Record<string, number> | null | undefined,
): number | null {
    if (!positions || positions.length === 0)
        return null; // 无持仓：现金/负债字段本身随成交即时更新，无需重估
    if (!prices || Object.keys(prices).length === 0)
        return null;
    let holdValue = 0;
    for (const pos of positions) {
        const price = prices[pos.symbol];
        if (price === undefined || price === null || !Number.isFinite(Number(price)))
            return null;
        holdValue += (Number(pos.longQty) - Number(pos.shortQty)) * Number(price);
    }
    const equity = Number(account.cash) + holdValue
        + Number(account.shortCollateral || 0) - Number(account.borrowed || 0);
    return Number.isFinite(equity) ? equity : null;
}
