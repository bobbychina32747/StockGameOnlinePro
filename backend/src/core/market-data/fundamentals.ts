// P3 基本面与新闻引擎纯函数（无副作用，RNG 可注入，单元测试确定性复现）：
// - 行业景气周期：扩张/顶峰/收缩/谷底 四阶段马尔可夫链，驱动营收增长中枢与估值中枢
// - 公司基本面：营收增长/净利率/ROE 的 AR 演化 + 分析师一致预期收敛 + 财报披露预期差（surprise）
// - 财报后漂移（PEAD）：surprise 分级 → 披露日跳空 + 数日持续漂移 + 一致预期修正
// - 宏观数据日历：CPI/PMI/议息/就业 定时事件，市场一致预期 + surprise 分级传导
// - 新闻影响衰减曲线：首日强冲击 → 几何衰减 → 归零

// ─── 行业景气周期 ───
export const INDUSTRY_CYCLE = {
    transition: {
        expansion: { expansion: 0.75, peak: 0.15, contraction: 0.08, trough: 0.02 },
        peak: { expansion: 0.10, peak: 0.55, contraction: 0.30, trough: 0.05 },
        contraction: { expansion: 0.05, peak: 0.08, contraction: 0.70, trough: 0.17 },
        trough: { expansion: 0.25, peak: 0.05, contraction: 0.15, trough: 0.55 },
    },
    effects: {
        expansion: { growthBias: 0.10, valuationBias: 0.08, volMul: 1.0 },
        peak: { growthBias: 0.05, valuationBias: 0.04, volMul: 1.15 },
        contraction: { growthBias: -0.08, valuationBias: -0.06, volMul: 1.25 },
        trough: { growthBias: -0.03, valuationBias: -0.03, volMul: 1.1 },
    },
};
export const CYCLE_PHASES = ['expansion', 'peak', 'contraction', 'trough'];

export function nextCyclePhase(current, rand = Math.random) {
    const table = INDUSTRY_CYCLE.transition[current] || INDUSTRY_CYCLE.transition.expansion;
    const r = rand();
    let cumulative = 0;
    for (const phase of CYCLE_PHASES) {
        cumulative += table[phase];
        if (r <= cumulative)
            return phase;
    }
    return current;
}

export function cycleEffects(phase) {
    return INDUSTRY_CYCLE.effects[phase] || INDUSTRY_CYCLE.effects.expansion;
}

export function randomCyclePhase(rand = Math.random) {
    const r = rand();
    if (r < 0.30) return 'expansion';
    if (r < 0.45) return 'peak';
    if (r < 0.70) return 'contraction';
    return 'trough';
}

// ─── 公司基本面 ───
export function initFundamentals(rand = Math.random) {
    const revenueGrowth = 0.02 + (rand() - 0.5) * 0.24;      // 年度营收增速 -10%~+14%
    const netMargin = 0.05 + rand() * 0.15;                   // 净利率 5%~20%
    return {
        revenueGrowth,
        netMargin,
        roe: clamp(netMargin * 1.6 + revenueGrowth * 0.3, -0.2, 0.45),
        consensusGrowth: revenueGrowth + (rand() - 0.5) * 0.02, // 一致预期围绕实际带噪声
        revision: 0,
    };
}

// 每日演化：营收增速向行业周期中枢回归 + 噪声；一致预期向实际缓慢收敛（分析师跟踪）
export function evolveFundamentals(f, phase, randn = standardNormal, rand = Math.random) {
    const effect = cycleEffects(phase);
    f.revenueGrowth += (effect.growthBias * 0.4 - f.revenueGrowth) * 0.02 + randn() * 0.0015;
    f.revenueGrowth = clamp(f.revenueGrowth, -0.35, 0.60);
    f.netMargin += (0.07 - f.netMargin) * 0.01 + randn() * 0.0008;
    f.netMargin = clamp(f.netMargin, -0.05, 0.45);
    f.roe = clamp(f.netMargin * 1.6 + f.revenueGrowth * 0.3, -0.2, 0.45);
    f.consensusGrowth += (f.revenueGrowth - f.consensusGrowth) * 0.03 + randn() * 0.0008;
    f.consensusGrowth = clamp(f.consensusGrowth, -0.35, 0.60);
    return f;
}

// surprise 分级：披露增速 vs 一致预期的差距（按 2%/5% 阈值分 -2..2 五档）
export function surpriseClassOf(actualGrowth, consensusGrowth) {
    const diff = actualGrowth - consensusGrowth;
    if (diff >= 0.05) return 2;
    if (diff >= 0.02) return 1;
    if (diff <= -0.05) return -2;
    if (diff <= -0.02) return -1;
    return 0;
}

