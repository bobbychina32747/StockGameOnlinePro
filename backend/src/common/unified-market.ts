import catalog from './unified-catalog.json';
import intraday from './unified-intraday.json';
import risk from './unified-intraday-risk.json';

export const unifiedInstruments = new Map(catalog.instruments.map(row => [row.symbol, row]));
const industryAliases = {
    航天科技:'工业与军工', 军工:'工业与军工', 制造业:'工业与军工', 券商:'券商与金融科技', 金融科技:'券商与金融科技', 金融:'券商与金融科技',
    创新药:'医药与生物', 生物疫苗:'医药与生物', 医药:'医药与生物', 医疗:'医疗器械与服务', 医疗器械:'医疗器械与服务',
    新能源车:'汽车与出行', 汽车:'汽车与出行', 锂电池:'新能源与电池', 光伏:'新能源与电池', 新能源:'新能源与电池',
    游戏:'游戏与互动娱乐', 电竞:'游戏与互动娱乐', 云游戏:'游戏与互动娱乐', 游戏引擎:'游戏与互动娱乐',
    动漫IP:'传媒与文娱', 影视传媒:'传媒与文娱', 数字音乐:'传媒与文娱', 传媒:'传媒与文娱',
    房地产:'地产与基建', 地产:'地产与基建', 家电:'硬件与家电', 消费电子:'硬件与家电', 有色金属:'有色与材料',
    煤炭:'能源与煤炭', 能源:'能源与煤炭', 物流:'航空航运与物流', 航空:'航空航运与物流', 航运:'航空航运与物流',
    软件服务:'软件与云服务', 软件:'软件与云服务', 数据要素:'软件与云服务', 通信设备:'通信与网络', 通信:'通信与网络',
    白酒:'食品饮料', 餐饮:'食品饮料', 农业:'食品饮料', 在线教育:'互联网与电商', 消费:'零售与消费', 零售:'零售与消费',
    互联网:'互联网与电商', 电商:'互联网与电商',
};
export function canonicalIndustry(industry: string, symbol?: string) {
    return unifiedInstruments.get(symbol)?.industry || industryAliases[industry] || industry;
}
export function extendStockPool(pool: any[], market: string) {
    for (const row of pool) row.industry = canonicalIndustry(row.industry, row.symbol);
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
    const profile = instrument.riskProfile;
    const fitted = risk.profiles[`${market}|${canonicalIndustry(stock.industry, stock.symbol)}`];
    const g = fitted || profile.gjr;
    const state = stock.calibratedVariance ?? { variance: 1, shock: 0 };
    const persistence = Math.max(.01, Math.min(.985, g.alpha + g.beta + g.gamma / 2));
    const scale = fitted ? (1 - Math.pow(persistence, 1 / 5)) / (1 - persistence) : 1 / length;
    const previousSigma = Math.max(.00001, instrument.volatility * profile.intradayFraction / Math.sqrt(length)
        * activity(Math.max(0, stock.minuteCounter - 1), length, market));
    // Actual moves include news, jumps and trading limits. Gaussian innovations
    // alone would make conditional variance ignore these observable shocks.
    const observedReturn = stock.current1min?.open > 0
        ? Number(stock.current1min.close) / Number(stock.current1min.open) - 1 : Number(stock.lastReturn || 0);
    const previousShock = Math.max(-8, Math.min(8, observedReturn / previousSigma));
    const squared = previousShock ** 2;
    state.variance = Math.max(.15, Math.min(25, g.omega * scale + g.alpha * scale * squared +
        (previousShock < 0 ? g.gamma * scale * squared : 0) + (1 - (1 - g.beta) * scale) * state.variance));
    const m = profile.marketWeight, s = profile.sectorWeight;
    state.shock = Math.sqrt(state.variance) * (m * marketShock + s * sectorShock +
        Math.sqrt(Math.max(.01, 1 - m * m - s * s)) * heavyTail(normal));
    stock.calibratedVariance = state;
    stock.volatility = instrument.volatility * Math.sqrt(state.variance);
    return state.shock * instrument.volatility * profile.intradayFraction / Math.sqrt(length) * activity(stock.minuteCounter, length, market);
}

export function intrabarRange(stock: any, market: string, length: number, open: number, close: number, normal: () => number) {
    const instrument = unifiedInstruments.get(stock.symbol);
    if (!instrument) return {high:Math.max(open,close),low:Math.min(open,close)};
    const fitted = risk.profiles[`${market}|${canonicalIndustry(stock.industry, stock.symbol)}`];
    const scale = fitted?.wickScale ?? instrument.riskProfile.wickScale;
    const sigma = Number(stock.volatility || instrument.volatility) * instrument.riskProfile.intradayFraction
        / Math.sqrt(length) * activity(stock.minuteCounter, length, market) * scale;
    let high=Math.max(open,close),low=Math.min(open,close);
    // Conditional intrabar bridge: intermediate extrema are simulated quotes,
    // not additional matched trades or hand-authored chart patterns.
    for(const p of [.25,.5,.75]) {
        const price=Math.exp(Math.log(open)*(1-p)+Math.log(close)*p
            + Math.max(-.01,Math.min(.01,normal()*sigma*Math.sqrt(p*(1-p)))));
        high=Math.max(high,price);low=Math.min(low,price);
    }
    return {high,low:Math.max(.5,low)};
}
