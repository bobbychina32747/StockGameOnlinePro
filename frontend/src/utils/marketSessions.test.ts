import { auctionStageFor, isAuctionTimeFor, isTradingTimeFor, isUsDaylightSaving, sessionLabel, usSessionsFor } from './marketSessions';

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

  it('美股（中国时间）：夏令时 21:30-24:00 与 0:00-4:00 为交易时段', () => {
    expect(isTradingTimeFor('US', new Date(2026, 7, 17, 22, 0))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 7, 18, 1, 0))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 7, 17, 12, 0))).toBe(false);
  });

  it('美股冬令时：北京时间 22:30 开盘、05:00 收盘（22:00 休市）', () => {
    // 2026-01-16 为周五，其美盘跨午夜至 01-17 05:00（北京时间）
    expect(isTradingTimeFor('US', new Date(2026, 0, 16, 22, 0))).toBe(false);
    expect(isTradingTimeFor('US', new Date(2026, 0, 16, 22, 30))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 0, 17, 4, 59))).toBe(true);
    expect(isTradingTimeFor('US', new Date(2026, 0, 17, 5, 0))).toBe(false);
  });

  it('美股跨午夜交易日归属：节假日翌日凌晨休市', () => {
    // 2026-07-03（周五）美股独立日假期休市 → 北京时间 07-04 凌晨 01:00 仍属周五美盘，应休市
    expect(isTradingTimeFor('US', new Date(2026, 6, 4, 1, 0))).toBe(false);
    // 普通周五：次日凌晨 01:00 正常开市
    expect(isTradingTimeFor('US', new Date(2026, 6, 11, 1, 0))).toBe(true);
  });

  it('未知市场回退到 A 股规则', () => {
    expect(isTradingTimeFor('XX', new Date(2026, 7, 17, 10, 0))).toBe(true);
  });
});

describe('美股夏令时', () => {
  it('3 月第二个周日起进入夏令时，11 月第一个周日起结束', () => {
    expect(isUsDaylightSaving(new Date(2026, 2, 7))).toBe(false);  // 第二个周日（3/8）前
    expect(isUsDaylightSaving(new Date(2026, 2, 8))).toBe(true);
    expect(isUsDaylightSaving(new Date(2026, 6, 15))).toBe(true);  // 7 月
    expect(isUsDaylightSaving(new Date(2026, 9, 31))).toBe(true);  // 10/31
    expect(isUsDaylightSaving(new Date(2026, 10, 1))).toBe(false); // 11 月第一个周日（11/1）
    expect(isUsDaylightSaving(new Date(2026, 0, 15))).toBe(false); // 1 月
  });

  it('交易时段随夏令时切换', () => {
    expect(usSessionsFor(new Date(2026, 6, 15))).toEqual([[1290, 1440], [0, 240]]);
    expect(usSessionsFor(new Date(2026, 0, 15))).toEqual([[1350, 1440], [0, 300]]);
  });
});

describe('A股三阶段集合竞价', () => {
  it('9:15-9:20 可撤单阶段、9:20-9:25 锁定阶段、9:25-9:30 撮合阶段', () => {
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 14))).toBeNull();
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 15))).toBe('cancelable');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 19))).toBe('cancelable');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 20))).toBe('locked');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 24))).toBe('locked');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 25))).toBe('matching');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 29))).toBe('matching');
    expect(auctionStageFor('CN', new Date(2026, 7, 17, 9, 30))).toBeNull();
  });

  it('仅 A 股生效，周末/节假日无效', () => {
    expect(auctionStageFor('HK', new Date(2026, 7, 17, 9, 20))).toBeNull();
    expect(auctionStageFor('US', new Date(2026, 7, 17, 9, 20))).toBeNull();
    expect(auctionStageFor('CN', new Date(2026, 7, 15, 9, 20))).toBeNull(); // 周六
    expect(auctionStageFor('CN', new Date(2026, 9, 1, 9, 20))).toBeNull(); // 国庆
  });

  it('isAuctionTimeFor 兼容整个 9:15-9:30 窗口', () => {
    expect(isAuctionTimeFor('CN', new Date(2026, 7, 17, 9, 20))).toBe(true);
    expect(isAuctionTimeFor('CN', new Date(2026, 7, 17, 9, 28))).toBe(true);
    expect(isAuctionTimeFor('CN', new Date(2026, 7, 17, 9, 30))).toBe(false);
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
