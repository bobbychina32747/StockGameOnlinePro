// P2 做市商报价模型（纯函数，可单测）：
// 双边报价围绕中间价对称展开，价差随波动率扩大；库存偏斜报价中心（多头库存→报价下移主动卖、
// 空头库存→上移主动买）；仓位越重报量越小（库存控制）。
export const MM_PARAMS = {
    baseSpread: 0.0012,
    volSpreadMul: 8,
    inventorySkew: 0.0002,
    quoteSize: 800,
    inventoryLimit: 4000,
    refreshTicks: 10,
    ttlTicks: 20,
};

export function mmQuote(mid, volatility, inventory, params = MM_PARAMS) {
    const vol = Number.isFinite(Number(volatility)) ? Number(volatility) : 0.02;
    const inv = Number.isFinite(Number(inventory)) ? Number(inventory) : 0;
    const width = Math.max(0.0004, params.baseSpread + vol * params.volSpreadMul);
    const skew = clamp(params.inventorySkew * inv, -width * 3, width * 3);
    const center = Number(mid) * (1 - skew);
    const bid = center * (1 - width);
    const ask = center * (1 + width);
    const size = Math.max(100, Math.round(params.quoteSize * (1 + vol * 10) * Math.max(0.2, 1 - Math.abs(inv) / params.inventoryLimit)));
    return { bid: round2(bid), ask: round2(ask), size };
}

function round2(v) {
    return Math.round(v * 100) / 100;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}
