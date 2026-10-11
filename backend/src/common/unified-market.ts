import catalog from './unified-catalog.json';
import intraday from './unified-intraday.json';

export const unifiedInstruments = new Map(catalog.instruments.map(row => [row.symbol, row]));
export function extendStockPool(pool: any[], market: string) {
    const existing = new Set(pool.map(row => row.symbol));
    for (const row of catalog.instruments.filter(row => row.market === market)) {
        if (!existing.has(row.symbol)) pool.push({ symbol: row.symbol, name: row.name, code: row.code,
            market, industry: row.industry, listDate: row.listedAt, description: row.description,
            initialPrice: row.initialPrice / 100, mu: row.initialPrice / 100, sigma: row.volatility, theta: 0.1 });
    }
}
export function activity(minute: number, length: number, market: string) {
    const p = intraday.profiles[market]; const progress = Math.max(0, Math.min(1, minute / length));
    return p.normalization * (1 + p.openBoost * Math.exp(-progress * 14) + p.closeBoost * Math.exp(-(1 - progress) * 14));
}
export function heavyTail(normal: () => number) {
    const numerator = normal(); let squares = 0;
    for (let i = 0; i < 5; i++) squares += normal() ** 2;
    return Math.max(-12, Math.min(12, numerator * Math.sqrt(3 / Math.max(1e-9, squares))));
}
export function calibratedShock(stock: any, normal: () => number, length: number, market: string, sectorShock: number, marketShock: number) {
    const instrument = unifiedInstruments.get(stock.symbol);
    if (!instrument) return null;
    const profile = instrument.riskProfile, g = profile.gjr;
    const state = stock.calibratedVariance ?? { variance: 1, shock: 0 };
    const squared = state.shock ** 2;
    state.variance = Math.max(.15, Math.min(25, g.omega / length + g.alpha / length * squared +
        (state.shock < 0 ? g.gamma / length * squared : 0) + (1 - (1 - g.beta) / length) * state.variance));
    const m = profile.marketWeight, s = profile.sectorWeight;
    state.shock = Math.sqrt(state.variance) * (m * marketShock + s * sectorShock +
        Math.sqrt(Math.max(.01, 1 - m * m - s * s)) * heavyTail(normal));
    stock.calibratedVariance = state;
    stock.volatility = instrument.volatility * Math.sqrt(state.variance);
    return state.shock * instrument.volatility * profile.intradayFraction / Math.sqrt(length) * activity(stock.minuteCounter, length, market);
}
