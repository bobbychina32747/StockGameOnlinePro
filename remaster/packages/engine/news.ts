import calibration from '../domain/news-calibration.json';
import { Instrument, MarketId, World } from '../domain/types';
import { random } from './random';
import { student } from './volatility';
import { emit } from './world';

export type NewsKind='earnings'|'rates'|'supply'|'credit'|'company';
/** Industry direction is an economic assumption; historical event windows do not prove causality. */
export function industryExposure(kind:NewsKind,industry:string):number {
  const exposure=calibration.exposureAssumptions;
  if(kind==='rates')return exposure.rateSensitive.includes(industry)?1.5:industry==='银行'?-.7:.5;
  if(kind==='supply')return exposure.commodityProducers.includes(industry)?1.2:exposure.fuelConsumers.includes(industry)?-.9:-.15;
  if(kind==='credit')return exposure.creditSensitive.includes(industry)?1.6:.5;
  return 1;
}

export function applyNews(world:World,market:MarketId,kind:NewsKind,surprise:number,options:{symbol?:string;industry?:string;anticipated?:number;headline?:string}={}):void {
  const state=world.markets[market];
  const anticipation=Math.max(0,Math.min(.9,options.anticipated??0));
  const magnitude=kind==='earnings'?calibration.earnings.simulationScale:kind==='company'?.012:.008;
  const unexpected=surprise*(1-anticipation);
  if(kind==='rates')state.rate=Math.max(0,Math.min(.12,state.rate-unexpected*.0025));
  for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) {
    const targeted=!options.symbol&&!options.industry||options.symbol===instrument.symbol||options.industry===instrument.industry;
    const spillover=options.symbol&&world.instruments[options.symbol]?.industry===instrument.industry;
    if(!targeted&&!spillover)continue;
    const scope=targeted?1:.15;const sensitivity=instrument.riskProfile?.eventSensitivity??1;
    const response=magnitude*unexpected*sensitivity*scope*industryExposure(kind,instrument.industry);
    const quote=world.quotes[instrument.symbol];
    quote.pendingNews??=[];
    // Publication precedes the first price effect. The step response is spread over subsequent matching minutes.
    quote.pendingNews.push({kind,remainingReturn:Math.max(-.12,Math.min(.12,response)),remainingMinutes:kind==='earnings'?30:90,
      halfLife:kind==='earnings'?8:25,volatilityBoost:Math.min(1.5,Math.abs(unexpected)*scope*.4)});
    quote.pendingNews=quote.pendingNews.slice(-20);
    quote.fairValue=Math.max(100,Math.round(quote.fairValue*Math.exp(response*.5)));
  }
  emit(world,market,kind==='earnings'?'earnings':kind==='company'?'news':'macro',options.headline??'市场预期更新',
    `实际结果相对此前预期的差值 ${(surprise*100).toFixed(1)}%；消息已被计价 ${(anticipation*100).toFixed(0)}%，尚未计价部分将逐步反映，短期波动上升。`,Math.sign(unexpected),options.symbol);
}

export function consumeNews(instrument:Instrument,world:World):{change:number;volatilityMultiplier:number} {
  const quote=world.quotes[instrument.symbol];let change=0,boost=0;
  for(const shock of quote.pendingNews??[]) {
    const decay=1-Math.exp(-Math.LN2/shock.halfLife);
    const step=shock.remainingMinutes===1?shock.remainingReturn:shock.remainingReturn*decay;
    change+=step;boost+=shock.volatilityBoost;shock.remainingReturn-=step;shock.remainingMinutes--;
    shock.volatilityBoost*=1-decay;
  }
  quote.pendingNews=(quote.pendingNews??[]).filter(shock=>shock.remainingMinutes>0);
  return {change,volatilityMultiplier:Math.sqrt(1+Math.min(3,boost))};
}

export function companyNews(world:World,market:MarketId,industry:string):void {
  const companies=Object.values(world.instruments).filter(item=>item.market===market&&item.industry===industry);
  const instrument=companies[Math.floor(random(world,'news:company:'+market)*companies.length)];if(!instrument)return;
  const draw=()=>random(world,'news:surprise:'+instrument.symbol);
  const realized=student(draw)*.7;const consensus=student(draw)*.35;
  const theme=instrument.riskProfile?.newsKinds[Math.floor(draw()*(instrument.riskProfile?.newsKinds.length??1))]??'经营变化';
  applyNews(world,market,'company',realized-consensus,{symbol:instrument.symbol,anticipated:draw()*.65,
    headline:`${instrument.name} · ${theme}${realized>=0?'改善':'承压'}`});
}