export const SURPRISE_LABEL = { 2: '大超预期', 1: '略超预期', 0: '符合预期', '-1': '略低预期', '-2': '大低预期' };

// 财报披露：披露值 = 实际 + 披露噪声；返回报告数据与分级
export function makeEarningsReport(f, gameDay, quarter, randn = standardNormal) {
    const reportedGrowth = clamp(f.revenueGrowth + randn() * 0.008, -0.4, 0.7);
    const cls = surpriseClassOf(reportedGrowth, f.consensusGrowth);
    return {
        day: gameDay,
        quarter,
        revenueGrowth: Number(reportedGrowth.toFixed(3)),
        consensusGrowth: Number(f.consensusGrowth.toFixed(3)),
        netMargin: Number((f.netMargin * 100).toFixed(1)),
        roe: Number((f.roe * 100).toFixed(1)),
        surpriseClass: cls,
        surpriseLabel: SURPRISE_LABEL[String(cls)],
    };
}

// 披露日跳空：大超 +4%~+7% / 略超 +1.5%~+3% / 符合 ±0.5% / 略低 -1.5%~-3% / 大低 -4%~-7%
export function earningsShock(cls, rand = Math.random) {
    const r = 0.7 + rand() * 0.6; // 0.7~1.3 幅度系数
    if (cls >= 2) return r * 0.055;
    if (cls === 1) return r * 0.022;
    if (cls === -1) return -r * 0.022;
    if (cls <= -2) return -r * 0.055;
    return (rand() > 0.5 ? 1 : -1) * 0.005;
}

// 财报后漂移（PEAD）：日度漂移幅度（±0.07%/±0.15% 每日，持续 5 个交易日，与 surprise 同向）
export function peadDaily(cls) {
    if (cls >= 2) return 0.0015;
    if (cls === 1) return 0.0007;
    if (cls === -1) return -0.0007;
    if (cls <= -2) return -0.0015;
    return 0;
}

// 一致预期修正：财报后分析师上调/下调
export function reviseConsensus(f, cls) {
    f.consensusGrowth = clamp(f.consensusGrowth + cls * 0.015, -0.35, 0.60);
    f.revision = cls;
    return f;
}

// ─── 宏观数据日历 ───
export const MACRO_EVENT_DEFS = [
    { key: 'CPI', name: 'CPI 通胀数据', cadence: 20, offset: 3, std: 0.4, marketFactor: '宏观经济', industries: { 银行: 1.2, 消费: 1.0, 地产: 1.1, 食品饮料: 1.0, 保险: 0.9 } },
    { key: 'PMI', name: '制造业 PMI', cadence: 20, offset: 8, std: 0.5, marketFactor: '宏观经济', industries: { 制造业: 1.5, 汽车: 1.2, 半导体: 1.3, 航运: 1.1, 能源: 1.0 } },
    { key: 'RATE', name: '央行议息决议', cadence: 30, offset: 15, std: 0.35, marketFactor: '政策风险', industries: { 银行: 1.5, 地产: 1.4, 保险: 1.2, 金融: 1.4, 公用事业: 0.9 } },
    { key: 'EMPLOY', name: '非农就业报告', cadence: 20, offset: 18, std: 0.45, marketFactor: '宏观经济', industries: { 消费: 1.1, 金融科技: 0.9, 互联网: 0.8 } },
];

// 事件落地：实际值 = 一致预期 + surprise×std；surprise 分级 -3..3（clamp）
export function rollMacroEvent(def, randn = standardNormal) {
    const surprise = clamp(randn(), -3, 3);
    const expected = def.base ?? 0;
    return {
        key: def.key,
        name: def.name,
        expected: Number(expected.toFixed(2)),
        actual: Number((expected + surprise * def.std).toFixed(2)),
        surprise: Number(surprise.toFixed(2)),
    };
}

// ─── 新闻影响衰减曲线：首日全额 → 几何衰减（rate^t）→ 归零 ───
export function newsDecayFactor(t, totalDays, rate = 0.7) {
    if (totalDays <= 0 || t < 0) return 0;
    if (t >= totalDays) return 0;
    return Math.pow(rate, t);
}

export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

export function standardNormal() {
    let u = 0, v = 0;
    while (u === 0)
        u = Math.random();
    while (v === 0)
        v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
