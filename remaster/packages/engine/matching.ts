import { integer } from '../domain/money';
import { Order, OrderInput, RuleError, World } from '../domain/types';
import { account, id } from './world';
import { settleTrade, validateFill } from './settlement';
const buySide=(order:Order)=>order.side==='buy'||order.side==='cover';
export function active(order: Order): boolean { return order.status==='pending'||order.status==='partial'; }
export function tradable(order: Order): boolean { return active(order) && (order.triggered || !['stop','stop-limit'].includes(order.type)); }
export function candidates(world: World, incoming: Order): Order[] {
  return Object.values(world.orders).filter(resting=>resting.symbol===incoming.symbol && tradable(resting) && resting.id!==incoming.id && resting.accountId!==incoming.accountId && buySide(resting)!==buySide(incoming) && resting.price!==undefined && resting.postClose===incoming.postClose).sort((left,right)=>(buySide(incoming)?left.price!-right.price!:right.price!-left.price!)||left.sequence-right.sequence);
}
function executable(incoming: Order, resting: Order): boolean {
  if(incoming.price===undefined || (incoming.type==='stop' && incoming.triggered)) return true;
  return buySide(incoming)?resting.price!<=incoming.price:resting.price!>=incoming.price;
}
export function match(world: World, incoming: Order): void {
  let loops=0;
  while(incoming.remaining>0 && loops++<5000) {
    const opposing=candidates(world,incoming).find(order=>executable(incoming,order));
    if(!opposing) break;
    const quantity=Math.min(incoming.remaining,incoming.visible||incoming.remaining,opposing.visible||opposing.remaining);
    try {validateFill(world,opposing,opposing.price!,quantity);} catch(error) {
      if(!(error instanceof RuleError)) throw error;
      opposing.status='rejected';opposing.error=error.message;continue;
    }
    const buy=buySide(incoming)?incoming:opposing; const sell=buySide(incoming)?opposing:incoming;
    try {validateFill(world,incoming,opposing.price!,quantity);}catch(error){if(!(error instanceof RuleError))throw error;incoming.status=incoming.filled?'cancelled':'rejected';incoming.error=error.message;break;}
    settleTrade(world,buy,sell,opposing.price!,quantity);
  }
}
export function placeOrder(world: World, owner: string, market: 'CN'|'HK'|'US', input: OrderInput, commandId: string, actorId?: string): Order {
  const accountState=actorId?world.accounts[actorId]:account(world,owner,market);
  const instrument=world.instruments[input.symbol];const state=world.markets[market];
  if(!instrument || instrument.market!==market) throw new RuleError('INVALID_SYMBOL','标的不属于当前市场');
  if(!['buy','sell','short','cover'].includes(input.side)||!['market','limit','stop','stop-limit','fok','ioc','iceberg'].includes(input.type)) throw new RuleError('INVALID_ORDER','订单方向或类型无效');
  integer(input.quantity,'数量',1,100000);const needsLimit=['limit','stop-limit','fok','ioc','iceberg'].includes(input.type);
  if(needsLimit) integer(input.price,'限价',1,10_000_000);
  if(['stop','stop-limit'].includes(input.type)) integer(input.triggerPrice,'触发价',1,10_000_000);
  if(input.type==='iceberg') integer(input.displayQuantity,'显示数量',1,input.quantity);
  if(['closed','pre-open'].includes(state.clock.phase)) throw new RuleError('MARKET_CLOSED','当前市场未开放交易');
  if(state.clock.phase.startsWith('auction') && input.type!=='limit') throw new RuleError('AUCTION_LIMIT_ONLY','集合竞价仅接受限价单');
  const quote=world.quotes[input.symbol]; const referencePrice=input.price??input.triggerPrice??quote.price;
  if(market==='CN' && (referencePrice<Math.ceil(quote.previousClose*0.9)||referencePrice>Math.floor(quote.previousClose*1.1))) throw new RuleError('PRICE_LIMIT','价格超出当日涨跌停范围');
  const postClose=state.clock.phase==='post-close';
  if(postClose && (input.type!=='limit'||input.price!==quote.price)) throw new RuleError('POST_CLOSE_PRICE','盘后交易只接受收盘价限价单');
  const order:Order={id:id(world,'order'),commandId,accountId:accountState.id,symbol:input.symbol,side:input.side,type:input.type,quantity:input.quantity,remaining:input.quantity,filled:0,averagePrice:0,price:input.price,triggerPrice:input.triggerPrice,displayQuantity:input.displayQuantity,visible:input.type==='iceberg'?input.displayQuantity!:input.quantity,sequence:++world.sequence,createdDay:state.clock.day,status:'pending',triggered:false,postClose};
  const estimated=quote.price;
  validateFill(world,order,needsLimit?input.price!:estimated,input.quantity);
  world.orders[order.id]=order;
  if(state.clock.phase.startsWith('auction') || ['stop','stop-limit'].includes(input.type)) return order;
  if(input.type==='fok') {
    const copy=cloneWorld(world);const probe=copy.orders[order.id];match(copy,probe);
    if(probe.remaining>0) {order.status='cancelled';order.error='FOK无法全部成交';return order;}
  }
  match(world,order);
  if(['market','fok','ioc'].includes(input.type)&&order.remaining>0) {order.status=order.filled>0?'cancelled':'rejected';order.error='剩余数量未成交';}
  return order;
}
export function cancelOrder(world: World, owner: string, orderId: string): Order {
  const order=world.orders[orderId]; if(!order||world.accounts[order.accountId].owner!==owner) throw new RuleError('ORDER_NOT_FOUND','订单不存在');
  if(!active(order)) return order;
  if(world.markets[world.accounts[order.accountId].market].clock.phase==='auction-locked') throw new RuleError('CANCEL_LOCKED','当前竞价阶段不可撤单');
  order.status='cancelled';return order;
}
export function checkPending(world: World, market: 'CN'|'HK'|'US'): void {
  const phase=world.markets[market].clock.phase;if(!['continuous','post-close'].includes(phase))return;
  for(const order of Object.values(world.orders).filter(order=>active(order)&&world.accounts[order.accountId].market===market&&order.postClose===(phase==='post-close')).sort((left,right)=>left.sequence-right.sequence)) {
    if(['stop','stop-limit'].includes(order.type)&&!order.triggered) {
      const price=world.quotes[order.symbol].price;
      order.triggered=buySide(order)?price>=order.triggerPrice!:price<=order.triggerPrice!;
      if(!order.triggered) continue;
    }
    try {match(world,order);} catch(error) {if(!(error instanceof RuleError)) throw error;order.status='rejected';order.error=error.message;}
    if(order.type==='stop'&&order.triggered&&order.remaining>0) order.status='cancelled';
  }
}
export function runAuction(world: World, symbol: string): number {
  const orders=Object.values(world.orders).filter(order=>order.symbol===symbol&&active(order)&&order.price!==undefined&&!order.postClose);
  const previous=world.quotes[symbol].previousClose;let opening=previous;let bestVolume=-1;
  for(const price of [...new Set(orders.map(order=>order.price!))]) {
    const buys=orders.filter(order=>buySide(order)&&order.price!>=price).reduce((sum,order)=>sum+order.remaining,0);
    const sells=orders.filter(order=>!buySide(order)&&order.price!<=price).reduce((sum,order)=>sum+order.remaining,0);
    const volume=Math.min(buys,sells);
    if(volume>bestVolume || (volume===bestVolume && Math.abs(price-previous)<Math.abs(opening-previous))) {opening=price;bestVolume=volume;}
  }
  const buys=orders.filter(order=>buySide(order)&&order.price!>=opening).sort((left,right)=>right.price!-left.price!||left.sequence-right.sequence);
  const sells=orders.filter(order=>!buySide(order)&&order.price!<=opening).sort((left,right)=>left.price!-right.price!||left.sequence-right.sequence);
  for(const buy of buys) for(const sell of sells) {
    if(!buy.remaining||!sell.remaining||buy.accountId===sell.accountId) continue;
    try {settleTrade(world,buy,sell,opening,Math.min(buy.remaining,sell.remaining));} catch(error) {if(!(error instanceof RuleError)) throw error;}
  }
  world.quotes[symbol].open=opening;world.quotes[symbol].price=opening;return opening;
}
export function cloneWorld(world: World): World {
  return {...world,random:{...world.random},instruments:{...world.instruments},quotes:Object.fromEntries(Object.entries(world.quotes).map(([symbol,quote])=>[symbol,{...quote,volatilityState:quote.volatilityState?{...quote.volatilityState}:undefined,pendingNews:quote.pendingNews?.map(shock=>({...shock})),history:[...quote.history],daily:[...quote.daily]}])),markets:structuredClone(world.markets),accounts:structuredClone(world.accounts),orders:structuredClone(world.orders),trades:[...world.trades],ledger:[...world.ledger],events:[...world.events],seasons:structuredClone(world.seasons)};
}
