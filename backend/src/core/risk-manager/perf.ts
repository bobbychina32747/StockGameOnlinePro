// P5 绩效归因纯函数：交易流水配对（FIFO）→ 配对级胜率/盈亏因子/月度收益。
// 输入：该账户全部交易流水（按时间升序，side ∈ buy/sell/short/cover，含 price/quantity/turnover）。
// 口径：同一 symbol 内 FIFO 配对；多头 buy→sell，空头 short→cover；盈亏 = 卖出/平空成交额 - 买入/开空成本（按数量比例摊）。

export function pairedMetrics(txs) {
    const lots = new Map(); // symbol -> {long: [{qty, cost}], short: [{qty, proceeds}]}
    let wins = 0;
    let losses = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let paired = 0;
    const monthly = new Map(); // 'YYYY-MM' -> 已实现盈亏合计

    const pushMonth = (month, pnl) => monthly.set(month, (monthly.get(month) || 0) + pnl);

    for (const t of txs) {
        const sym = t.symbol;
        if (!lots.has(sym))
            lots.set(sym, { long: [], short: [] });
        const book = lots.get(sym);
        const qty = Number(t.quantity) || 0;
        const price = Number(t.price) || 0;
        const turnover = Number(t.turnover) || qty * price;
        const month = (t.createdAt ? new Date(t.createdAt) : new Date()).toISOString().slice(0, 7);

        if (t.side === 'buy') {
            book.long.push({ qty, cost: turnover });
        }
        else if (t.side === 'sell') {
            let left = qty;
            let proceeds = turnover;
            // FIFO 消耗多头成本
            while (left > 0 && book.long.length > 0) {
                const lot = book.long[0];
                const closeQty = Math.min(left, lot.qty);
                const costPart = lot.cost * (closeQty / lot.qty);
                const proceedsPart = proceeds * (closeQty / qty);
                const pnl = proceedsPart - costPart;
                if (pnl >= 0) { wins++; grossWin += pnl; } else { losses++; grossLoss -= pnl; }
                paired++;
                pushMonth(month, pnl);
                lot.qty -= closeQty;
                lot.cost -= costPart;
                left -= closeQty;
                if (lot.qty <= 1e-9)
                    book.long.shift();
            }
        }
        else if (t.side === 'short') {
            book.short.push({ qty, proceeds: turnover });
        }
        else if (t.side === 'cover') {
            let left = qty;
            let cost = turnover;
            while (left > 0 && book.short.length > 0) {
                const lot = book.short[0];
                const closeQty = Math.min(left, lot.qty);
                const proceedsPart = lot.proceeds * (closeQty / lot.qty);
                const costPart = cost * (closeQty / qty);
                const pnl = proceedsPart - costPart; // 做空盈亏 = 开空所得 - 平空成本
                if (pnl >= 0) { wins++; grossWin += pnl; } else { losses++; grossLoss -= pnl; }
                paired++;
                pushMonth(month, pnl);
                lot.qty -= closeQty;
                lot.proceeds -= proceedsPart;
                left -= closeQty;
                if (lot.qty <= 1e-9)
                    book.short.shift();
            }
        }
    }

    const total = wins + losses;
    return {
        pairedTrades: paired,
        pairedWinRate: total > 0 ? wins / total : 0,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
        grossWin: Number(grossWin.toFixed(2)),
        grossLoss: Number(grossLoss.toFixed(2)),
        monthlyPnl: [...monthly.entries()].map(([month, pnl]) => ({ month, pnl: Number(pnl.toFixed(2)) })).sort((a, b) => (a.month < b.month ? -1 : 1)),
    };
}
