import { Account, MarketId, World } from '../domain/types';
import { LENGTH, candleTime, nextTradingDate } from './calendar';
import { random, normal } from './random';
import { basketValue, emit, equity, id, longQuantity, postCash, system } from './world';
export function evolveEconomy(world: World, market: MarketId): void {
  const state=world.markets[market];const stream=`economy:${market}`;
  state.sentiment=Math.max(-1,Math.min(1,state.sentiment*0.995+normal(world,stream)*0.01));
  for(const [industry,sector] of Object.entries(state.sectors)) {
    sector.trend=sector.trend*0.997+normal(world,`${stream}:${industry}`)*0.00005;
    sector.heat*=0.998;
  }
  for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) {
    const quote=world.quotes[instrument.symbol]; const sector=state.sectors[instrument.industry];
    const gap=(quote.fairValue-quote.price)/Math.max(1,quote.price);
    const noise=normal(world,`${stream}:${instrument.symbol}`)*instrument.volatility/Math.sqrt(LENGTH[market]);
    let change=noise+gap*0.008+sector.trend+sector.heat*0.0002+state.sentiment*0.0001+quote.momentum*0.01;
    quote.bubble=Math.max(0,quote.bubble+(quote.price/quote.fairValue-1)*0.002);
    if(quote.bubble>0.5&&random(world,stream)<0.006) {change-=Math.min(0.07,quote.bubble*0.02);quote.bubble*=0.6;emit(world,market,'shock',`${instrument.name}资金流逆转`,'高估值遭遇抛售，波动正在传导至相关行业。',-1,instrument.symbol);sector.trend-=0.0005;}
    quote.price=Math.max(100,Math.round(quote.price*(1+change)));
    if(market==='CN') quote.price=Math.max(Math.ceil(quote.previousClose*0.9),Math.min(Math.floor(quote.previousClose*1.1),quote.price));
    quote.high=Math.max(quote.high,quote.price);quote.low=Math.min(quote.low,quote.price);
  }
  if(state.clock.minute%45===0&&random(world,stream)<0.45) {
    const sectors=Object.keys(state.sectors);const industry=sectors[Math.floor(random(world,stream)*sectors.length)];const bullish=random(world,stream)>0.55;
    state.sectors[industry].heat+=bullish?0.8:-0.8;
    emit(world,market,'news',`${industry}${bullish?'订单预期升温':'面临利润压力'}`,`第${state.clock.day}交易日公布的行业消息改变了市场预期；影响将逐分钟衰减。`,bullish?1:-1);
  }
  if(state.clock.minute%90===30) {
    const surprise=normal(world,stream)*0.002;state.growth+=surprise;state.sentiment+=surprise*10;
    emit(world,market,'macro','PMI / 宏观预期更新',`经济增长预期 ${(state.growth*100).toFixed(2)}%，预期差 ${(surprise*100).toFixed(2)}%。`,Math.sign(surprise));
  }
}
export function recordCandles(world: World, market: MarketId, startVolumes: Record<string,number>): void {
  const clock=world.markets[market].clock;const time=candleTime(market,clock);
  for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) {
    const quote=world.quotes[instrument.symbol];const candle={time,day:clock.day,open:quote.history.at(-1)?.close??quote.open,high:quote.price,low:quote.price,close:quote.price,volume:quote.volume-(startVolumes[instrument.symbol]??0)};
    candle.high=Math.max(candle.open,candle.close);candle.low=Math.min(candle.open,candle.close);
    const existing=quote.history.at(-1);
    if(existing?.time===time) quote.history[quote.history.length-1]={...existing,high:Math.max(existing.high,candle.high),low:Math.min(existing.low,candle.low),close:candle.close,volume:existing.volume+candle.volume};
    else quote.history.push(candle);
    if(quote.history.length>10000) quote.history=quote.history.slice(-10000);
  }
}
export function settleDay(world: World, market: MarketId): void {
  const state=world.markets[market]; const day=state.clock.day;
  if(state.clock.settledDay>=day) return;
  const basket=basketValue(world,market);
  state.fundNav.money+=Math.max(1,Math.round(state.fundNav.money*state.rate/252));
  state.fundNav.etf=Math.max(1,Math.round(state.fundNav.etf*(basket+state.fundNav.dividend)/state.fundNav.basket));
  state.fundNav.basket=basket;state.fundNav.dividend=0;state.lastNavDay=day;
  for(const accountState of Object.values(world.accounts).filter(item=>item.market===market&&item.actor!=='system')) {
    const interest=Math.ceil(accountState.debt*0.06/252 + Object.values(accountState.positions).reduce((sum,held)=>sum+held.shortQuantity*world.quotes[held.symbol].price,0)*0.03/252);
    if(interest>0) postCash(world,accountState,system(world,market,'bank'),Math.min(accountState.cash,interest),'interest',id(world,'interest'));
    const value=equity(world,accountState);accountState.equityHistory.push({day,equity:value});
    if(accountState.equityHistory.length>1000) accountState.equityHistory=accountState.equityHistory.slice(-1000);
    accountState.adaptation=Math.max(0.4,Math.min(1.5,accountState.adaptation*(value>=accountState.lastEquity?1.01:0.97)));accountState.lastEquity=value;
    if(value>=accountState.initialEquity*1.1&&!accountState.achievements.includes('return-10')) accountState.achievements.push('return-10');
  }
  closeSeasons(world,market);state.clock.settledDay=day;
  emit(world,market,'settlement','日终结算完成','利息、基金净值、账户快照和赛季使用同一交易日，并可安全重试。');
}
export function openDay(world: World, market: MarketId): void {
  const state=world.markets[market];state.clock.date=nextTradingDate(market,state.clock.date);state.clock.day++;state.clock.minute=market==='CN'?-15:0;
  for(const [industry,sector] of Object.entries(state.sectors)) {
    if(random(world,`cycle:${market}:${industry}`)<0.08) sector.cycle=(sector.cycle+1)%4;
    sector.trend+=(sector.cycle===0?1:sector.cycle===2?-1:0)*0.0001;
  }
  const marketGap=normal(world,`overnight:${market}`)*0.007;
  for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) {
    const quote=world.quotes[instrument.symbol];
    quote.daily.push({time:Date.parse(state.clock.date+'T00:00:00Z')-86400000,day:state.clock.day-1,open:quote.open,high:quote.high,low:quote.low,close:quote.price,volume:quote.volume});
    quote.previousClose=quote.price;
    const gap=Math.max(market==='CN'?-0.1:-0.3,Math.min(market==='CN'?0.1:0.3,marketGap+normal(world,`gap:${instrument.symbol}`)*0.005));
    quote.price=Math.max(100,Math.round(quote.price*(1+gap)));quote.open=quote.price;quote.high=quote.price;quote.low=quote.price;quote.volume=0;quote.turnover=0;
    if(state.clock.day%45===Number(instrument.code.replace(/\D/g,'').slice(-2))%45) earnings(world,instrument.symbol);
    if(state.clock.day%20===Number(instrument.code.replace(/\D/g,'').slice(-1))) dividend(world,instrument.symbol);
  }
  if(state.clock.day%10===0&&market==='CN') listIpo(world,market);
  emit(world,market,'open','新交易日开始',`第 ${state.clock.day} 日 · ${state.clock.date}，昨日买入的 A 股已解锁。`);
}
function earnings(world: World, symbol: string): void {
  const instrument=world.instruments[symbol];const quote=world.quotes[symbol];const surprise=normal(world,`earnings:${symbol}`)*0.03;
  quote.earningsGrowth=Math.max(-0.3,Math.min(0.5,quote.earningsGrowth*0.9+surprise));quote.fairValue=Math.max(100,Math.round(quote.fairValue*(1+surprise)));
  quote.pe=Math.max(5,Math.min(80,quote.price/quote.fairValue*20));
  emit(world,instrument.market,'earnings',`${instrument.name}财报披露`,`营收增长 ${(quote.earningsGrowth*100).toFixed(1)}%；预期差 ${(surprise*100).toFixed(1)}%。`,Math.sign(surprise),symbol);
}
function dividend(world: World, symbol: string): void {
  const instrument=world.instruments[symbol];const quote=world.quotes[symbol];const perShare=Math.max(1,Math.round(quote.price*0.001));const oldPrice=quote.price;
  for(const accountState of Object.values(world.accounts).filter(item=>item.market===instrument.market)) {
    const held=accountState.positions[symbol];if(!held) continue;
    const gross=longQuantity(held)*perShare; const shortPayment=held.shortQuantity*perShare;
    if(gross>0) {
      postCash(world,system(world,instrument.market,'issuer'),accountState,gross,'dividend',id(world,'dividend'));
      const withholding=held.lots.reduce((sum,lot)=>sum+Math.floor(lot.quantity*perShare*(instrument.market==='CN'?(world.markets.CN.clock.day-lot.boughtDay>20?0.1:0.2):instrument.market==='US'?0.3:0)),0);
      if(withholding>0) postCash(world,accountState,system(world,instrument.market,'fees'),withholding,'dividend-tax',id(world,'tax'));
    }
    if(shortPayment>0) postCash(world,accountState,system(world,instrument.market,'issuer'),Math.min(accountState.cash,shortPayment),'short-dividend',id(world,'dividend'));
  }
  quote.price=Math.max(1,quote.price-perShare);quote.fairValue=Math.max(1,quote.fairValue-perShare);quote.previousClose=Math.max(1,quote.previousClose-perShare);quote.dividendFactor*=oldPrice/quote.price;
  world.markets[instrument.market].fundNav.dividend+=perShare/instrument.initialPrice/Object.values(world.instruments).filter(item=>item.market===instrument.market).length;
  emit(world,instrument.market,'dividend',`${instrument.name}除权分红`,`每股派发 ${(perShare/100).toFixed(2)}，现金与红利税已计入账本。`,0,symbol);
}
function listIpo(world: World, market: MarketId): void {
  const symbol=`IPO${world.markets[market].clock.day}`;if(world.instruments[symbol]) return;
  const price=2000+Math.floor(random(world,'ipo')*4000);const clock=world.markets[market].clock;
  world.instruments[symbol]={symbol,code:`689${String(clock.day).padStart(3,'0')}`,name:`新锐科技 ${clock.day}`,industry:'半导体',market,listedAt:clock.date,description:'新上市虚构企业，研发投入较高，首个财报周期具有较高不确定性。',initialPrice:price,volatility:0.05};
  world.quotes[symbol]={symbol,price,previousClose:price,fairValue:price,open:price,high:price,low:price,volume:0,turnover:0,momentum:0,bubble:0,earningsGrowth:0.12,pe:30,dividendFactor:1,history:[],daily:[]};
  world.accounts[`maker-${market}:${market}`].positions[symbol]={symbol,lots:[{quantity:100000,cost:price,boughtDay:0,debt:0}],shortQuantity:0,shortProceeds:0,collateral:0};
  emit(world,market,'ipo',`${world.instruments[symbol].name}上市`,'新股进入市场与指数，做市商库存受同一风控约束。',1,symbol);
}
function closeSeasons(world: World, market: MarketId): void {
  for(const season of world.seasons.filter(item=>item.market===market&&!item.finished&&item.endDay<=world.markets[market].clock.day)) {
    const entrants=Object.keys(season.entrants).map(accountId=>({account:world.accounts[accountId],return:equity(world,world.accounts[accountId])/season.entrants[accountId].initial-1})).sort((left,right)=>right.return-left.return);
    entrants.forEach((entry,index)=>{season.entrants[entry.account.id].final=equity(world,entry.account);entry.account.seasonPoints+=Math.max(1,100-index*10);});season.finished=true;
    emit(world,market,'season','赛季已结算',`${season.type} 赛事结算完成，资产不发放凭空现金奖励；积分单独记录。`);
  }
}
