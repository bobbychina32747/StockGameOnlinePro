// P1 行情真实性：美股夏令时 / 三阶段竞价 / 隔夜跳空 / 厚尾跳跃
const { isTradingTimeFor, isUsDaylightSaving, usSessionsFor, auctionStageFor, isAuctionTimeFor } = require('../dist/src/common/constants');
const { drawOvernightMarketShock, drawOvernightGap, drawBigJump, OVERNIGHT_PARAMS, standardNormal } = require('../dist/src/core/market-data/market-math');

// 确定性 RNG：按数组循环取值
function seqRand(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
const randnOne = () => 1;

describe('P1 美股夏令时（EDT/EST）', () => {
  test('3 月第二个周日进入夏令时，11 月第一个周日结束', () => {
    expect(isUsDaylightSaving(new Date(2026, 2, 7))).toBe(false);
    expect(isUsDaylightSaving(new Date(2026, 2, 8))).toBe(true);  // 2026-03-08
    expect(isUsDaylightSaving(new Date(2026, 6, 15))).toBe(true);
    expect(isUsDaylightSaving(new Date(2026, 9, 31))).toBe(true);
    expect(isUsDaylightSaving(new Date(2026, 10, 1))).toBe(false); // 2026-11-01
    expect(isUsDaylightSaving(new Date(2026, 0, 15))).toBe(false);
  });

  test('交易时段随夏令时切换（北京时间）', () => {
    expect(usSessionsFor(new Date(2026, 6, 15))).toEqual([[1290, 1440], [0, 240]]);
    expect(usSessionsFor(new Date(2026, 0, 15))).toEqual([[1350, 1440], [0, 300]]);
  });

  test('冬令时 22:00 休市、22:30 开市、05:00 收盘', () => {
    expect(isTradingTimeFor('US', new Date(2026, 0, 15, 22, 0))).toBe(false);
    expect(isTradingTimeFor('US', new Date(2026, 0, 15, 22, 30))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 0, 16, 4, 59))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 0, 16, 5, 0))).toBe(false);
  });

  test('跨午夜交易日归属：节假日翌日凌晨按美东日期休市', () => {
    // 2026-07-03（周五）独立日假期 → 北京时间 07-04 01:00 仍属周五美盘 → 休市
    expect(isTradingTimeFor('US', new Date(2026, 6, 4, 1, 0))).toBe(false);
    // 普通周五 → 次日凌晨正常开市
    expect(isTradingTimeFor('US', new Date(2026, 6, 11, 1, 0))).toBe(true);
  });

  test('未知市场回退 A 股规则（不崩溃）', () => {
    expect(isTradingTimeFor('XX', new Date(2026, 7, 17, 10, 0))).toBe(true);
    expect(isTradingTimeFor('XX', new Date(2026, 7, 17, 12, 0))).toBe(false);
  });
});

describe('P1 A股三阶段集合竞价', () => {
  test('9:15-9:20 可撤单 / 9:20-9:25 锁定 / 9:25-9:30 撮合', () => {
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 14))).toBeNull();
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 15))).toBe('cancelable');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 19))).toBe('cancelable');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 20))).toBe('locked');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 24))).toBe('locked');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 25))).toBe('matching');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 29))).toBe('matching');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 30))).toBeNull();
  });

  test('仅 A 股生效；周末/节假日无效', () => {
    expect(auctionStageFor('HK', new Date(2026, 7, 17, 9, 20))).toBeNull();
    expect(auctionStageFor('US', new Date(2026, 7, 17, 9, 20))).toBeNull();
    expect(auctionStageFor('CN', new Date(2026, 7, 15, 9, 20))).toBeNull(); // 周六
    expect(auctionStageFor('CN', new Date(2026, 9, 1, 9, 20))).toBeNull(); // 国庆
  });

  test('isAuctionTimeFor 兼容整个 9:15-9:30 窗口', () => {
    expect(isAuctionTimeFor('CN', new Date(2026, 7, 17, 9, 20))).toBe(true);
    expect(isAuctionTimeFor('CN', new Date(2026, 7, 17, 9, 28))).toBe(true);
    expect(isAuctionTimeFor('CN', new Date(2026, 7, 17, 9, 30))).toBe(false);
  });
});

