// P1 交易日历数据源（唯一权威副本）
// - CN/HK/US 节假日清单：2026 为在用的权威清单（原近似清单迁移）；2025/2027 为近似官方安排，
//   官方发布后可整体替换对应年份数组，不影响代码。
// - 美股夏令时（EDT/EST）：北京时间开盘 21:30（夏令时）/ 22:30（冬令时），跨午夜收盘。
// - 美股跨午夜交易日归属：北京时间 0:00-5:00 属于上一日历日的美盘，节假日/周末按美东日期判定。
// 本文件与 frontend/src/data/trading-calendar.ts 必须保持字节级一致（pre-commit 钩子校验）。

export interface MarketCalendar {
  weekdays: number[];
  sessions: number[][];
  holidays: Record<string, string[]>;
}

export const TRADING_CALENDAR: Record<'CN' | 'HK' | 'US', MarketCalendar> = {
  CN: {
    weekdays: [1, 2, 3, 4, 5],
    sessions: [[570, 690], [780, 900]],
    holidays: {
      '2025': ['2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-03', '2025-02-04', '2025-04-04', '2025-05-01', '2025-05-02', '2025-05-05', '2025-06-02', '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-06', '2025-10-07', '2025-10-08'],
      '2026': ['2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
      // 2027 为预估（官方未发布）：春节 2/8-2/12、清明 4/5、端午 6/9、中秋 9/24、国庆 10/1-10/7
      '2027': ['2027-01-01', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11', '2027-02-12', '2027-04-05', '2027-05-03', '2027-05-04', '2027-05-05', '2027-06-09', '2027-09-24', '2027-10-01', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07'],
    },
  },
  HK: {
    weekdays: [1, 2, 3, 4, 5],
    sessions: [[570, 720], [780, 960]],
    holidays: {
      '2025': ['2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-04-04', '2025-04-18', '2025-04-19', '2025-04-21', '2025-05-01', '2025-05-05', '2025-05-31', '2025-07-01', '2025-10-01', '2025-10-07', '2025-12-25', '2025-12-26'],
      '2026': ['2026-01-01', '2026-02-17', '2026-02-18', '2026-02-19', '2026-04-03', '2026-04-06', '2026-04-07', '2026-05-01', '2026-05-25', '2026-06-19', '2026-07-01', '2026-10-01', '2026-10-19', '2026-12-25'],
      // 2027 为预估（官方未发布）
      '2027': ['2027-01-01', '2027-02-05', '2027-02-08', '2027-02-09', '2027-03-26', '2027-03-29', '2027-04-05', '2027-05-01', '2027-05-13', '2027-06-09', '2027-07-01', '2027-09-24', '2027-10-01', '2027-12-25', '2027-12-27'],
    },
  },
  US: {
    weekdays: [1, 2, 3, 4, 5],
    // 夏令时（EDT）基准：北京时间 21:30-次日 04:00；冬令时（EST）由 usSessionsFor 动态计算 22:30-次日 05:00
    sessions: [[1290, 1440], [0, 240]],
    holidays: {
      '2025': ['2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
      '2026': ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
      '2027': ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
    },
  },
};

// ─── 美股夏令时（美东时间）：3 月第二个周日 02:00 起，11 月第一个周日 02:00 止 ───
export function secondSundayOfMarch(year: number): number {
  const first = new Date(year, 2, 1);
  return 1 + ((7 - first.getDay()) % 7) + 7;
}

export function firstSundayOfNovember(year: number): number {
  const first = new Date(year, 10, 1);
  return 1 + ((7 - first.getDay()) % 7);
}

export function isUsDaylightSaving(date: Date): boolean {
  const m = date.getMonth();
  const day = date.getDate();
  const y = date.getFullYear();
  if (m > 2 && m < 10) return true;
  if (m === 2) return day >= secondSundayOfMarch(y);
  if (m === 10) return day < firstSundayOfNovember(y);
  return false;
}

// 美股交易时段（北京时间分钟制）：夏令时 [[1290,1440],[0,240]]，冬令时 [[1350,1440],[0,300]]
export function usSessionsFor(date: Date): number[][] {
  return isUsDaylightSaving(date) ? [[1290, 1440], [0, 240]] : [[1350, 1440], [0, 300]];
}

// 美盘跨午夜归属：北京时间 0:00-5:00 属于上一日历日的美盘
export function marketDateFor(market: string, date: Date): Date {
  if (market !== 'US') return date;
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes < 300) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1, 12, 0);
  }
  return date;
}

export function isMarketHoliday(market: 'CN' | 'HK' | 'US', date: Date): boolean {
  const d = marketDateFor(market, date);
  const y = String(d.getFullYear());
  const list = TRADING_CALENDAR[market].holidays[y] || [];
  const dateStr = y + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return list.includes(dateStr);
}

export function tradingMinutesFor(market: string): number {
  return market === 'HK' ? 330 : market === 'US' ? 390 : 240;
}

