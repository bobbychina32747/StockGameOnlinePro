// Session fixtures use explicit China/Hong Kong instants, independent of the runner time zone.
// P1 各市场独立交易时段与节假日历测试（确定性时间点）
const { isTradingTimeFor, isAuctionTimeFor, shortMarginRateFor, FX_CNY_PER_UNIT, FX_TRANSFER_FEE_RATE } = require('../dist/src/common/constants');

describe('P1 各市场独立交易时段', () => {
  test('CN 周二 10:00 开市、12:00 午休、14:00 开市', () => {
    expect(isTradingTimeFor('CN', new Date('2026-01-06T10:00:00+08:00'))).toBe(true); // 2026-01-06 周二
    expect(isTradingTimeFor('CN', new Date('2026-01-06T12:00:00+08:00'))).toBe(false);
    expect(isTradingTimeFor('CN', new Date('2026-01-06T14:00:00+08:00'))).toBe(true);
  });

  test('元旦（2026-01-01 周四）三市场休市（节假日历生效）', () => {
    expect(isTradingTimeFor('CN', new Date('2026-01-01T10:00:00+08:00'))).toBe(false);
    expect(isTradingTimeFor('HK', new Date('2026-01-01T10:00:00+08:00'))).toBe(false);
    expect(isTradingTimeFor('US', new Date('2026-01-01T10:00:00+08:00'))).toBe(false);
  });

  test('美股中国时间晚间开市（冬令时 22:30 / 夏令时 21:30）', () => {
    expect(isTradingTimeFor('US', new Date('2026-01-06T22:00:00+08:00'))).toBe(false); // 1 月冬令时 22:30 开盘
    expect(isTradingTimeFor('US', new Date('2026-01-06T22:30:00+08:00'))).toBe(true);
    expect(isTradingTimeFor('US', new Date('2026-07-07T21:30:00+08:00'))).toBe(true); // 7 月夏令时
    expect(isTradingTimeFor('CN', new Date('2026-01-06T22:00:00+08:00'))).toBe(false);
  });

  test('美股次日凌晨 01:00 仍开市（跨午夜）', () => {
    expect(isTradingTimeFor('US', new Date('2026-01-07T01:00:00+08:00'))).toBe(true); // 周三凌晨，属周二美盘
  });

  test('港股午休 12:30 休市、15:30 开市、16:00 收盘', () => {
    expect(isTradingTimeFor('HK', new Date('2026-01-06T12:30:00+08:00'))).toBe(false);
    expect(isTradingTimeFor('HK', new Date('2026-01-06T15:30:00+08:00'))).toBe(true);
    expect(isTradingTimeFor('HK', new Date('2026-01-06T16:00:00+08:00'))).toBe(false);
  });

  test('周末全部休市', () => {
    expect(isTradingTimeFor('CN', new Date('2026-01-10T10:00:00+08:00'))).toBe(false); // 周六
    expect(isTradingTimeFor('US', new Date('2026-01-10T22:00:00+08:00'))).toBe(false);
  });

  test('盘前竞价窗口仅 A 股 9:15-9:30 生效', () => {
    expect(isAuctionTimeFor('CN', new Date('2026-01-06T09:20:00+08:00'))).toBe(true);
    expect(isAuctionTimeFor('CN', new Date('2026-01-06T09:10:00+08:00'))).toBe(false);
    expect(isAuctionTimeFor('CN', new Date('2026-01-06T10:00:00+08:00'))).toBe(false);
    expect(isAuctionTimeFor('US', new Date('2026-01-06T09:20:00+08:00'))).toBe(false);
    expect(isAuctionTimeFor('HK', new Date('2026-01-06T09:20:00+08:00'))).toBe(false);
  });
});

describe('P3 两融个股折算率与跨市场汇率', () => {
  test('个股做空保证金率稳定且在 0.5~0.65', () => {
    const r1 = shortMarginRateFor('T1');
    expect(r1).toBe(shortMarginRateFor('T1'));
    expect(r1).toBeGreaterThanOrEqual(0.5);
    expect(r1).toBeLessThanOrEqual(0.65);
    expect(typeof shortMarginRateFor('H1')).toBe('number');
    expect(shortMarginRateFor('U3')).not.toBe(shortMarginRateFor('T1'));
  });

  test('汇率与手续费常量', () => {
    expect(FX_CNY_PER_UNIT.CN).toBe(1);
    expect(FX_CNY_PER_UNIT.HK).toBeCloseTo(0.92, 6);
    expect(FX_CNY_PER_UNIT.US).toBeCloseTo(7.12, 6);
    expect(FX_TRANSFER_FEE_RATE).toBeCloseTo(0.001, 6);
  });
});
