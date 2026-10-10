import { Account, Candle, Instrument, MarketId, MarketState, Order, Position, Quote, Season, Trade, WorldEvent } from '../domain/types';
export interface AccountView extends Omit<Account,'positions'> {
  positions:(Position&{quantity:number;sellable:number;cost:number;pnl:number})[];available:number;reserved:number;equity:number;totalReturn:number;marginRatio:number|null;
  metrics:{maxDrawdown:number;sharpe:number;volatility:number;profitableDays:number;days:number;totalReturn:number};
}
export interface Rank {id:string;name:string;market:MarketId;actor:string;strategy?:string;equity:number;return:number;seasonPoints:number}
export interface Snapshot {
  protocolVersion:2;kind:'snapshot';worldVersion:number;sequence:number;mode:'sandbox'|'real';
  simulatedAt:Record<MarketId,MarketState['clock']>;instruments:Instrument[];markets:Record<MarketId,MarketState>;
  quotes:Record<string,Omit<Quote,'history'|'daily'|'pendingNews'|'volatilityState'>&{candle?:Candle;change:number}>;
  indices:{market:MarketId;value:number;change:number;advancing:number;count:number}[];
  accounts:Record<MarketId,AccountView|null>;orders:Order[];trades:Trade[];events:WorldEvent[];seasons:Season[];rankings:Rank[];
}