export function tradingMinuteIndex(market: string, date: Date): number | null {
  const sessions = market === 'US' ? usSessionsFor(date) : TRADING_CALENDAR[market === 'HK' ? 'HK' : 'CN'].sessions;
  const minute = date.getHours() * 60 + date.getMinutes();
  let offset = 0;
  for (const [start, end] of sessions) {
    if (minute >= start && minute < end) return offset + minute - start;
    offset += end - start;
  }
  return null;
}

export function marketSessionClosed(market: string, date: Date): boolean {
  const minute = date.getHours() * 60 + date.getMinutes();
  if (market === 'US') {
    const sessions = usSessionsFor(date);
    return minute >= sessions[1][1] && minute < sessions[0][0];
  }
  return minute >= (market === 'HK' ? 960 : 900);
}

export function gameTradingTime(market: string, day: number, minute: number, date = new Date()): Date {
  const sessions = market === 'US' ? usSessionsFor(date) : TRADING_CALENDAR[market === 'HK' ? 'HK' : 'CN'].sessions;
  let offset = minute;
  for (let i = 0; i < sessions.length; i++) {
    const [start, end] = sessions[i];
    if (offset < end - start) return new Date(2024, 0, 1 + day + (market === 'US' && i > 0 ? 1 : 0), 0, start + offset);
    offset -= end - start;
  }
  throw new RangeError('交易分钟超出当日时段');
}

export type CalendarMarket = 'CN' | 'HK' | 'US';
const ZONES = {CN:'Asia/Shanghai', HK:'Asia/Hong_Kong', US:'America/New_York'};
const HALF_DAYS: Record<string, string[]> = {
  HK:['2026-02-16','2026-12-24','2026-12-31'],
  US:['2026-11-27','2026-12-24'],
};
const EXCHANGE_FORMATTERS = Object.fromEntries(Object.entries(ZONES).map(([market,timeZone])=>[market,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})]));
export function exchangeParts(market: CalendarMarket, time: Date) {
  const parts = Object.fromEntries(EXCHANGE_FORMATTERS[market].formatToParts(time).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};
}
export function exchangeSessions(market: CalendarMarket, date: string): number[][] {
  const half = HALF_DAYS[market]?.includes(date);
  return market === 'US' ? [[570,half?780:960]] : market === 'HK' ? (half?[[570,720]]:[[570,720],[780,960]]) : [[570,690],[780,900]];
}
export function isExchangeTradingDate(market: CalendarMarket, date: string): boolean {
  const weekday = new Date(date+'T12:00:00Z').getUTCDay();
  // Lunar New Year's Eve is a half-day session in Hong Kong, not a full holiday.
  return weekday>0 && weekday<6 && !TRADING_CALENDAR[market].holidays[date.slice(0,4)]?.includes(date);
}
export function exchangeTime(market: CalendarMarket, date: string, minute: number): Date {
  const target = Date.parse(date+'T00:00:00Z') + minute*60000;
  let utc = target;
  for(let i=0;i<3;i++) {
    const local = exchangeParts(market,new Date(utc));
    utc += target-(Date.parse(local.date+'T00:00:00Z')+local.minute*60000);
  }
  return new Date(utc);
}
export function realTradingTime(market: CalendarMarket, date: string, minute: number): Date {
  for(const [start,end] of exchangeSessions(market,date)) {
    if(minute<end-start) return exchangeTime(market,date,start+minute);
    minute-=end-start;
  }
  throw new RangeError('Trading minute is outside the session');
}
export function realMarketClock(market: CalendarMarket, now = new Date()) {
  const local = exchangeParts(market,now), sessions = exchangeSessions(market,local.date);
  const valid = isExchangeTradingDate(market,local.date);
  let minute: number|null = null, offset=0;
  for(const [start,end] of sessions) {if(valid&&local.minute>=start&&local.minute<end) minute=offset+local.minute-start;offset+=end-start;}
  const phase = minute!==null?'continuous':valid&&market==='CN'&&local.minute>=555&&local.minute<560?'auction-open':valid&&market==='CN'&&local.minute>=560&&local.minute<565?'auction-locked':valid&&market==='CN'&&local.minute>=565&&local.minute<570?'pre-open':valid&&market==='CN'&&local.minute>=900&&local.minute<930?'post-close':'closed';
  const status = phase!=='closed'?phase:valid&&sessions.length>1&&local.minute>=sessions[0][1]&&local.minute<sessions[1][0]?'break':'closed';
  let nextOpen: string|null=null;
  for(let d=0;d<370&&!nextOpen;d++) {
    const date = new Date(Date.parse(local.date+'T00:00:00Z')+d*86400000).toISOString().slice(0,10);
    if(!isExchangeTradingDate(market,date))continue;
    for(const [start] of exchangeSessions(market,date)) {const open=exchangeTime(market,date,start);if(open>now){nextOpen=open.toISOString();break;}}
  }
  return {date:local.date, minute, phase, status, timeZone:ZONES[market], now:now.toISOString(), nextOpen,
    sessionClosed:local.minute>=sessions[sessions.length-1][1],tradingMinutes:offset};
}
