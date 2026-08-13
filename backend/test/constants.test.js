const { isTradingTimeNow } = require('../dist/src/common/constants');

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
