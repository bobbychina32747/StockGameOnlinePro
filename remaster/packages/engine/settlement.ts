import { Account, Order, Position, RuleError, Side, World } from '../domain/types';
import { fees, multiply } from '../domain/money';
import { equity, id, longQuantity, position, postCash, sellable, system } from './world';
export function reservedCash(world: World, accountState: Account, exceptId?: string): number {
  return Object.values(world.orders).filter(order=>order.accountId===accountState.id && order.id!==exceptId && ['pending','partial'].includes(order.status)).reduce((sum,order)=>{
    const price=order.price??order.triggerPrice??world.quotes[order.symbol].price;
    const turnover=price*order.remaining;
    if(order.side==='buy') return sum+Math.ceil(turnover/accountState.leverage)+fees(accountState.market,order.side,turnover);
    if(order.side==='short') return sum+Math.ceil(turnover*0.5)+fees(accountState.market,order.side,turnover);
    if(order.side==='cover') return sum+turnover+fees(accountState.market,order.side,turnover);
    return sum;
  },0);
}
export function reservedQuantity(world: World, accountState: Account, symbol: string, side: Side, exceptId?: string): number {
  return Object.values(world.orders).filter(order=>order.accountId===accountState.id && order.id!==exceptId && order.symbol===symbol && order.side===side && ['pending','partial'].includes(order.status)).reduce((sum,order)=>sum+order.remaining,0);
}
export function validateFill(world: World, order: Order, price: number, quantity: number): void {
  const accountState=world.accounts[order.accountId];
  const held=position(accountState,order.symbol); const turnover=multiply(price,quantity);
  const fee=fees(accountState.market,order.side,turnover); const available=accountState.cash-reservedCash(world,accountState,order.id);
  if(order.side==='buy' && available < Math.ceil(turnover/accountState.leverage)+fee) throw new RuleError('INSUFFICIENT_CASH','可用资金不足（含费用与挂单占用）');
  if(order.side==='sell' && sellable(world,accountState,order.symbol)-reservedQuantity(world,accountState,order.symbol,'sell',order.id)<quantity) throw new RuleError('INSUFFICIENT_POSITION','可卖数量不足或受 T+1 限制');
  if(order.side==='short') {
    if(accountState.market==='CN') throw new RuleError('SHORT_NOT_ALLOWED','A股模拟市场不支持做空');
    if(available < Math.ceil(turnover*0.5)+fee) throw new RuleError('INSUFFICIENT_MARGIN','做空保证金不足');
    const outstanding=Object.values(world.accounts).reduce((sum,accountItem)=>sum+(accountItem.positions[order.symbol]?.shortQuantity??0),0);
    if(outstanding+quantity>100000) throw new RuleError('NO_BORROW','融券池可借数量不足');
  }
  if(order.side==='cover') {
    if(held.shortQuantity-reservedQuantity(world,accountState,order.symbol,'cover',order.id)<quantity) throw new RuleError('INSUFFICIENT_SHORT','可平空数量不足');
    const released=quantity===held.shortQuantity?held.collateral:Math.floor(held.collateral*quantity/held.shortQuantity);
    if(available+released<turnover+fee) throw new RuleError('INSUFFICIENT_CASH','平空资金不足');
  }
}
function removeLots(world: World, accountState: Account, held: Position, quantity: number): number {
  let remaining=quantity; let debt=0; const day=world.markets[accountState.market].clock.day;
  for(const lot of held.lots) {
    if(remaining===0) break;
    if(accountState.market==='CN' && accountState.actor!=='maker' && lot.boughtDay>=day) continue;
    const removed=Math.min(remaining,lot.quantity); const repayment=removed===lot.quantity?lot.debt:Math.floor(lot.debt*removed/lot.quantity);
    lot.quantity-=removed;lot.debt-=repayment;remaining-=removed;debt+=repayment;
  }
  if(remaining!==0) throw new RuleError('INSUFFICIENT_POSITION','可卖持仓不足');
  held.lots=held.lots.filter(lot=>lot.quantity>0);return debt;
}
function changePosition(world: World, accountState: Account, order: Order, price: number, quantity: number, reference: string): void {
  const held=position(accountState,order.symbol); const turnover=multiply(price,quantity);
  if(order.side==='buy') {
    const borrowed=turnover-Math.ceil(turnover/accountState.leverage);
    if(borrowed>0) {postCash(world,system(world,accountState.market,'bank'),accountState,borrowed,'loan',reference);accountState.debt+=borrowed;}
    held.lots.push({quantity,cost:price,boughtDay:world.markets[accountState.market].clock.day,debt:borrowed});
  } else if(order.side==='sell') {
    const repayment=removeLots(world,accountState,held,quantity);
    if(repayment>0) {postCash(world,accountState,system(world,accountState.market,'bank'),repayment,'loan-repayment',reference);accountState.debt-=repayment;}
  } else if(order.side==='short') {
    const collateral=Math.ceil(turnover*0.5);held.shortQuantity+=quantity;held.shortProceeds+=turnover;held.collateral+=collateral;
    accountState.cash-=collateral;accountState.collateral+=collateral;
  } else {
    const released=quantity===held.shortQuantity?held.collateral:Math.floor(held.collateral*quantity/held.shortQuantity);
    const proceeds=quantity===held.shortQuantity?held.shortProceeds:Math.floor(held.shortProceeds*quantity/held.shortQuantity);
    held.shortQuantity-=quantity;held.shortProceeds-=proceeds;held.collateral-=released;accountState.cash+=released;accountState.collateral-=released;
  }
  world.ledger.push({id:id(world,'ledger'),reference,accountId:accountState.id,counterparty:accountState.id,amount:0,currency:accountState.market,kind:`position-${order.side}`,day:world.markets[accountState.market].clock.day});
}
export function settleTrade(world: World, buy: Order, sell: Order, price: number, quantity: number): void {
  const staged:World={...world,accounts:{...world.accounts},quotes:{...world.quotes},ledger:[],trades:[]};
  const market=world.accounts[buy.accountId].market;
  for(const accountId of new Set([buy.accountId,sell.accountId,system(world,market,'fees').id,system(world,market,'bank').id])) staged.accounts[accountId]=structuredClone(world.accounts[accountId]);
  staged.quotes[buy.symbol]={...world.quotes[buy.symbol]};
  const stagedBuy={...buy};const stagedSell={...sell};
  settleTradeInner(staged,stagedBuy,stagedSell,price,quantity);
  world.accounts=staged.accounts;world.quotes[buy.symbol]=staged.quotes[buy.symbol];world.nextId=staged.nextId;world.sequence=staged.sequence;
  world.ledger.push(...staged.ledger);world.trades.push(...staged.trades);Object.assign(buy,stagedBuy);Object.assign(sell,stagedSell);
}
function settleTradeInner(world: World, buy: Order, sell: Order, price: number, quantity: number): void {
  if(buy.accountId===sell.accountId) throw new RuleError('SELF_TRADE','禁止自成交');
  validateFill(world,buy,price,quantity); validateFill(world,sell,price,quantity);
  const buyer=world.accounts[buy.accountId];const seller=world.accounts[sell.accountId];const reference=id(world,'trade');
  changePosition(world,buyer,buy,price,quantity,reference);
  postCash(world,buyer,seller,multiply(price,quantity),'trade',reference);
  changePosition(world,seller,sell,price,quantity,reference);
  for(const [accountState,order] of [[buyer,buy],[seller,sell]] as const) {
    postCash(world,accountState,system(world,accountState.market,'fees'),fees(accountState.market,order.side,price*quantity),'fee',reference);
    const before=order.filled;order.remaining-=quantity;order.filled+=quantity;order.visible=Math.max(0,order.visible-quantity);
    order.averagePrice=Math.round((order.averagePrice*before+price*quantity)/order.filled);order.status=order.remaining===0?'filled':'partial';
    if(order.type==='iceberg' && order.visible===0 && order.remaining>0) {order.visible=Math.min(order.displayQuantity!,order.remaining);order.sequence=++world.sequence;}
    if(accountState.cash<0) throw new RuleError('NEGATIVE_CASH','结算后可用资金不得为负');
    if(accountState.actor==='player' && !accountState.achievements.includes('first-trade')) accountState.achievements.push('first-trade');
  }
  const quote=world.quotes[buy.symbol]; const old=quote.price; quote.price=price;quote.volume+=quantity;quote.turnover+=price*quantity;
  quote.high=Math.max(quote.high,price);quote.low=Math.min(quote.low,price);quote.momentum=quote.momentum*0.8+(price-old)/Math.max(1,old)*0.2;
  const clock=world.markets[buyer.market].clock;
  const time=quote.history.at(-1)?.time ?? Date.parse(clock.date+'T00:00:00Z');
  world.trades.push({id:reference,symbol:buy.symbol,quantity,price,buyer:buyer.id,seller:seller.id,buySide:buy.side,sellSide:sell.side,day:clock.day,time,sequence:world.sequence});
}
export function marginRatio(world: World, accountState: Account): number {
  const shortLiability=Object.values(accountState.positions).reduce((sum,held)=>sum+held.shortQuantity*world.quotes[held.symbol].price,0);
  const liabilities=accountState.debt+shortLiability;
  return liabilities>0?(equity(world,accountState)+liabilities)/liabilities:Infinity;
}
