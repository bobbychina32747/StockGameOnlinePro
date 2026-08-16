// P1 各市场独立交易时段与节假日。
// 数据源：src/data/trading-calendar.ts（唯一权威副本，与后端 backend/src/common/data/trading-calendar.ts 字节级一致，
// pre-commit 钩子校验同步；含美股夏令时与跨午夜交易日归属）。
import {
  TRADING_CALENDAR,
  isMarketHoliday,
  isUsDaylightSaving as calendarIsUsDst,
  marketDateFor,
  usSessionsFor as calendarUsSessions,
} from '../data/trading-calendar';

const CAL = TRADING_CALENDAR;
const flatHolidays = (m: 'CN' | 'HK' | 'US'): string[] =>
  Object.values(CAL[m].holidays).reduce<string[]>((a, arr) => a.concat(arr), []);

// 兼容导出：holidays 为全部年份扁平合并（旧代码/测试 contains 判断）
export const MARKET_SESSIONS: Record<string, { weekdays: number[]; sessions: number[][]; holidays: string[] }> = {
  CN: { weekdays: CAL.CN.weekdays, sessions: CAL.CN.sessions, holidays: flatHolidays('CN') },
  HK: { weekdays: CAL.HK.weekdays, sessions: CAL.HK.sessions, holidays: flatHolidays('HK') },
  US: { weekdays: CAL.US.weekdays, sessions: CAL.US.sessions, holidays: flatHolidays('US') },
};

export function isUsDaylightSaving(date?: Date): boolean {
  return calendarIsUsDst(date || new Date());
}

export function usSessionsFor(date?: Date): number[][] {
  return calendarUsSessions(date || new Date());
}

export function isTradingTimeFor(mode?: string, now?: Date): boolean {
  // 未知市场回退 CN（与后端行为一致，且避免索引 TRADING_CALENDAR 越界）
  const m = ((mode && CAL[mode as 'CN' | 'HK' | 'US'] ? mode : 'CN') || 'CN') as 'CN' | 'HK' | 'US';
  const cfg = MARKET_SESSIONS[m];
  const raw = now || new Date();
  const d = marketDateFor(m, raw);
  if (!cfg.weekdays.includes(d.getDay())) return false;
  if (isMarketHoliday(m, raw)) return false;
  const minutes = raw.getHours() * 60 + raw.getMinutes();
  const sessions = m === 'US' ? calendarUsSessions(raw) : cfg.sessions;
  return sessions.some(([start, end]) => minutes >= start && minutes < end);
}

// P1 三阶段竞价（仅 A 股）：9:15-9:20 可申报可撤单 / 9:20-9:25 可申报不可撤 / 9:25-9:30 撮合
export function auctionStageFor(mode?: string, now?: Date): 'cancelable' | 'locked' | 'matching' | null {
  if (mode !== 'CN') return null;
  const d = now || new Date();
  if (!CAL.CN.weekdays.includes(d.getDay())) return null;
  if (isMarketHoliday('CN', d)) return null;
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes >= 555 && minutes < 560) return 'cancelable';
  if (minutes >= 560 && minutes < 565) return 'locked';
  if (minutes >= 565 && minutes < 570) return 'matching';
  return null;
}

export function isAuctionTimeFor(mode?: string, now?: Date): boolean {
  return auctionStageFor(mode, now) !== null;
}

export function sessionLabel(mode?: string): string {
  const m = mode || 'CN';
  if (m === 'HK') return '9:30-12:00 / 13:00-16:00';
  if (m === 'US') return '21:30/22:30-次日04:00/05:00（夏令时/冬令时）';
  return '9:30-11:30 / 13:00-15:00';
}
