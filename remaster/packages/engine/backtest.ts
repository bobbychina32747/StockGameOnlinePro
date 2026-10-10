import { Candle, RuleError } from '../domain/types';
import { createWorld, account, addAccount, equity, longQuantity } from './world';
import { refreshLiquidity } from './participants';
import { placeOrder } from './matching';
import { performance } from './analytics';
export function backtest(symbol: string, bars: Candle[], strategy: string, seed: number): unknown {
  if(!['ma','rsi','momentum'].includes(strategy)) throw new RuleError('INVALID_STRATEGY','回测策略必须为 MA、RSI 或动量');
  const world=createWorld(seed);const instrument=world.instruments[symbol];if(!instrument) throw new RuleError('INVALID_SYMBOL','回测标的不存在');
  world.instruments={[symbol]:instrument};world.quotes={[symbol]:world.quotes[symbol]};world.orders={};world.trades=[];world.ledger=[];
  for(const actor of Object.values(world.accounts)) {actor.positions=Object.fromEntries(Object.entries(actor.positions).filter(([heldSymbol])=>heldSymbol===symbol));}
  const player=addAccount(world,'backtest','回测账户',instrument.market,'player',100_000_000);
  const series:{day:number;equity:number}[]=[];const closes:number[]=[];let firstPrice=0;
  for(const [index,bar] of bars.slice(-500).entries()) {
    const clock=world.markets[instrument.market].clock;clock.day=index+1;clock.phase='continuous';clock.minute=0;clock.date=new Date(bar.time).toISOString().slice(0,10);
    const quote=world.quotes[symbol];quote.price=bar.open;quote.previousClose=closes.at(-1)??bar.open;
    refreshLiquidity(world,instrument.market);const signal=decision(closes,strategy);const current=account(world,'backtest',instrument.market);const held=current.positions[symbol];const quantity=held?longQuantity(held):0;
    const buySize=Math.min(100000,Math.floor(current.cash*0.9/Math.max(1,bar.open)));
    try {
      if(signal>0&&quantity===0&&buySize>0) placeOrder(world,'backtest',instrument.market,{symbol,side:'buy',type:'market',quantity:buySize},`backtest-buy-${index}`);
      if(signal<0&&quantity>0) placeOrder(world,'backtest',instrument.market,{symbol,side:'sell',type:'market',quantity},`backtest-sell-${index}`);
    } catch(error) {if(!(error instanceof RuleError)) throw error;}
    world.quotes[symbol].price=bar.close;closes.push(bar.close);firstPrice ||=bar.open;series.push({day:index,equity:equity(world,account(world,'backtest',instrument.market))});
  }
  return {strategy,symbol,metrics:performance(series,player.initialEquity),benchmark:closes.length?closes.at(-1)!/firstPrice-1:0,curve:series,trades:world.trades.filter(trade=>trade.buyer===player.id||trade.seller===player.id),bars:bars.length,execution:'same matching, market fees, depth and T+1; signal uses prior closes, execution at next open'};
}
function decision(closes: number[], strategy: string): number {
  if(closes.length<30) return 0;
  const mean=(period:number)=>closes.slice(-period).reduce((sum,value)=>sum+value,0)/period;
  if(strategy==='ma') return mean(10)>mean(30)?1:-1;
  if(strategy==='momentum') return closes.at(-1)!/closes.at(-20)!>1.02?1:closes.at(-1)!/closes.at(-20)!<.98?-1:0;
  const changes=closes.slice(-15).slice(1).map((value,index)=>value-closes.slice(-15)[index]);const gain=changes.reduce((sum,value)=>sum+Math.max(0,value),0);const loss=changes.reduce((sum,value)=>sum+Math.max(0,-value),0);const rsi=loss===0?100:100-100/(1+gain/loss);
  return rsi<30?1:rsi>70?-1:0;
}
