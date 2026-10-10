import { Candle, Instrument } from '../domain/types';
import { generateHistory } from './historical-model';
export function baselineHistory(instrument: Instrument, seed: number, endDate='2026-10-08', startDate=instrument.listedAt): Candle[] {
  return generateHistory(instrument,seed,endDate,startDate);
}
export function aggregate(bars: Candle[], interval: string): Candle[] {
  if(['1m','day'].includes(interval)) return bars;
  const groups=new Map<number,Candle[]>();
  for(const bar of bars) {
    const time=interval==='5m'?Math.floor(bar.time/300000)*300000:interval==='60m'?Math.floor(bar.time/3600000)*3600000:interval==='week'?Math.floor((bar.time-345600000)/604800000)*604800000+345600000:Date.UTC(new Date(bar.time).getUTCFullYear(),new Date(bar.time).getUTCMonth(),1);
    const group=groups.get(time)??[];group.push(bar);groups.set(time,group);
  }
  return [...groups].map(([time,group])=>({time,day:group[0].day,open:group[0].open,high:Math.max(...group.map(bar=>bar.high)),low:Math.min(...group.map(bar=>bar.low)),close:group.at(-1)!.close,volume:group.reduce((sum,bar)=>sum+bar.volume,0)}));
}
