// Decisions use completed candles and the current public price only.
export function recentAiReturns(stock) {
    const bars = stock.kline1min || [];
    const price = Number(stock.price);
    const back = (n) => Number(bars[Math.max(0, bars.length - n)]?.close) || price;
    const mean = (start, end) => {
        let sum = 0;
        for (let i = start; i < end; i++) sum += Number(bars[i]?.close) || price;
        return sum / Math.max(1, end - start);
    };
    const latest = mean(Math.max(0, bars.length - 30), bars.length);
    const previous = mean(Math.max(0, bars.length - 60), Math.max(1, bars.length - 30));
    const older = mean(Math.max(0, bars.length - 90), Math.max(1, bars.length - 60));
    return { ready: bars.length >= 90, short: price / back(6) - 1, trend: latest / previous - 1, priorTrend: previous / older - 1 };
}

export function aiEntryScore(strategy, stock, features, hot) {
    const recent = recentAiReturns(stock);
    if (!recent.ready) return null; // Retain the existing signal until enough completed candles are available.
    const ret = Number(features.ret) || 0;
    const flow = Number(features.ofi) || 0;
    if (recent.short < -0.004 || recent.trend < -0.015 || ret > 0.075) return -Infinity;
    if (strategy === 'meanrev' || strategy === 'reversal') {
        // A pullback needs observable stabilization, rather than buying the deepest fall.
        if (ret >= -0.003 || recent.short <= 0 || flow < -0.25) return -Infinity;
        return -ret + recent.short + flow * 0.01;
    }
    if (recent.trend < 0.002 || recent.priorTrend < 0.002 || recent.short < 0.001 || flow < -0.2) return -Infinity;
    return recent.trend + recent.short + flow * 0.01 + (hot ? 0.005 : 0);
}

export function aiPolicyDirection(strategy, stock, features, hot, legacyDirection) {
    const recent = recentAiReturns(stock);
    if (!recent.ready || strategy === 'meanrev' || strategy === 'reversal') return legacyDirection;
    if (recent.trend < -0.002) return -1;
    return Number.isFinite(aiEntryScore(strategy, stock, features, hot)) ? 1 : 0;
}

export function aiPortfolioRisk(ledger, stocks, resting, regime) {
    let holdings = 0;
    for (const [symbol, pos] of ledger.positions) holdings += Number(pos.qty) * Number(stocks.get(symbol)?.price || pos.cost);
    const equity = Math.max(0, Number(ledger.cash) + holdings);
    const peak = Math.max(equity, Number(ledger.riskPeakEquity) || Number(ledger.initialCash) || equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    const exposureLimit = equity * (drawdown >= 0.1 ? 0.25 : regime === 'bear' ? 0.35 : 0.6);
    let pendingBuys = 0;
    const bySymbol = new Map<string, number>();
    for (const order of resting) {
        if (order.side !== 'buy' && order.side !== 'cover') continue;
        const value = Math.max(0, Number(order.qty) - Number(order.filledQty || 0)) * Number(order.price);
        pendingBuys += value;
        bySymbol.set(order.symbol, (bySymbol.get(order.symbol) || 0) + value);
    }
    return { equity, peak, drawdown, holdings, pendingBuys, bySymbol, exposureLimit, singleLimit: equity * 0.12 };
}
