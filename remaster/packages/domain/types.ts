export const MARKETS = ['CN', 'HK', 'US'] as const;
export type MarketId = typeof MARKETS[number];
export type Side = 'buy' | 'sell' | 'short' | 'cover';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop-limit' | 'fok' | 'ioc' | 'iceberg';
export type OrderStatus = 'pending' | 'partial' | 'filled' | 'cancelled' | 'rejected';
export type Phase = 'auction-open' | 'auction-locked' | 'pre-open' | 'continuous' | 'post-close' | 'closed';
export interface Instrument {
  symbol: string; code: string; name: string; industry: string; market: MarketId;
  listedAt: string; description: string; initialPrice: number; volatility: number;
}
export interface Candle { time: number; day: number; open: number; high: number; low: number; close: number; volume: number }
export interface Quote {
  symbol: string; price: number; previousClose: number; fairValue: number; open: number; high: number; low: number;
  volume: number; turnover: number; momentum: number; bubble: number; earningsGrowth: number; pe: number;
  dividendFactor: number; history: Candle[]; daily: Candle[];
}
export interface MarketClock { day: number; date: string; minute: number; phase: Phase; settledDay: number; lastRealMinute: string }
export interface MarketState {
  clock: MarketClock; sentiment: number; rate: number; inflation: number; growth: number;
  sectors: Record<string, { cycle: number; trend: number; heat: number }>; lastNavDay: number;
  fundNav: { money: number; etf: number; basket: number; dividend: number };
}
export interface Lot { quantity: number; cost: number; boughtDay: number; debt: number }
export interface Position { symbol: string; lots: Lot[]; shortQuantity: number; shortProceeds: number; collateral: number }
export interface Account {
  id: string; owner: string; name: string; market: MarketId; actor: 'player' | 'ai' | 'maker' | 'system';
  cash: number; debt: number; collateral: number; leverage: number; initialEquity: number;
  positions: Record<string, Position>; funds: { money: number; etf: number }; achievements: string[];
  equityHistory: { day: number; equity: number }[]; seasonPoints: number; strategy?: string;
  adaptation: number; lastEquity: number;
}
export interface Order {
  id: string; commandId: string; accountId: string; symbol: string; side: Side; type: OrderType;
  quantity: number; remaining: number; filled: number; averagePrice: number; price?: number; triggerPrice?: number;
  displayQuantity?: number; visible: number; sequence: number; createdDay: number; status: OrderStatus;
  triggered: boolean; postClose: boolean; error?: string;
}
export interface Trade { id: string; symbol: string; quantity: number; price: number; buyer: string; seller: string; buySide: Side; sellSide: Side; day: number; time: number; sequence: number }
export interface LedgerEntry { id: string; reference: string; accountId: string; counterparty: string; amount: number; currency: MarketId; kind: string; day: number }
export interface WorldEvent { id: string; sequence: number; market: MarketId; day: number; kind: string; title: string; detail: string; symbol?: string; impact: number; time: number }
export interface Season { id: string; type: 'week' | 'fortnight' | 'month'; market: MarketId; startDay: number; endDay: number; entrants: Record<string, { initial: number; final?: number }>; finished: boolean }
export interface World {
  schemaVersion: 2; version: number; sequence: number; seed: number; random: Record<string, number>;
  mode: 'sandbox' | 'real'; instruments: Record<string, Instrument>; quotes: Record<string, Quote>;
  markets: Record<MarketId, MarketState>; accounts: Record<string, Account>; orders: Record<string, Order>;
  trades: Trade[]; ledger: LedgerEntry[]; events: WorldEvent[]; seasons: Season[]; nextId: number;
}
export interface OrderInput {
  symbol: string; side: Side; type: OrderType; quantity: number; price?: number; triggerPrice?: number; displayQuantity?: number;
}
export type GameCommand =
  | { kind: 'create-player'; owner: string; name: string }
  | { kind: 'order'; owner: string; market: MarketId; input: OrderInput }
  | { kind: 'cancel'; owner: string; orderId: string }
  | { kind: 'transfer'; owner: string; from: MarketId; to: MarketId; amount: number }
  | { kind: 'leverage'; owner: string; market: MarketId; leverage: number }
  | { kind: 'fund'; owner: string; market: MarketId; fund: 'money' | 'etf'; action: 'buy' | 'sell'; amount: number }
  | { kind: 'reset'; owner: string; market: MarketId }
  | { kind: 'season'; owner: string; market: MarketId; type: Season['type'] }
  | { kind: 'tick'; market?: MarketId; realAt?: string };
export interface CommandResult { success: boolean; error?: string; code?: string; order?: Order; data?: unknown; version: number }
export class RuleError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'RuleError'; } }
