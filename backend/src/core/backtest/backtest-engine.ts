/**
 * Phase 6 回测引擎（REALISM #24）：真实手续费 + 滑点模型 + 多策略 + 基准对比 + 绩效指标
 * 纯逻辑、零 Nest/TypeORM 依赖（同 MatchingEngine），可直接单测；实盘费率口径与
 * trading-engine.calcFees 一致（佣金最低/印花税卖出/过户费/SEC费/TAF费），保证回测≈实盘。
 */
import { CN_FEES, HK_FEES, US_FEES } from "../../common/constants";

export type BacktestStrategy = 'ma_cross' | 'rsi_reversal' | 'momentum';
export type FeeMode = 'CN' | 'HK' | 'US';

export interface BacktestKline {
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface BacktestOptions {
    symbol: string;
    timeframe: string;
    strategy: BacktestStrategy;
    fast?: number;        // ma_cross 快线
    slow?: number;        // ma_cross 慢线
    rsiPeriod?: number;   // rsi_reversal 周期
    momentumN?: number;   // momentum 回看天数
    initialCash?: number;
    feeMode: FeeMode;
    slippageBps?: number; // 单边滑点（基点，1bp=0.01%）
    lotSize?: number;     // 整手股数（CN/HK=100，US=1）
}

const FEE_TABLE: Record<FeeMode, any> = { CN: CN_FEES, HK: HK_FEES, US: US_FEES };
const PERIODS_PER_DAY: Record<string, number> = { '1min': 240, '5min': 48, '60min': 4, 'daily': 1 };

/** 与实盘 calcFees 同口径的费率模型（佣金最低/卖出印花税/过户费/SEC费/TAF费） */
export function calcBacktestFees(side: 'BUY' | 'SELL', turnover: number, qty: number, feeMode: FeeMode): number {
    const fees = FEE_TABLE[feeMode] || CN_FEES;
    const commission = Math.max(turnover * (fees.commissionRate || 0), fees.minCommission || 0);
    const stampDuty = side === 'SELL' ? turnover * (fees.stampDutyRate || 0) : 0;
    const transferFee = turnover * (fees.transferFeeRate || 0);
    const secFee = side === 'SELL' ? turnover * (fees.secFeeRate || 0) : 0;
    const tafFee = side === 'SELL' ? qty * (fees.tafFeePerShare || 0) : 0;
    return commission + stampDuty + transferFee + secFee + tafFee;
}

export function smaArr(closes: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(closes.length).fill(null);
    let s = 0;
    for (let i = 0; i < closes.length; i++) {
        s += closes[i];
        if (i >= period) s -= closes[i - period];
        if (i >= period - 1) out[i] = s / period;
    }
    return out;
}

/** Wilder 平滑 RSI（与主流终端同口径） */
export function rsiArr(closes: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    let avgG = gain / period, avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
        avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
        out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
}

/** 每根 bar 目标仓位：1=满仓 0=空仓（信号只看 ≤i 的数据，无未来函数） */
function buildSignals(closes: number[], opts: Required<Pick<BacktestOptions, 'strategy' | 'fast' | 'slow' | 'rsiPeriod' | 'momentumN'>>): number[] {
    const sig: number[] = new Array(closes.length).fill(0);
    const { strategy, fast, slow, rsiPeriod, momentumN } = opts;
    if (strategy === 'ma_cross') {
        const maF = smaArr(closes, fast), maS = smaArr(closes, slow);
        for (let i = slow; i < closes.length; i++) {
            if (maF[i - 1] == null || maS[i - 1] == null) continue;
            if (maF[i - 1]! <= maS[i - 1]! && maF[i]! > maS[i]!) sig[i] = 1;      // 金叉买
            else if (maF[i - 1]! >= maS[i - 1]! && maF[i]! < maS[i]!) sig[i] = -1; // 死叉卖
        }
    } else if (strategy === 'rsi_reversal') {
        const rsi = rsiArr(closes, rsiPeriod);
        for (let i = rsiPeriod + 1; i < closes.length; i++) {
            if (rsi[i] == null) continue;
            // RSI 刚有值（i-2 为 null）视为区间外穿越：首根即超卖/超买也能触发
            const prev = rsi[i - 2] == null ? null : rsi[i - 1];
            if ((prev == null || prev! > 30) && rsi[i]! <= 30) sig[i] = 1;
            else if ((prev == null || prev! < 70) && rsi[i]! >= 70) sig[i] = -1;
        }
    } else if (strategy === 'momentum') {
        for (let i = momentumN; i < closes.length; i++) {
            // 窗口前的动量视为 0，序列起点即上涨时也能入场
            const prev = i - 1 - momentumN >= 0 ? closes[i - 1] / closes[i - 1 - momentumN] - 1 : 0;
            const cur = closes[i] / closes[i - momentumN] - 1;
            if (prev <= 0 && cur > 0) sig[i] = 1;        // 动量转正买入
            else if (prev >= 0 && cur < 0) sig[i] = -1;  // 动量转负卖出
        }
    }
    return sig;
}

/** 采样收益曲线（最多 maxPoints 个点，含首尾） */
function sampleCurve(curve: number[], maxPoints: number): number[] {
    if (curve.length <= maxPoints) return curve;
    const out: number[] = [];
    const step = (curve.length - 1) / (maxPoints - 1);
    for (let i = 0; i < maxPoints; i++) out.push(curve[Math.round(i * step)]);
    return out;
}

export function runBacktest(klines: BacktestKline[], opts: BacktestOptions): any {
    const closes = klines.map((k) => Number(k.close));
    const initialCash = opts.initialCash ?? 100000;
    const feeMode = opts.feeMode;
    const slip = (Number(opts.slippageBps) || (feeMode === 'US' ? 3 : 5)) / 10000; // 默认滑点 US 3bp / CN·HK 5bp
    const lot = opts.lotSize ?? (feeMode === 'US' ? 1 : 100);
    const strategy = opts.strategy;
    const params = {
        strategy,
        fast: Number(opts.fast) || 5,
        slow: Number(opts.slow) || 20,
        rsiPeriod: Number(opts.rsiPeriod) || 14,
        momentumN: Number(opts.momentumN) || 10,
    };
    const need = strategy === 'ma_cross' ? params.slow : strategy === 'rsi_reversal' ? params.rsiPeriod + 2 : params.momentumN + 2;
    if (closes.length < need + 3) {
        return { error: '历史数据不足，请稍后再试' };
    }
    const signals = buildSignals(closes, params);

    // ── 策略模拟（满仓/空仓，成交价按收盘价 + 滑点，买卖双边计费） ──
    let cash = initialCash, shares = 0, buyPrice = 0, trades = 0, wins = 0;
    let fees = 0, slippageCost = 0;
    const grossWins = [], grossLosses = [];
    const equity: number[] = [];
    for (let i = 0; i < closes.length; i++) {
        const px = closes[i];
        if (signals[i] === 1 && shares === 0) {
            const fill = px * (1 + slip);
            const qty = Math.floor(cash / fill / lot) * lot;
            if (qty > 0) {
                const turnover = qty * fill;
                const f = calcBacktestFees('BUY', turnover, qty, feeMode);
                cash -= turnover + f;
                shares = qty; buyPrice = fill;
                fees += f; slippageCost += qty * px * slip;
            }
        } else if (signals[i] === -1 && shares > 0) {
            const fill = px * (1 - slip);
            const turnover = shares * fill;
            const f = calcBacktestFees('SELL', turnover, shares, feeMode);
            const pnl = (fill - buyPrice) * shares - f;
            cash += turnover - f;
            if (pnl >= 0) { wins++; grossWins.push(pnl); } else grossLosses.push(pnl);
            trades++;
            fees += f; slippageCost += shares * px * slip;
            shares = 0;
        }
        equity.push(cash + shares * px);
    }
    if (shares > 0) { // 期末强制平仓结算
        const px = closes[closes.length - 1];
        const fill = px * (1 - slip);
        const turnover = shares * fill;
        const f = calcBacktestFees('SELL', turnover, shares, feeMode);
        const pnl = (fill - buyPrice) * shares - f;
        cash += turnover - f;
        if (pnl >= 0) { wins++; grossWins.push(pnl); } else grossLosses.push(pnl);
        trades++;
        fees += f; slippageCost += shares * px * slip;
        shares = 0;
        equity[equity.length - 1] = cash;
    }

    // ── 基准：首根有效 bar 收盘买入持有到期末（同样计费+滑点） ──
    let equityCurveBench: number[] = [];
    const baseStart = Math.max(0, Math.floor(need / 2)); // 与策略可交易起点对齐，避免头几天数据偏差
    const bPx = closes[baseStart] * (1 + slip);
    const bQty = Math.floor(initialCash / bPx / lot) * lot;
    let benchEquity = initialCash, benchReturn = 0;
    if (bQty > 0) {
        const bTurnover = bQty * bPx;
        const bFeeIn = calcBacktestFees('BUY', bTurnover, bQty, feeMode);
        const bShares = bQty;
        const bCash = initialCash - bTurnover - bFeeIn;
        const bCurve: number[] = [];
        for (let i = baseStart; i < closes.length; i++) bCurve.push(bCash + bShares * closes[i]);
        const bLast = closes[closes.length - 1] * (1 - slip);
        const bFeeOut = calcBacktestFees('SELL', bShares * bLast, bShares, feeMode);
        benchEquity = bCash + bShares * bLast - bFeeOut;
        benchReturn = (benchEquity - initialCash) / initialCash * 100;
        equityCurveBench = sampleCurve(bCurve, 40);
    }

    // ── 绩效指标 ──
    const finalEquity = equity[equity.length - 1];
    const totalReturn = (finalEquity - initialCash) / initialCash * 100;
    let peak = -Infinity, maxDrawdown = 0;
    for (const v of equity) {
        peak = Math.max(peak, v);
        maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
    }
    const periodsPerDay = PERIODS_PER_DAY[opts.timeframe] || 240;
    const barReturns: number[] = [];
    for (let i = 1; i < equity.length; i++) barReturns.push(equity[i] / equity[i - 1] - 1);
    const mean = barReturns.reduce((a, b) => a + b, 0) / (barReturns.length || 1);
    const std = Math.sqrt(barReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (barReturns.length || 1));
    const tradingDays = Math.max(1, closes.length / periodsPerDay);
    const ann = Math.max(-100, (Math.pow(finalEquity / initialCash, 252 / tradingDays) - 1) * 100);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerDay * 252) : 0;
    const grossWin = grossWins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(grossLosses.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

    return {
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        strategy,
        params,
        feeMode,
        slippageBps: Math.round(slip * 10000),
        bars: closes.length,
        initialCash,
        finalEquity: Number(finalEquity.toFixed(2)),
        totalReturn: Number(totalReturn.toFixed(2)),
        annualizedReturn: Number(ann.toFixed(2)),
        maxDrawdown: Number((maxDrawdown * 100).toFixed(2)),
        sharpe: Number(sharpe.toFixed(2)),
        profitFactor: profitFactor === Infinity ? null : Number(profitFactor.toFixed(2)),
        trades,
        winRate: trades ? Number((wins / trades * 100).toFixed(1)) : 0,
        fees: Number(fees.toFixed(2)),
        slippageCost: Number(slippageCost.toFixed(2)),
        benchmarkReturn: Number(benchReturn.toFixed(2)),
        equityCurve: sampleCurve(equity, 40),
        equityCurveBench,
    };
}
