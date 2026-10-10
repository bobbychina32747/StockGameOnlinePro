import { MarketId, OrderInput, RuleError, World } from '../domain/types';
import { active, checkPending, placeOrder } from './matching';
import { longQuantity, sellable, emit } from './world';
import { marginRatio, reservedCash } from './settlement';
import { random } from './random';
export function refreshLiquidity(world: World, market: MarketId): void {
  const maker=world.accounts[`maker-${market}:${market}`];
  for(const order of Object.values(world.orders).filter(item=>item.accountId===maker.id&&active(item))) order.status='cancelled';
  for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) {
    const quote=world.quotes[instrument.symbol];const limitLow=Math.ceil(quote.previousClose*0.9);const limitHigh=Math.floor(quote.previousClose*1.1);
    const spread=Math.max(1,Math.round(quote.price*(0.0008+instrument.volatility*0.02)));
    for(const side of ['buy','sell'] as const) for(let level=1;level<=3;level++) {
      const price=quote.price+(side==='buy'?-1:1)*spread*level;
      if(market==='CN'&&(price<limitLow||price>limitHigh)) continue;
      const quantity=level*400;
      if(side==='sell'&&sellable(world,maker,instrument.symbol)<quantity) continue;
      try {placeOrder(world,maker.owner,market,{symbol:instrument.symbol,side,type:'limit',quantity,price},`maker-${world.sequence}-${level}`,maker.id);} catch(error) {if(!(error instanceof RuleError)) throw error;}
    }
  }
}
export function runParticipants(world: World, market: MarketId): void {
  const instruments=Object.values(world.instruments).filter(item=>item.market===market);
  const stream=`participants:${market}`;
  for(const actor of Object.values(world.accounts).filter(item=>item.market===market&&item.actor==='ai')) {
    if(random(world,stream)>0.22*actor.adaptation) continue;
    const instrument=instruments[Math.floor(random(world,stream)*instruments.length)];const quote=world.quotes[instrument.symbol];
    const held=actor.positions[instrument.symbol];const amount=held?longQuantity(held):0;
    const gap=quote.fairValue/quote.price-1;const sector=world.markets[market].sectors[instrument.industry];
    const score=actor.strategy==='value'?gap:actor.strategy==='trend'?quote.momentum*10:actor.strategy==='momentum'?quote.price/quote.previousClose-1:actor.strategy==='herd'?sector.heat*0.1:actor.strategy==='contrarian'?-world.markets[market].sentiment*0.1:random(world,stream)-0.5;
    const cost=held?.lots[0]?.cost??quote.price;const pnl=quote.price/cost-1;
    const side=amount>0&&(score<0||pnl>0.05||pnl<-.03)?'sell':'buy';
    const quantity=side==='sell'?Math.min(100,sellable(world,actor,instrument.symbol)):Math.min(100,Math.floor(Math.max(0,actor.cash-reservedCash(world,actor))*0.015/quote.price));
    if(quantity<1) continue;
    try {placeOrder(world,actor.owner,market,{symbol:instrument.symbol,side,type:'market',quantity},`ai-${world.sequence}-${actor.id}`,actor.id);} catch(error) {if(!(error instanceof RuleError)) throw error;}
  }
  checkPending(world,market);
}
export function manageRisk(world: World, market: MarketId): void {
  for(const actor of Object.values(world.accounts).filter(item=>item.market===market&&item.actor==='player')) {
    const ratio=marginRatio(world,actor);if(ratio>=1.4) continue;
    if(world.markets[market].clock.minute%30===0) emit(world,market,'risk',ratio<1.2?'强平风险':ratio<1.3?'追保提示':'保证金预警',`${actor.name}维持担保比例 ${(ratio*100).toFixed(1)}%。`,-1);
    if(ratio>=1.3) continue;
    for(const order of Object.values(world.orders).filter(item=>item.accountId===actor.id&&active(item))) order.status='cancelled';
    for(const held of Object.values(actor.positions)) {
      for(const side of ['cover','sell'] as const) {
        const maximum=side==='cover'?held.shortQuantity:sellable(world,world.accounts[actor.id],held.symbol);
        const quantity=ratio<1.2?maximum:Math.ceil(maximum/3);
        if(quantity<1) continue;
        try {placeOrder(world,actor.owner,market,{symbol:held.symbol,side,type:'market',quantity},`risk-${world.sequence}-${actor.id}`,actor.id);} catch(error) {if(!(error instanceof RuleError)) throw error;}
      }
    }
  }
}
