import { MARKETS, MarketId, World } from '../../packages/domain/types';
import { accountId, equity, longQuantity, sellable } from '../../packages/engine/world';
import { active } from '../../packages/engine/matching';
import { marginRatio, reservedCash } from '../../packages/engine/settlement';
import { aggregate, baselineHistory } from '../../packages/engine/history';
import { performance } from '../../packages/engine/analytics';
export function snapshot(world: World, owner: string): unknown {
  const accounts=Object.fromEntries(MARKETS.map(market=>{
    const held=world.accounts[accountId(owner,market)];if(!held) return [market,null];
    const positions=Object.values(held.positions).filter(position=>longQuantity(position)||position.shortQuantity).map(position=>{
      const quantity=longQuantity(position);const cost=position.lots.reduce((sum,lot)=>sum+lot.quantity*lot.cost,0);
      return {...position,quantity,sellable:sellable(world,held,position.symbol),cost:quantity?Math.round(cost/quantity):0,pnl:world.quotes[position.symbol].price*quantity-cost+position.shortProceeds-world.quotes[position.symbol].price*position.shortQuantity};
    });
    const value=equity(world,held);
    return [market,{...held,positions,available:Math.max(0,held.cash-reservedCash(world,held)),reserved:reservedCash(world,held),equity:value,totalReturn:held.initialEquity>0?value/held.initialEquity-1:0,marginRatio:Number.isFinite(marginRatio(world,held))?marginRatio(world,held):null,metrics:performance(held.equityHistory,held.initialEquity)}];
  }));
  const quotes=Object.fromEntries(Object.entries(world.quotes).map(([symbol,quote])=>{const {history,daily,pendingNews,volatilityState,...values}=quote;return [symbol,{...values,candle:history.at(-1),change:quote.price/quote.previousClose-1}];}));
  const indices=MARKETS.map(market=>{const items=Object.values(world.instruments).filter(item=>item.market===market);return {market,value:1000*items.reduce((sum,item)=>sum+world.quotes[item.symbol].price/item.initialPrice,0)/items.length,change:items.reduce((sum,item)=>sum+quotes[item.symbol].change,0)/items.length,advancing:items.filter(item=>world.quotes[item.symbol].price>=world.quotes[item.symbol].previousClose).length,count:items.length};});
  return {protocolVersion:2,kind:'snapshot',worldVersion:world.version,sequence:world.version,mode:world.mode,simulatedAt:Object.fromEntries(MARKETS.map(market=>[market,world.markets[market].clock])),instruments:Object.values(world.instruments),markets:world.markets,quotes,indices,accounts,orders:Object.values(world.orders).filter(order=>world.accounts[order.accountId].owner===owner).slice(-200).reverse(),trades:world.trades.filter(trade=>world.accounts[trade.buyer].owner===owner||world.accounts[trade.seller].owner===owner).slice(-100).reverse(),events:world.events.slice(-60).reverse(),seasons:world.seasons,rankings:ranking(world)};
}
export function ranking(world: World): unknown[] {
  return Object.values(world.accounts).filter(item=>item.actor==='player'||item.actor==='ai').map(item=>({id:item.id,name:item.name,market:item.market,actor:item.actor,strategy:item.strategy,equity:equity(world,item),return:equity(world,item)/Math.max(1,item.initialEquity)-1,seasonPoints:item.seasonPoints})).sort((left,right)=>right.return-left.return);
}
const baselineCache=new Map<string,ReturnType<typeof baselineHistory>>();
export function history(world: World, symbol: string, interval: string, adjusted=false, all=false): unknown[] {
  const quote=world.quotes[symbol];if(!quote) return [];
  let bars=quote.history;
  if(['day','week','month'].includes(interval)) {
    const key=`${world.seed}:${symbol}`;
    if(all&&!baselineCache.has(key)) baselineCache.set(key,baselineHistory(world.instruments[symbol],world.seed));
    bars=all?[...(baselineCache.get(key)??[]),...quote.daily.filter(bar=>bar.day>0)]:quote.daily;
    const clock=world.markets[world.instruments[symbol].market].clock;
    bars=[...bars,{time:Date.parse(clock.date+'T12:00:00Z'),day:clock.day,open:quote.open,high:quote.high,low:quote.low,close:quote.price,volume:quote.volume}];
  }
  const grouped=aggregate(bars,interval);
  return adjusted?grouped.map(bar=>bar.day>0?bar:{...bar,open:Math.round(bar.open/quote.dividendFactor),high:Math.round(bar.high/quote.dividendFactor),low:Math.round(bar.low/quote.dividendFactor),close:Math.round(bar.close/quote.dividendFactor)}):grouped;
}