describe('P1 隔夜跳空模型', () => {
  test('无事件夜：市场冲击为 0', () => {
    expect(drawOvernightMarketShock(() => 0.99, randnOne)).toBe(0);
  });

  test('市场普通冲击 + 崩盘夜（确定性 RNG）', () => {
    // rand 序列：0.01 → 市场事件触发；0.01 → 崩盘触发；0.01 → 负向偏斜
    const shock = drawOvernightMarketShock(seqRand([0.01, 0.01, 0.01]), randnOne);
    // 普通冲击 0.006 + 崩盘 -(0.025×(1+0.6)) = -0.04
    expect(shock).toBeCloseTo(0.006 - 0.04, 10);
  });

  test('CN 个股利空跳空：厚尾幅度并打 gap-down 标记', () => {
    // rand 0.05 → 个股事件触发（<0.10）；rand 0.05 → 负向（<0.6）；randn=1
    const { gap, tag } = drawOvernightGap({ symbol: 'T1', market: 'CN', beta: 1 }, 0, seqRand([0.05, 0.05]), randnOne);
    expect(gap).toBeCloseTo(-0.018, 10); // 0.012 × (1+0.5)
    expect(tag).toBe('gap-down');
  });

  test('CN 涨停开盘：正向大缺口被钳制到 +10%', () => {
    // rand 0.05 → 个股事件；rand 0.95 → 正向（>0.6）；randn=10 → 幅度 0.012×15=0.18
    const { gap, tag } = drawOvernightGap({ symbol: 'T1', market: 'CN', beta: 1 }, 0, seqRand([0.05, 0.95]), () => 10);
    expect(gap).toBeCloseTo(OVERNIGHT_PARAMS.cnLimit, 10);
    expect(tag).toBe('limit-up-open');
  });

  test('港股/美股缺口上限更宽（±25%）', () => {
    // randn=20 → 幅度 0.012×30=0.36 超限，钳制到 ±0.25
    const up = drawOvernightGap({ symbol: 'U1', market: 'US', beta: 1 }, 0, seqRand([0.05, 0.95]), () => 20);
    expect(up.gap).toBeCloseTo(OVERNIGHT_PARAMS.hkUsLimit, 10);
    const down = drawOvernightGap({ symbol: 'H1', market: 'HK', beta: 1 }, 0, seqRand([0.05, 0.05]), () => 20);
    expect(down.gap).toBeCloseTo(-OVERNIGHT_PARAMS.hkUsLimit, 10);
  });

  test('市场冲击按 β 传导', () => {
    const { gap, tag } = drawOvernightGap({ symbol: 'U2', market: 'US', beta: 1.5 }, 0.02, () => 0.99, randnOne);
    expect(gap).toBeCloseTo(0.03, 10);
    expect(tag).toBe('gap-up');
  });
});

describe('P1 厚尾跳跃（跳跃扩散）', () => {
  const params = { jumpIntensity: 0, crashIntensity: 0.1, crashStd: 0.05, crashSkew: 0.6, stress: 1 };

  test('低频大跳：确定性 RNG 触发负向厚尾跳', () => {
    // rand 0.05 < 0.1 触发；rand 0.05 < 0.6 负向；randn=1 → 幅度 0.05×(1+0.5)=0.075
    const big = drawBigJump(1 / 240, params, seqRand([0.05, 0.05]), randnOne);
    expect(big).toBeCloseTo(-0.075, 10);
  });

  test('未触发时大跳为 0', () => {
    expect(drawBigJump(1 / 240, params, () => 0.99, randnOne)).toBe(0);
  });

  test('波动率压力放大触发概率（上限 0.5 钳制）', () => {
    const stressed = { ...params, stress: 100 };
    // prob = min(0.5, 0.1×100) = 0.5；rand 0.4 触发
    const big = drawBigJump(1 / 240, stressed, seqRand([0.4, 0.4]), randnOne);
    expect(big).toBeCloseTo(-0.075, 10);
  });

  test('standardNormal 输出有限且近似标准正态', () => {
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const v = standardNormal();
      expect(Number.isFinite(v)).toBe(true);
      sum += v;
    }
    expect(Math.abs(sum / 2000)).toBeLessThan(0.1);
  });
});
