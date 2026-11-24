// Exchange sessions use a versioned, validated data snapshot. Sync the frontend copy with calendar-data.cjs.
import exchangeCalendar from './exchange-calendar.json';

export type CalendarMarket = 'CN' | 'HK' | 'US';
export interface MarketCalendar { weekdays: number[]; sessions: number[][]; holidays: Record<string,string[]> }
interface CalendarYear { confidence: string; holidays: string[]; halfDays: string[]; sources: string[] }
interface CalendarSnapshot { schemaVersion: number; updatedAt: string; markets: Record<CalendarMarket,{years:Record<string,CalendarYear>;notes?:string}> }
const snapshot: CalendarSnapshot = exchangeCalendar;
const holidays = (market: CalendarMarket): Record<string,string[]> => Object.fromEntries(Object.entries(snapshot.markets[market].years).map(([year,data]) => [year,data.holidays]));
export const TRADING_CALENDAR: Record<CalendarMarket,MarketCalendar> = {
  CN:{weekdays:[1,2,3,4,5],sessions:[[570,690],[780,900]],holidays:holidays('CN')},
  HK:{weekdays:[1,2,3,4,5],sessions:[[570,720],[780,960]],holidays:holidays('HK')},
  US:{weekdays:[1,2,3,4,5],sessions:[[1290,1440],[0,240]],holidays:holidays('US')},
};
export function calendarCoverage(market: CalendarMarket, date: string) {
  const year=date.slice(0,4), entry=snapshot.markets[market].years[year];
  return {year,available:!!entry,confidence:entry?.confidence ?? 'unavailable',updatedAt:snapshot.updatedAt,sources:entry?.sources ?? []};
}

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

const ZONES = {CN:'Asia/Shanghai', HK:'Asia/Hong_Kong', US:'America/New_York'};
const EXCHANGE_FORMATTERS = Object.fromEntries(Object.entries(ZONES).map(([market,timeZone])=>[market,new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})]));
export function exchangeParts(market: CalendarMarket, time: Date) {
  const parts = Object.fromEntries(EXCHANGE_FORMATTERS[market].formatToParts(time).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};
}
export function exchangeSessions(market: CalendarMarket, date: string): number[][] {
  const half = snapshot.markets[market].years[date.slice(0,4)]?.halfDays.includes(date);
  return market === 'US' ? [[570,half?780:960]] : market === 'HK' ? (half?[[570,720]]:[[570,720],[780,960]]) : [[570,690],[780,900]];
}
export function isExchangeTradingDate(market: CalendarMarket, date: string): boolean {
  if(!calendarCoverage(market,date).available)return false;
  const parsed=new Date(date+'T12:00:00Z');
  if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==date)return false;
  const weekday = parsed.getUTCDay();
  // Lunar New Year's Eve is a half-day session in Hong Kong, not a full holiday.
  return weekday>0 && weekday<6 && !TRADING_CALENDAR[market].holidays[date.slice(0,4)]?.includes(date);
}

/** Full, already completed exchange sessions; no future or unverified dates. */
export function completedTradingDates(market: CalendarMarket, count: number, now = new Date()): string[] {
  if(!Number.isInteger(count)||count<1||count>365)throw new RangeError('Invalid completed-session count');
  const local=exchangeParts(market,now), sessions=exchangeSessions(market,local.date);
  const includeToday=isExchangeTradingDate(market,local.date)&&local.minute>=sessions[sessions.length-1][1];
  const dates: string[]=[];
  for(let back=includeToday?0:1;back<3700&&dates.length<count;back++) {
    const date=new Date(Date.parse(local.date+'T12:00:00Z')-back*86400000).toISOString().slice(0,10);
    if(isExchangeTradingDate(market,date))dates.push(date);
  }
  if(dates.length!==count)throw new RangeError('Insufficient reviewed exchange-calendar coverage for history');
  return dates.reverse();
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
  return {calendar:calendarCoverage(market,local.date),date:local.date, minute, phase, status, timeZone:ZONES[market], now:now.toISOString(), nextOpen,
    sessionClosed:local.minute>=sessions[sessions.length-1][1],tradingMinutes:offset};
}
