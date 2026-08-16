// P1 市场数学纯函数：厚尾跳跃（GARCH+跳跃扩散）与隔夜跳空模型。
// 全部为无副作用纯函数，RNG 可注入（单元测试确定性复现）。

// ─── 厚尾跳跃：高频小跳 + 低频大跳（崩盘/脉冲），大跳不受单 tick ±2% 连续项限幅 ───
// 返回 { small, big }：small 并入连续价格项（受 ±2% 限幅），big 在限幅之后叠加（真实崩盘形态）
export function drawJump(dt, params, rand = Math.random, randn = standardNormal) {
    const smallProb = params.jumpIntensity * dt * 240 * 1.5;
    const small = rand() < smallProb
        ? (rand() > 0.5 ? 1 : -1) * params.jumpStd * 1.5 * randn()
        : 0;
    return { small, big: drawBigJump(dt, params, rand, randn) };
}

export function drawBigJump(dt, params, rand = Math.random, randn = standardNormal) {
    // 波动率压力系数：高波动期崩盘概率放大（上限 3 倍）
    const stress = params.stress ?? 1;
    const prob = Math.min(0.5, params.crashIntensity * dt * 240 * stress);
    if (rand() >= prob)
        return 0;
    // 厚尾：|N(0,1)| + 0.5×|N(0,1)| 叠加（右尾更长）；负向偏斜 crashSkew
    const magnitude = params.crashStd * (Math.abs(randn()) + 0.5 * Math.abs(randn()));
    const sign = rand() < params.crashSkew ? -1 : 1;
    return sign * magnitude;
}

export function standardNormal() {
    let u = 0, v = 0;
    while (u === 0)
        u = Math.random();
    while (v === 0)
        v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─── 隔夜跳空：市场级冲击（全市场共享）+ 个股级冲击（独立厚尾），β 联动 ───
export const OVERNIGHT_PARAMS = {
    marketShockProb: 0.30,      // 隔夜市场级事件概率
    marketCrashProb: 0.04,      // 市场级大冲击概率（叠加在普通冲击之上）
    marketShockStd: 0.006,      // 普通市场冲击标准差（约 ±0.6%）
    marketCrashStd: 0.025,      // 市场级大冲击标准差（约 ±2.5%，尾部长）
    stockShockProb: 0.10,       // 个股隔夜事件概率
    stockShockStd: 0.012,       // 个股冲击标准差（约 ±1.2%，厚尾）
    negativeSkew: 0.6,          // 负向偏斜（利空多于利好）
    cnLimit: 0.10,              // A股 ±10% 涨跌停约束（开盘价对昨收）
    hkUsLimit: 0.25,            // 港股/美股单日约束（模拟口径）
    limitUpTagThreshold: 0.098, // 涨停/跌停开盘判定阈值
};

// 每市场每夜一次：市场级隔夜冲击（含尾部崩盘夜）
export function drawOvernightMarketShock(rand = Math.random, randn = standardNormal) {
    let shock = 0;
    if (rand() < OVERNIGHT_PARAMS.marketShockProb) {
        shock += OVERNIGHT_PARAMS.marketShockStd * randn();
    }
    if (rand() < OVERNIGHT_PARAMS.marketCrashProb) {
        const crash = OVERNIGHT_PARAMS.marketCrashStd * (Math.abs(randn()) + 0.6 * Math.abs(randn()));
        shock += (rand() < OVERNIGHT_PARAMS.negativeSkew ? -1 : 1) * crash;
    }
    return shock;
}

// 个股隔夜跳空：marketShock × β + 个股独立冲击；返回 { gap, tag }
// tag: 'limit-up-open' | 'limit-down-open' | 'gap-up' | 'gap-down' | null（>1% 记为 gap-*）
export function drawOvernightGap(stock, marketShock, rand = Math.random, randn = standardNormal) {
    const beta = clamp(Number(stock.beta) || 1, 0.4, 2.5);
    let stockShock = 0;
    if (rand() < OVERNIGHT_PARAMS.stockShockProb) {
        const magnitude = OVERNIGHT_PARAMS.stockShockStd * (Math.abs(randn()) + 0.5 * Math.abs(randn()));
        stockShock = (rand() < OVERNIGHT_PARAMS.negativeSkew ? -1 : 1) * magnitude;
    }
    let gap = marketShock * beta + stockShock;
    const market = stock.market || 'CN';
    if (market === 'CN') {
        gap = clamp(gap, -OVERNIGHT_PARAMS.cnLimit, OVERNIGHT_PARAMS.cnLimit);
    } else {
        gap = clamp(gap, -OVERNIGHT_PARAMS.hkUsLimit, OVERNIGHT_PARAMS.hkUsLimit);
    }
    let tag = null;
    const t = OVERNIGHT_PARAMS.limitUpTagThreshold;
    if (gap >= t) tag = 'limit-up-open';
    else if (gap <= -t) tag = 'limit-down-open';
    else if (gap >= 0.01) tag = 'gap-up';
    else if (gap <= -0.01) tag = 'gap-down';
    return { gap, tag };
}

export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}
