import { Account, CommandResult, GameCommand, MARKETS, MarketId, RuleError, World } from '../domain/types';
import { exchange, integer } from '../domain/money';
import { LENGTH, phaseFor, realClock } from './calendar';
import { account, accountId, addAccount, emit, equity, id, INITIAL_CASH, longQuantity, postCash, system } from './world';
import { active, cancelOrder, cloneWorld, placeOrder, runAuction } from './matching';
import { evolveEconomy, openDay, recordCandles, settleDay } from './economy';
import { manageRisk, refreshLiquidity, runParticipants } from './participants';
import { reservedCash } from './settlement';
export interface Transition { world: World; result: CommandResult }
export function transition(previous: World, command: GameCommand, commandId: string): Transition {
  const world=cloneWorld(previous);world.version++;world.sequence++;
  const data=apply(world,command,commandId);
  for(const held of Object.values(world.accounts).filter(item=>item.actor==='player')){
    if(Object.values(held.positions).filter(position=>longQuantity(position)||position.shortQuantity).length>=5&&!held.achievements.includes('diversified'))held.achievements.push('diversified');
    if(MARKETS.every(market=>world.accounts[accountId(held.owner,market)]?.achievements.includes('first-trade'))&&!held.achievements.includes('global-trader'))held.achievements.push('global-trader');
  }
  assertWorld(world);compact(world);
  return {world,result:{success:true,version:world.version,...data}};
}
function apply(world: World, command: GameCommand, commandId: string): Partial<CommandResult> {
  switch(command.kind) {
    case 'create-player': {
      if(!/^[\w:@.-]{1,120}$/.test(command.owner)||typeof command.name!=='string'||command.name.length<1||command.name.length>50) throw new RuleError('INVALID_IDENTITY','玩家身份无效');
      for(const market of MARKETS) if(!world.accounts[accountId(command.owner,market)]) addAccount(world,command.owner,command.name,market,'player',INITIAL_CASH);
      return {data:MARKETS.map(market=>account(world,command.owner,market).id)};
    }
    case 'order': return {order:placeOrder(world,command.owner,command.market,command.input,commandId)};
    case 'cancel': return {order:cancelOrder(world,command.owner,command.orderId)};
    case 'transfer': return {data:transfer(world,command)};
    case 'fund': return {data:fund(world,command)};
    case 'repay': {
      const held=account(world,command.owner,command.market);integer(command.amount,'还款金额',1,held.debt);
      if(held.cash-reservedCash(world,held)<command.amount)throw new RuleError('INSUFFICIENT_CASH','可用还款资金不足');
      postCash(world,held,system(world,command.market,'bank'),command.amount,'manual-repayment',id(world,'repay'));held.debt-=command.amount;
      let remaining=command.amount;for(const position of Object.values(held.positions))for(const lot of position.lots){const paid=Math.min(remaining,lot.debt);lot.debt-=paid;remaining-=paid;}
      return {data:{debt:held.debt}};
    }
    case 'leverage': {
      const held=account(world,command.owner,command.market);integer(command.leverage,'杠杆',1,3);
      if(held.debt>0||Object.values(held.positions).some(position=>longQuantity(position)>0||position.shortQuantity>0)||Object.values(world.orders).some(order=>order.accountId===held.id&&active(order))) throw new RuleError('EXPOSURE_EXISTS','持仓与挂单清空后才能调整杠杆');
      held.leverage=command.leverage;return {data:held.leverage};
    }
    case 'reset': return {data:reset(world,command.owner,command.market)};
    case 'season': return {data:joinSeason(world,command.owner,command.market,command.type)};
    case 'tick': tick(world,command);return {};
  }
}
function inSeason(world: World, accountState: Account): boolean { return world.seasons.some(season=>!season.finished&&season.entrants[accountState.id]); }
function transfer(world: World, command: Extract<GameCommand,{kind:'transfer'}>): unknown {
  if(command.from===command.to) throw new RuleError('SAME_MARKET','划转需要两个不同市场');integer(command.amount,'划转金额',1,INITIAL_CASH*10);
  const source=account(world,command.owner,command.from);const target=account(world,command.owner,command.to);
  if(inSeason(world,source)||inSeason(world,target)) throw new RuleError('SEASON_LOCKED','赛事期间不可跨市场划转');
  if(source.cash-reservedCash(world,source)<command.amount) throw new RuleError('INSUFFICIENT_CASH','可划转资金不足');
  const conversion=exchange(command.amount,command.from,command.to);if(conversion.received<1) throw new RuleError('TRANSFER_TOO_SMALL','扣除费用后到账金额为零');
  const reference=id(world,'fx');postCash(world,source,system(world,command.from,'fx'),command.amount-conversion.fee,'fx-out',reference);
  postCash(world,source,system(world,command.from,'fees'),conversion.fee,'fx-fee',reference);postCash(world,system(world,command.to,'fx'),target,conversion.received,'fx-in',reference);
  return conversion;
}
function fund(world: World, command: Extract<GameCommand,{kind:'fund'}>): unknown {
  if(!['money','etf'].includes(command.fund)||!['buy','sell'].includes(command.action)) throw new RuleError('INVALID_FUND','基金或方向无效');
  const held=account(world,command.owner,command.market);integer(command.amount,'金额/份额',1,INITIAL_CASH*100);
  const nav=world.markets[command.market].fundNav[command.fund];const reserve=system(world,command.market,'fund');const reference=id(world,'fund');
  if(command.action==='buy') {
    if(held.cash-reservedCash(world,held)<command.amount) throw new RuleError('INSUFFICIENT_CASH','申购资金不足');
    const fee=command.fund==='etf'?Math.ceil(command.amount*0.001):0;const units=Math.floor((command.amount-fee)*10000/nav);
    if(units<1) throw new RuleError('FUND_TOO_SMALL','金额不足以购买最小份额');
    const cost=Math.ceil(units*nav/10000);postCash(world,held,reserve,cost,'fund-buy',reference);postCash(world,held,system(world,command.market,'fees'),fee,'fund-fee',reference);held.funds[command.fund]+=units;
  } else {
    if(held.funds[command.fund]<command.amount) throw new RuleError('INSUFFICIENT_FUND','基金份额不足');
    const payout=Math.floor(command.amount*nav/10000);const fee=command.fund==='etf'?Math.ceil(payout*0.001):0;
    if(reserve.cash<payout) postCash(world,system(world,command.market),reserve,payout-reserve.cash,'fund-return-funding',reference);
    postCash(world,reserve,held,payout-fee,'fund-sell',reference);postCash(world,reserve,system(world,command.market,'fees'),fee,'fund-fee',reference);held.funds[command.fund]-=command.amount;
  }
  return {units:held.funds[command.fund],nav};
}
function reset(world: World, owner: string, market: MarketId): unknown {
  const held=account(world,owner,market);
  if(inSeason(world,held)||held.debt||held.collateral||held.funds.money||held.funds.etf||Object.values(held.positions).some(position=>longQuantity(position)||position.shortQuantity)||Object.values(world.orders).some(order=>order.accountId===held.id&&active(order))) throw new RuleError('RESET_BLOCKED','清空持仓、基金、挂单和负债，并退出赛事后才能重置');
  const treasury=system(world,market);const difference=INITIAL_CASH-held.cash;const reference=id(world,'reset');
  if(difference>0) postCash(world,treasury,held,difference,'reset-issue',reference);else if(difference<0) postCash(world,held,treasury,-difference,'reset-retire',reference);
  held.initialEquity=INITIAL_CASH;held.lastEquity=INITIAL_CASH;held.equityHistory=[];held.positions={};return {cash:held.cash};
}
function joinSeason(world: World, owner: string, market: MarketId, type: 'week'|'fortnight'|'month'): unknown {
  if(!['week','fortnight','month'].includes(type)) throw new RuleError('INVALID_SEASON','赛事类型无效');const held=account(world,owner,market);
  let season=world.seasons.find(item=>item.market===market&&item.type===type&&!item.finished);
  if(!season) {const day=world.markets[market].clock.day;season={id:id(world,'season'),market,type,startDay:day,endDay:day+({week:5,fortnight:10,month:20}[type])-1,entrants:{},finished:false};world.seasons.push(season);}
  if(season.entrants[held.id]) return season;
  const startingEquity=equity(world,held);if(startingEquity<=0) throw new RuleError('INSUFFICIENT_EQUITY','净值必须为正才能报名');season.entrants[held.id]={initial:startingEquity};
  for(const actor of Object.values(world.accounts).filter(item=>item.actor==='ai'&&item.market===market)) season.entrants[actor.id]??={initial:equity(world,actor)};
  return season;
}
function tick(world: World, command: Extract<GameCommand,{kind:'tick'}>): void {
  for(const market of command.market?[command.market]:MARKETS) {
    const state=world.markets[market];
    if(world.mode==='real') {
      if(!command.realAt) throw new RuleError('REAL_TIME_REQUIRED','真实档需要明确时间');const resolved=realClock(market,new Date(command.realAt));
      if(resolved.key===state.clock.lastRealMinute) continue;
      state.clock.lastRealMinute=resolved.key;
      if(state.clock.date<resolved.date&&resolved.phase!=='closed') {settleDay(world,market);let guard=0;while(state.clock.date<resolved.date&&guard++<370) openDay(world,market);}
      state.clock.minute=resolved.minute;state.clock.phase=resolved.phase;
      if(resolved.phase==='closed') {if(resolved.date===state.clock.date&&resolved.minute>=LENGTH[market]) settleDay(world,market);continue;}
    } else state.clock.phase=phaseFor(market,state.clock.minute);
    if(state.clock.minute===-5&&market==='CN') for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) runAuction(world,instrument.symbol);
    if(state.clock.phase==='continuous') {
      const volumes=Object.fromEntries(Object.values(world.instruments).filter(item=>item.market===market).map(item=>[item.symbol,world.quotes[item.symbol].volume]));
      evolveEconomy(world,market);refreshLiquidity(world,market);runParticipants(world,market);manageRisk(world,market);recordCandles(world,market,volumes);
    }
    if(state.clock.minute===LENGTH[market]) settleDay(world,market);
    if(world.mode==='sandbox') {
      state.clock.minute++;
      if(state.clock.minute>=LENGTH[market]+(market==='CN'?30:1)) openDay(world,market);
      state.clock.phase=phaseFor(market,state.clock.minute);
    }
  }
}
export function assertWorld(world: World): void {
  for(const accountState of Object.values(world.accounts)) {
    for(const value of [accountState.cash,accountState.debt,accountState.collateral,accountState.funds.money,accountState.funds.etf]) if(!Number.isSafeInteger(value)) throw new Error('World invariant: non-integer asset');
    if(accountState.actor!=='system'&&(accountState.cash<0||accountState.debt<0||accountState.collateral<0)) throw new Error('World invariant: negative asset');
    const collateral=Object.values(accountState.positions).reduce((sum,held)=>sum+held.collateral,0);
    if(collateral!==accountState.collateral) throw new Error('World invariant: short collateral mismatch');
    for(const held of Object.values(accountState.positions)) if(held.shortQuantity<0||held.lots.some(lot=>lot.quantity<=0||lot.debt<0)) throw new Error('World invariant: invalid position');
  }
  const ledgerBalance:Record<string,number>={};for(const entry of world.ledger) ledgerBalance[entry.currency]=(ledgerBalance[entry.currency]??0)+entry.amount;
  if(Object.values(ledgerBalance).some(amount=>amount!==0)) throw new Error('World invariant: unbalanced cash ledger');
}
function compact(world: World): void {
  const closed=Object.values(world.orders).filter(order=>!active(order)&&world.accounts[order.accountId].actor!=='player').sort((left,right)=>right.sequence-left.sequence);
  for(const order of closed.slice(1000)) delete world.orders[order.id];
  if(world.trades.length>3000) world.trades=world.trades.slice(-3000);
  if(world.events.length>300) world.events=world.events.slice(-300);
  // Cash postings are always stored in pairs; retain a complete suffix.
  if(world.ledger.length>4000) {
    let boundary=world.ledger.length-4000;while(boundary>0&&world.ledger[boundary-1].reference===world.ledger[boundary].reference) boundary--;
    world.ledger=world.ledger.slice(boundary);
  }
}
