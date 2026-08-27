// Phase 6 回测引擎单元测试：费率模型 / 滑点 / 多策略信号 / 基准 / 绩效指标（REALISM #24）
const { runBacktest, calcBacktestFees } = require('../dist/src/core/backtest/backtest-engine');

const klines = (closes) => closes.map((c) => ({ open: c, high: c, low: c, close: c }));
const baseOpts = (over = {}) => ({ symbol: 'T1', timeframe: 'daily', strategy: 'ma_cross', fast: 5, slow: 20, feeMode: 'CN', ...over });

describe('Phase6 回测引擎 费率模型（与实盘同口径）', () => {
  test('A股：佣金最低5元 + 卖出印花税0.1% + 过户费', () => {
    // 买 100 股 @10：佣金 max(1000*0.00025,5)=5 + 过户 0.02
    expect(calcBacktestFees('BUY', 1000, 100, 'CN')).toBeCloseTo(5.02, 6);
    // 卖 100 股 @10：再加印花税 1.0
    expect(calcBacktestFees('SELL', 1000, 100, 'CN')).toBeCloseTo(6.02, 6);
  });
  test('港股：佣金最低50 + 卖出印花税0.13%', () => {
    expect(calcBacktestFees('BUY', 10000, 100, 'HK')).toBeCloseTo(50.77, 6); // 50 + 征费0.77
    expect(calcBacktestFees('SELL', 10000, 100, 'HK')).toBeCloseTo(64.04, 1); // +印花13 +SEC0.27
  });
  test('美股：零佣金 + 卖出SEC费/TAF费', () => {
    expect(calcBacktestFees('BUY', 1000, 100, 'US')).toBeCloseTo(0, 6);
    expect(calcBacktestFees('SELL', 1000, 100, 'US')).toBeCloseTo(0.0229 + 0.0119, 6);
  });
});

describe('Phase6 回测引擎 滑点与费用拖累', () => {
  // 先横盘再上涨：MA 金叉发生在上涨起点，随后持有（必成交）
  const flatUp = [...Array(30).fill(100), ...Array.from({ length: 30 }, (_, k) => 100 * Math.pow(1.01, k + 1))];
  test('滑点放大 → 期末资金下降、滑点成本>0', () => {
    const r0 = runBacktest(klines(flatUp), baseOpts({ slippageBps: 0 }));
    const r50 = runBacktest(klines(flatUp), baseOpts({ slippageBps: 50 }));
    expect(r50.slippageCost).toBeGreaterThan(0);
    expect(r50.finalEquity).toBeLessThan(r0.finalEquity);
  });
  test('A股费率计入手续费总额且 >0', () => {
    const r = runBacktest(klines(flatUp), baseOpts({}));
    expect(r.fees).toBeGreaterThan(0);
    expect(r.totalReturn).toBeLessThan((r.finalEquity + r.fees + r.slippageCost - r.initialCash) / r.initialCash * 100 + 0.01);
  });
});

describe('Phase6 回测引擎 策略信号', () => {
  test('MA 交叉：金叉买死叉卖，趋势反转至少 1 笔交易', () => {
    const s = [...Array.from({ length: 40 }, (_, i) => 100 - i), ...Array.from({ length: 40 }, (_, i) => 100 + i)];
    const r = runBacktest(klines(s), baseOpts({}));
    expect(r.trades).toBeGreaterThanOrEqual(1);
    expect(r.totalReturn).toBeGreaterThan(0); // 先跌后涨 V 型，低位买高位卖
  });
  test('RSI 反转：V 型探底超卖买入、超买卖出，胜率≥80%', () => {
    const v = [
      ...Array.from({ length: 25 }, (_, i) => 100 * Math.pow(0.98, i + 1)),
      ...Array.from({ length: 25 }, (_, i) => 100 * Math.pow(0.98, 25) * Math.pow(1.02, i + 1)),
    ];
    const r = runBacktest(klines(v), baseOpts({ strategy: 'rsi_reversal', rsiPeriod: 14 }));
    expect(r.trades).toBeGreaterThanOrEqual(1);
    expect(r.totalReturn).toBeGreaterThan(0);
    expect(r.winRate).toBeGreaterThanOrEqual(80);
  });
  test('动量：单边上行只买一次持有到期，跑赢本金', () => {
    const up = Array.from({ length: 50 }, (_, i) => 100 * Math.pow(1.01, i));
    const r = runBacktest(klines(up), baseOpts({ strategy: 'momentum', momentumN: 10 }));
    expect(r.trades).toBe(1);
    expect(r.finalEquity).toBeGreaterThan(r.initialCash);
  });
});

describe('Phase6 回测引擎 基准与指标', () => {
  const up = Array.from({ length: 50 }, (_, i) => 100 * Math.pow(1.01, i));
  const r = runBacktest(klines(up), baseOpts({ strategy: 'momentum', momentumN: 10 }));
  test('基准=买入持有，单边行情下为正收益', () => {
    expect(r.benchmarkReturn).toBeGreaterThan(0);
    expect(r.equityCurveBench.length).toBeGreaterThan(0);
  });
  test('指标完整性：年化/回撤/夏普有限，曲线抽样≤40点', () => {
    expect(Number.isFinite(r.annualizedReturn)).toBe(true);
    expect(r.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(r.sharpe)).toBe(true);
    expect(r.equityCurve.length).toBeLessThanOrEqual(40);
    expect(r.equityCurveBench.length).toBeLessThanOrEqual(40);
  });
  test('数据不足返回 error', () => {
    const r = runBacktest(klines([1, 2, 3]), baseOpts({}));
    expect(r.error).toBeTruthy();
  });
});
