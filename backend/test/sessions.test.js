// P1 各市场独立交易时段与节假日历测试（确定性时间点）
const { isTradingTimeFor } = require('../dist/src/common/constants');

describe('P1 各市场独立交易时段', () => {
  test('CN 周二 10:00 开市、12:00 午休、14:00 开市', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 0, 6, 10, 0))).toBe(true); // 2026-01-06 周二
    expect(isTradingTimeFor('CN', new Date(2026, 0, 6, 12, 0))).toBe(false);
    expect(isTradingTimeFor('CN', new Date(2026, 0, 6, 14, 0))).toBe(true);
  });

  test('元旦（2026-01-01 周四）三市场休市（节假日历生效）', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 0, 1, 10, 0))).toBe(false);
    expect(isTradingTimeFor('HK', new Date(2026, 0, 1, 10, 0))).toBe(false);
    expect(isTradingTimeFor('US', new Date(2026, 0, 1, 10, 0))).toBe(false);
  });

  test('美股中国时间晚间开市：周二 22:00 美股开、A股休', () => {
    expect(isTradingTimeFor('US', new Date(2026, 0, 6, 22, 0))).toBe(true);
    expect(isTradingTimeFor('CN', new Date(2026, 0, 6, 22, 0))).toBe(false);
  });

  test('美股次日凌晨 01:00 仍开市（跨午夜）', () => {
    expect(isTradingTimeFor('US', new Date(2026, 0, 7, 1, 0))).toBe(true); // 周三凌晨，属周二美盘
  });

  test('港股午休 12:30 休市、15:30 开市、16:00 收盘', () => {
    expect(isTradingTimeFor('HK', new Date(2026, 0, 6, 12, 30))).toBe(false);
    expect(isTradingTimeFor('HK', new Date(2026, 0, 6, 15, 30))).toBe(true);
    expect(isTradingTimeFor('HK', new Date(2026, 0, 6, 16, 0))).toBe(false);
  });

  test('周末全部休市', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 0, 10, 10, 0))).toBe(false); // 周六
    expect(isTradingTimeFor('US', new Date(2026, 0, 10, 22, 0))).toBe(false);
  });
});
