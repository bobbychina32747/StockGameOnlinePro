import { isTradingTimeFor, sessionLabel } from './marketSessions';

describe('isTradingTimeFor', () => {
  it('A股：周一上午 10:00 为交易时段', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 7, 17, 10, 0))).toBe(true);
  });

  it('A股：午休 12:00 休市，下午 14:00 恢复', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 7, 17, 12, 0))).toBe(false);
    expect(isTradingTimeFor('CN', new Date(2026, 7, 17, 14, 0))).toBe(true);
  });

  it('A股：周六休市', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 7, 15, 10, 0))).toBe(false);
  });

  it('A股：国庆节 10-01 休市', () => {
    expect(isTradingTimeFor('CN', new Date(2026, 9, 1, 10, 0))).toBe(false);
  });

  it('港股：13:30 为交易时段，12:30 午休', () => {
    expect(isTradingTimeFor('HK', new Date(2026, 7, 17, 13, 30))).toBe(true);
    expect(isTradingTimeFor('HK', new Date(2026, 7, 17, 12, 30))).toBe(false);
  });

  it('美股（中国时间）：21:30-24:00 与 0:00-4:00 为交易时段', () => {
    expect(isTradingTimeFor('US', new Date(2026, 7, 17, 22, 0))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 7, 18, 1, 0))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 7, 17, 12, 0))).toBe(false);
  });

  it('未知市场回退到 A 股规则', () => {
    expect(isTradingTimeFor('XX', new Date(2026, 7, 17, 10, 0))).toBe(true);
  });
});

describe('sessionLabel', () => {
  it('返回各市场交易时段文案', () => {
    expect(sessionLabel('CN')).toContain('9:30-11:30');
    expect(sessionLabel('HK')).toContain('9:30-12:00');
    expect(sessionLabel('US')).toContain('21:30');
    expect(sessionLabel()).toBe(sessionLabel('CN'));
  });
});
