import { Candle, Instrument } from '../domain/types';
import { hashSeed } from './random';
import { nextTradingDate, tradingDate } from './calendar';
import { factor, gaussian, generator, student, updateVolatility } from './volatility';
const memo=new Map<string,Candle[]>();
export function generateHistory(instrument:Instrument,seed:number,endDate='2026-10-08',startDate=instrument.listedAt):Candle[] {
  const profile=instrument.riskProfile;
  const cacheKey=`${seed}:${instrument.symbol}:${instrument.listedAt}:${instrument.initialPrice}:${instrument.volatility}:${JSON.stringify(profile)}:${endDate}`;
  let complete=memo.get(cacheKey);
  if(!complete){
    let date=instrument.listedAt;if(!tradingDate(instrument.market,date))date=nextTradingDate(instrument.market,date);
    const volatility={variance:1,shock:0};const raw:{date:string;open:number;high:number;low:number;close:number;volume:number}[]=[];
    const sigma=Math.max(.006,Math.min(.06,instrument.volatility));let logClose=0;
    const baseVolume=20000+hashSeed(instrument.symbol+':volume')%150000;
    while(date<endDate){
      const draw=generator(hashSeed(`${seed}:${instrument.symbol}:${date}:daily`));
      const marketWeight=profile?.marketWeight??.48,sectorWeight=profile?.sectorWeight??.28;
      const idiosyncraticWeight=Math.sqrt(Math.max(.01,1-marketWeight**2-sectorWeight**2));
      const innovation=marketWeight*factor(seed,'market:'+instrument.market,date)+sectorWeight*factor(seed,'sector:'+instrument.market+':'+instrument.industry,date)+idiosyncraticWeight*student(draw);
      const shock=updateVolatility(volatility,innovation,profile?.gjr);const jump=draw()<.008?student(draw)*sigma*2.5:0;
      const dailyReturn=.00012+sigma*shock+jump;
      const limited=instrument.market==='CN'?Math.max(Math.log(.9),Math.min(Math.log(1.1),dailyReturn)):Math.max(-.4,Math.min(.4,dailyReturn));
      const gapRaw=sigma*Math.sqrt(volatility.variance)*(profile?.gapScale??(instrument.market==='CN'?.28:.5))*student(draw)+(jump?jump*.65:0);
      const gap=instrument.market==='CN'?Math.max(Math.log(.9),Math.min(Math.log(1.1),gapRaw)):Math.max(-.3,Math.min(.3,gapRaw));
      const open=logClose+gap;const close=logClose+limited;
      const wick=sigma*Math.sqrt(volatility.variance)*(profile?.wickScale??.24)*(.5+draw());
      let high=Math.max(open,close)+wick*Math.abs(gaussian(draw));let low=Math.min(open,close)-wick*Math.abs(gaussian(draw));
      if(instrument.market==='CN'){high=Math.min(logClose+Math.log(1.1),high);low=Math.max(logClose+Math.log(.9),low);}
      const volume=Math.round(baseVolume*Math.exp(.35*gaussian(draw))*(.45+.4*Math.sqrt(volatility.variance)+.7*Math.abs(shock)));
      raw.push({date,open,high,low,close,volume});logClose=close;date=nextTradingDate(instrument.market,date);
    }
    const normalization=Math.log(instrument.initialPrice)-(raw.at(-1)?.close??0);
    const price=(value:number)=>Math.max(1,Math.round(Math.exp(value+normalization)));
    complete=raw.map(bar=>({time:Date.parse(bar.date+'T12:00:00Z'),day:-Math.round((Date.parse(endDate)-Date.parse(bar.date))/86400000),open:price(bar.open),high:price(bar.high),low:price(bar.low),close:price(bar.close),volume:bar.volume}));
    memo.set(cacheKey,complete);if(memo.size>256)memo.delete(memo.keys().next().value!);
  }
  return complete.filter(bar=>bar.time>=Date.parse(startDate+'T00:00:00Z')).map(bar=>({...bar}));
}
