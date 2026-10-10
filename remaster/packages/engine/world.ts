import catalog from '../domain/catalog.json';
import { Account, Instrument, MARKETS, MarketId, Position, RuleError, World } from '../domain/types';
import { safeAdd } from '../domain/money';
import { candleTime, nextTradingDate, tradingDate } from './calendar';
import { normal } from './random';
import { baselineHistory } from './history';
export const INITIAL_CASH = 100_000_000;
export function id(world: World, prefix: string): string { return `${prefix}-${++world.nextId}`; }
export function accountId(owner: string, market: MarketId): string { return `${owner}:${market}`; }
export function account(world: World, owner: string, market: MarketId): Account {
  const result = world.accounts[accountId(owner,market)];
  if (!result || result.actor!=='player') throw new RuleError('ACCOUNT_NOT_FOUND','游戏账户不存在');
  return result;
}
export function position(accountState: Account, symbol: string): Position {
  return accountState.positions[symbol] ??= {symbol,lots:[],shortQuantity:0,shortProceeds:0,collateral:0};
}
export function longQuantity(positionState: Position): number { return positionState.lots.reduce((sum,lot)=>sum+lot.quantity,0); }
export function sellable(world: World, accountState: Account, symbol: string): number {
  const held = accountState.positions[symbol];
  if (!held) return 0;
  const day = world.markets[accountState.market].clock.day;
  return held.lots.reduce((sum,lot)=>sum+(accountState.market!=='CN' || accountState.actor==='maker' || lot.boughtDay<day?lot.quantity:0),0);
}
export function equity(world: World, accountState: Account): number {
  let value = accountState.cash + accountState.collateral - accountState.debt;
  for (const held of Object.values(accountState.positions)) {
    const price = world.quotes[held.symbol]?.price ?? 0;
    value += (longQuantity(held)-held.shortQuantity)*price;
  }
  const nav = world.markets[accountState.market].fundNav;
  return Math.round(value + accountState.funds.money*nav.money/10000 + accountState.funds.etf*nav.etf/10000);
}
export function postCash(world: World, source: Account, target: Account, amount: number, kind: string, reference: string): void {
  if (!Number.isSafeInteger(amount) || amount<0 || source.market!==target.market) throw new RuleError('INVALID_LEDGER','账本金额或币种无效');
  source.cash = safeAdd(source.cash,-amount); target.cash=safeAdd(target.cash,amount);
  const day = world.markets[source.market].clock.day;
  world.ledger.push({id:id(world,'ledger'),reference,accountId:source.id,counterparty:target.id,amount:-amount,currency:source.market,kind,day});
  world.ledger.push({id:id(world,'ledger'),reference,accountId:target.id,counterparty:source.id,amount,currency:source.market,kind,day});
}
export function system(world: World, market: MarketId, purpose='treasury'): Account { return world.accounts[`system-${purpose}:${market}`]; }
export function addAccount(world: World, owner: string, name: string, market: MarketId, actor: Account['actor'], cash: number, strategy?: string): Account {
  const created: Account = {id:accountId(owner,market),owner,name,market,actor,cash:0,debt:0,collateral:0,leverage:1,initialEquity:cash,positions:{},funds:{money:0,etf:0},achievements:[],equityHistory:[],seasonPoints:0,strategy,adaptation:1,lastEquity:cash};
  world.accounts[created.id]=created;
  if (cash>0) postCash(world,system(world,market),created,cash,'initial-capital',id(world,'issue'));
  return created;
}
export function emit(world: World, market: MarketId, kind: string, title: string, detail: string, impact=0, symbol?: string): void {
  world.events.push({id:id(world,'event'),sequence:world.sequence,market,day:world.markets[market].clock.day,kind,title,detail,impact,symbol,time:candleTime(market,world.markets[market].clock)});
}
export function createWorld(seed=20261010, mode: World['mode']='sandbox'): World {
  const world: World={schemaVersion:2,version:0,sequence:0,seed,random:{},mode,instruments:{},quotes:{},markets:{} as World['markets'],accounts:{},orders:{},trades:[],ledger:[],events:[],seasons:[],nextId:0};
  for (const market of MARKETS) {
    const date = tradingDate(market,'2026-10-08')?'2026-10-08':nextTradingDate(market,'2026-10-07');
    world.markets[market]={clock:{day:1,date,minute:0,phase:'continuous',settledDay:0,lastRealMinute:''},sentiment:0,rate:0.025,inflation:0.02,growth:0.03,sectors:{},lastNavDay:0,fundNav:{money:10000,etf:10000,basket:0,dividend:0}};
    for(const purpose of ['treasury','fees','bank','fx','fund','issuer']) addAccount(world,`system-${purpose}`,purpose,market,'system',0);
  }
  for (const item of catalog.instruments) {
    const instrument = item as Instrument; world.instruments[item.symbol]=instrument;
    const price=item.initialPrice;
    world.quotes[item.symbol]={symbol:item.symbol,price,previousClose:price,fairValue:price,open:price,high:price,low:price,volume:0,turnover:0,momentum:0,bubble:0,earningsGrowth:0.06,pe:20,dividendFactor:1,history:[],daily:[]};
    world.markets[instrument.market].sectors[item.industry]??={cycle:0,trend:0,heat:0};
  }
  for(const market of MARKETS) {
    const maker=addAccount(world,`maker-${market}`,'流动性做市商',market,'maker',50_000_000_000,'maker');
    for(const instrument of Object.values(world.instruments).filter(item=>item.market===market)) position(maker,instrument.symbol).lots.push({quantity:100000,cost:instrument.initialPrice,boughtDay:0,debt:0});
    const strategies=['trend','value','momentum','herd','contrarian','noise','noise','value','trend','noise'];
    const names=['算法一号','低波猎手','动量刺客','龙虎老哥','反向大师','散户老王','散户小张','阿珍','老李','小美'];
    strategies.forEach((strategy,index)=>addAccount(world,`ai-${index}-${market}`,names[index],market,'ai',INITIAL_CASH,strategy));
    world.markets[market].fundNav.basket=basketValue(world,market);
  }
  initializeHistory(world);
  for(const market of MARKETS) emit(world,market,'welcome','交易所已开市','所有交易均为模拟；市场、AI、账本与订单来自同一版本。');
  return world;
}
export function basketValue(world: World, market: MarketId): number {
  const instruments=Object.values(world.instruments).filter(item=>item.market===market);
  return instruments.reduce((sum,item)=>sum+world.quotes[item.symbol].price/item.initialPrice,0)/instruments.length;
}
function initializeHistory(world: World): void {
  for(const instrument of Object.values(world.instruments)) {
    const quote=world.quotes[instrument.symbol];
    const recent=new Date(Date.parse(world.markets[instrument.market].clock.date+'T00:00:00Z')-300*86400000).toISOString().slice(0,10);
    quote.daily=baselineHistory(instrument,world.seed,world.markets[instrument.market].clock.date,recent);
  }
}
