import catalog from '../domain/catalog.json';
import { MarketId, MarketClock, Phase } from '../domain/types';
export const LENGTH: Record<MarketId, number> = {CN:240,HK:330,US:390};
export function tradingDate(market: MarketId, date: string): boolean {
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const holidays = catalog.calendar[market].holidays as Record<string,string[]>;
  return weekday > 0 && weekday < 6 && !(holidays[date.slice(0,4)] ?? []).includes(date);
}
export function nextTradingDate(market: MarketId, date: string): string {
  let time = Date.parse(date + 'T12:00:00Z');
  for (let count=0;count<370;count++) { time += 86400000; const next = new Date(time).toISOString().slice(0,10); if (tradingDate(market,next)) return next; }
  throw new Error('No trading date found');
}
export function phaseFor(market: MarketId, minute: number): Phase {
  if (minute < 0) return market === 'CN' ? (minute < -10 ? 'auction-open' : minute < -5 ? 'auction-locked' : 'pre-open') : 'closed';
  if (minute < LENGTH[market]) return 'continuous';
  return market === 'CN' && minute < LENGTH.CN + 30 ? 'post-close' : 'closed';
}
function parts(at: Date, zone: string): Record<string,string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}
export function realClock(market: MarketId, at: Date): { date: string; minute: number; phase: Phase; key: string } {
  const local = parts(at,market==='US'?'America/New_York':'Asia/Shanghai');
  const date = `${local.year}-${local.month}-${local.day}`;
  const wallMinute = Number(local.hour)*60+Number(local.minute);
  let minute = -100;
  if (market==='US') minute=wallMinute-570;
  else if (wallMinute<570) minute=wallMinute-570;
  else if (market==='CN') minute=wallMinute<690?wallMinute-570:wallMinute<780?-100:wallMinute-660;
  else minute=wallMinute<720?wallMinute-570:wallMinute<780?-100:wallMinute-630;
  const phase = tradingDate(market,date) && (minute>=0 || (market==='CN' && minute>=-15)) ? phaseFor(market,minute) : 'closed';
  return {date,minute,phase,key: `${market}:${date}:${local.hour}:${local.minute}`};
}
export function candleTime(market: MarketId, clock: MarketClock): number {
  const base = Date.parse(clock.date+'T00:00:00Z');
  const minute = Math.max(0,clock.minute);
  const offset = market==='US'?570+minute:minute+(minute>=(market==='CN'?120:150)?(market==='CN'?660:630):570);
  if (market!=='US') return base+(offset-480)*60000;
  const noon = new Date(base+16*3600000); const eastHour = Number(parts(noon,'America/New_York').hour);
  const timezoneOffset = eastHour-16;
  return base+(offset-timezoneOffset*60)*60000;
}
