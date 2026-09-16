const { isTradingTimeNow, tickDelayMs, symbolHash, shortMarginRateFor, STOCK_POOL, HK_POOL, US_POOL } = require('../dist/src/common/constants');

// 修复 CodeQL js/loop-bound-injection 前的实现（循环上界取自 symbol.length），留作等价性基准
function legacyHash(symbol) {
  let h = 0;
  const s = String(symbol || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return h;
}

describe('symbolHash 稳定哈希（loop-bound-injection 修复回归）', () => {
  const allSymbols = [...STOCK_POOL, ...HK_POOL, ...US_POOL].flatMap((s) => [s.symbol, s.code]).filter(Boolean);

  test('全部市场代码与旧实现逐位等价（保证金率/券源池/流通股取值不变）', () => {
    for (const sym of allSymbols) expect([sym, symbolHash(sym)]).toEqual([sym, legacyHash(sym)]);
  });

  test('循环次数与输入长度解耦：超长输入与「前 8 位」同值，不随长度增长', () => {
    const long = 'A'.repeat(200000);
    expect(symbolHash(long)).toBe(legacyHash('A'.repeat(8)));   // 上界钳制在 8 位窗口
    expect(symbolHash('600519')).toBe(legacyHash('600519'));     // 常规长度仍走满窗口
  });

  test('确定性 + 空值兜底 + 与 shortMarginRateFor 共用同一哈希', () => {
    expect(symbolHash('AAPL')).toBe(symbolHash('AAPL'));
    expect(symbolHash(null)).toBe(0);
    expect(symbolHash(undefined)).toBe(0);
    expect(shortMarginRateFor('600519', 0.02)).toBeGreaterThanOrEqual(0.5);
    expect(shortMarginRateFor('600519', 0.02)).toBeLessThanOrEqual(0.65);
  });
});

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
