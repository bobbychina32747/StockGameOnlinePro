// Phase B: 动态滑点模型唯一实现（实盘撮合与回测共用，消除双份漂移）
// 公式搬自 matching-engine 原 slipStepFor/executeMarketOrder：
//   步长 = 0.0008 × 波动率压力(1+min(2,max(0,(vol-0.02)*25))) × OFI 修正（逆风×放大、顺风收窄）
//   每 500 股一档恶化，步长钳 [0.0002, 0.004]，总滑点上限 2%，触顶后剩余量按触顶价兜底成交（Phase A P0#5）

export function slipStepFor(vol, ofi, side) {
    const v = Number(vol) || 0.02;
    const volMul = 1 + Math.min(2, Math.max(0, (v - 0.02) * 25));
    const dir = (side === 'buy' || side === 'cover') ? 1 : -1;
    const adverse = Math.max(0, dir * Number(ofi || 0));
    const favorable = Math.max(0, -dir * Number(ofi || 0));
    const step = 0.0008 * volMul * (1 + 2.2 * adverse) * (1 - 0.5 * favorable);
    return Math.min(0.004, Math.max(0.0002, step));
}

// 按实盘口径模拟"吃穿合成档后的剩余量"滑点成交：
// anchor=最深档价（或现价），limitPrice 为限价约束（缺省=不限价，市价单语义）
// 返回 { totalCost, totalQty, remaining } —— remaining=0 表示全部成交（含触顶兜底）
export function liveFillPrice(anchor, qty, side, vol, ofi, limitPrice) {
    const isBuy = side === 'buy' || side === 'cover';
    const dirMul = isBuy ? 1 : -1;
    const step = slipStepFor(vol, ofi, side);
    let remaining = Math.max(0, Number(qty) || 0);
    let totalCost = 0;
    let totalQty = 0;
    let slip = 0;
    while (remaining > 0 && slip < 0.02) {
        const price = Number(anchor) * (1 + dirMul * slip);
        if (limitPrice !== undefined && limitPrice !== null) {
            if (isBuy ? price > Number(limitPrice) : price < Number(limitPrice))
                break; // 超出限价不再成交（FOK/IOC 语义）
        }
        const tranche = Math.min(remaining, 500);
        totalCost += tranche * price;
        totalQty += tranche;
        remaining -= tranche;
        slip = Math.min(0.02, slip + step);
    }
    if (remaining > 0 && limitPrice !== undefined && limitPrice !== null) {
        // 触顶兜底（仍受限价约束）
        const capPrice = Number(anchor) * (1 + dirMul * 0.02);
        if (isBuy ? capPrice <= Number(limitPrice) : capPrice >= Number(limitPrice)) {
            totalCost += remaining * capPrice;
            totalQty += remaining;
            remaining = 0;
        }
    }
    else if (remaining > 0) {
        // 市价单：触顶后按触顶价兜底成交（Phase A P0#5，不丢量）
        totalCost += remaining * Number(anchor) * (1 + dirMul * 0.02);
        totalQty += remaining;
        remaining = 0;
    }
    return { totalCost, totalQty, remaining };
}
