// P1 各市场独立交易时段与节假日（与后端 constants/index.ts MARKET_SESSIONS 保持一致；节假日为近似清单）
export const MARKET_SESSIONS: Record<string, { weekdays: number[]; sessions: number[][]; holidays: string[] }> = {
  CN: {
    weekdays: [1, 2, 3, 4, 5],
    sessions: [[570, 690], [780, 900]],
    holidays: ['2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
  },
  HK: {
    weekdays: [1, 2, 3, 4, 5],
    sessions: [[570, 720], [780, 960]],
    holidays: ['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-04-03', '2026-04-06', '2026-05-01', '2026-06-19', '2026-07-01', '2026-10-01', '2026-12-25'],
  },
  US: {
    weekdays: [1, 2, 3, 4, 5],
    sessions: [[1290, 1440], [0, 240]],
    holidays: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
  },
};

export function isTradingTimeFor(mode?: string, now?: Date): boolean {
  const cfg = MARKET_SESSIONS[mode || 'CN'] || MARKET_SESSIONS.CN;
  const d = now || new Date();
  if (!cfg.weekdays.includes(d.getDay())) return false;
  const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  if (cfg.holidays.includes(dateStr)) return false;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return cfg.sessions.some(([start, end]) => minutes >= start && minutes < end);
}

export function sessionLabel(mode?: string): string {
  const m = mode || 'CN';
  if (m === 'HK') return '9:30-12:00 / 13:00-16:00';
  if (m === 'US') return '21:30-次日04:00';
  return '9:30-11:30 / 13:00-15:00';
}
