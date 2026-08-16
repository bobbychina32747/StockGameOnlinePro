const { isTradingTimeNow, tickDelayMs } = require('../dist/src/common/constants');

describe('isTradingTimeNow 交易时段判断', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('周一上午交易时段 → true', () => {
    jest.setSystemTime(new Date('2024-01-01T10:00:00')); // 周一 10:00
    expect(isTradingTimeNow()).toBe(true);
  });

  test('午休时段 → false', () => {
    jest.setSystemTime(new Date('2024-01-01T12:00:00'));
    expect(isTradingTimeNow()).toBe(false);
  });

  test('下午交易时段 → true', () => {
    jest.setSystemTime(new Date('2024-01-01T14:00:00'));
    expect(isTradingTimeNow()).toBe(true);
  });

  test('开盘前 → false', () => {
    jest.setSystemTime(new Date('2024-01-01T09:00:00'));
    expect(isTradingTimeNow()).toBe(false);
  });

  test('收盘后 → false', () => {
    jest.setSystemTime(new Date('2024-01-01T15:30:00'));
    expect(isTradingTimeNow()).toBe(false);
  });

  test('周六 → false', () => {
    jest.setSystemTime(new Date('2024-01-06T10:00:00'));
    expect(isTradingTimeNow()).toBe(false);
  });
});

describe('P4 tickDelayMs 调试模式休市节奏', () => {
  test('调试开启且全市场休市 → 1s 高速回放', () => {
    expect(tickDelayMs(true, false, 60000)).toBe(1000);
    expect(tickDelayMs(true, false, 1000)).toBe(1000);
  });

  test('正常交易时段 → 按配置；未开调试休市 → 按配置', () => {
    expect(tickDelayMs(false, true, 60000)).toBe(60000);
    expect(tickDelayMs(true, true, 60000)).toBe(60000);
    expect(tickDelayMs(false, false, 60000)).toBe(60000);
  });
});
