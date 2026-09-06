// Phase D 段位数据驱动（销 tech-debt）：权重/归一化/阈值单一来源，纯函数可单测、UI 可复用。
// 旧实现（risk-manager.service 主观 40/30/30 公式）已删除，改由本模块 + computeTier 委托。
// teams 定稿：收益30/回撤20/盈亏因子20/胜率20/活跃10；回撤与活跃带保底系数
// （0 流水账户 tierScore=23 ≥15 不掉出白银，游戏策划红线）。

export const TIER_WEIGHTS = { totalReturn: 0.3, maxDrawdown: 0.2, profitFactor: 0.2, winRate: 0.2, activity: 0.1 };
export const NORM_RETURN_CAP = 0.5; // 收益 ≥+50% 满分
export const NORM_DRAWDOWN_FLOOR = 0.5; // 回撤 ≥50% 归零
export const NORM_PF_CAP = 2; // 盈亏因子 ≥2 满分
export const NORM_TRADES_CAP = 50; // 活跃对数归一：50 笔满分
export const DRAWDOWN_BASE = 0.7; // teams 定稿：回撤分保底 70%（0 流水账户拿 14 分）
export const ACTIVITY_BASE = 0.3; // teams 定稿：活跃分保底 30%（0 流水账户拿 3 分）
export const TIER_LEVELS = [
    { min: 92, name: '王者', icon: '🐉' },
    { min: 82, name: '大师', icon: '👑' },
    { min: 70, name: '钻石', icon: '🔷' },
    { min: 55, name: '铂金', icon: '💎' },
    { min: 35, name: '黄金', icon: '🥇' },
    { min: 15, name: '白银', icon: '🥈' },
    { min: 0, name: '青铜', icon: '🥉' },
];
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

// metrics = { totalReturn, maxDrawdown(0~1), profitFactor(>0 或 Infinity), winRate(0~1), totalTrades }
export function computeTierScore(metrics) {
    const m = metrics || {};
    const ret = clamp01(Number(m.totalReturn) / NORM_RETURN_CAP);
    const ddNorm = DRAWDOWN_BASE + (1 - DRAWDOWN_BASE) * clamp01(1 - Number(m.maxDrawdown) / NORM_DRAWDOWN_FLOOR);
    const pfNorm = m.profitFactor === Infinity || Number(m.profitFactor) >= NORM_PF_CAP
        ? 1 : clamp01(Number(m.profitFactor) / NORM_PF_CAP);
    const wr = clamp01(Number(m.winRate)); // 直乘；40% 基准否决（pf 已表达盈亏比，避免趋势选手双惩罚）
    const actNorm = ACTIVITY_BASE + (1 - ACTIVITY_BASE) * clamp01(Math.log10(1 + Math.max(0, Number(m.totalTrades) || 0)) / Math.log10(1 + NORM_TRADES_CAP));
    return Math.round(ret * 30 + ddNorm * 20 + pfNorm * 20 + wr * 20 + actNorm * 10);
}
export function tierOf(score) {
    return TIER_LEVELS.find((t) => score >= t.min) || TIER_LEVELS[TIER_LEVELS.length - 1];
}
