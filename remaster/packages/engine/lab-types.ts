export const LAB_VERSION = 'sgp-microstructure-1' as const;
export const LAB_POLICIES = ['baseline', 'lump', 'twap', 'vwap'] as const;
export type LabPolicy = typeof LAB_POLICIES[number];
export type LabSide = 'buy' | 'sell';
export type LabRole = 'maker' | 'noise' | 'informed' | 'parent';

export interface LabConfig {
  seed: number; ticks: number; quantity: number; side: LabSide;
  quoteSize: number; replenishEvery: number; informationDelay: number;
  informedCount: number; inventoryAversion: number; newsJumpBps: number;
}
export interface LabAccount {
  id: string; role: LabRole; cash: number; inventory: number;
  initialCash: number; initialInventory: number; targetInventory: number;
}
export interface LabLevel { price: number; quantity: number }
export interface LabBookView {
  bids: LabLevel[]; asks: LabLevel[]; bid: number|null; ask: number|null;
  bidSize: number; askSize: number; mid: number|null;
  spread: number|null; imbalance: number|null;
}
export interface LabTrade {
  id: string; tick: number; sequence: number; price: number; quantity: number;
  buyer: string; seller: string; buyerFee: number; sellerFee: number;
  aggressor: string; restingOrder: string;
}
export interface LabOrderEvent {
  kind: 'order'; sequence: number; tick: number; actor: string; id: string;
  side: LabSide; quantity: number; price?: number;
}
export type LabEvent = LabOrderEvent |
  {kind:'cancel';sequence:number;tick:number;actor:string;id:string} |
  {kind:'fundamental'|'public';sequence:number;tick:number;value:number} |
  {kind:'sample';sequence:number;tick:number};
export interface LabOrderResult {
  filled: number; unfilled: number; resting: number;
  trades: LabTrade[]; reason?: string;
}
export interface LabPoint {
  tick: number; mid: number; last: number; fundamental: number; publicValue: number;
  bid: number|null; ask: number|null; spread: number|null;
  bidDepth: number; askDepth: number; imbalance: number|null; ofi: number;
  volume: number; twoSided: boolean; makerInventory: number;
}
export interface LabMetrics {
  requested: number; filled: number; fillRatio: number; averagePrice: number|null;
  fees: number; arrivalPrice: number; terminalPrice: number;
  executionCostBps: number|null; opportunityCostBps: number;
  implementationShortfallBps: number; marketVwap: number|null;
  averageSpreadBps: number|null; averageDepth: number; illiquidTicks: number;
  ofiReturnCorrelation: number|null; absoluteReturnAutocorrelation: number|null;
  roleMarkouts: {role:LabRole;trades:number;fiveTickMarkoutBps:number|null}[];
}
export interface LabTape {
  version: typeof LAB_VERSION; policy: LabPolicy; config: LabConfig; events: LabEvent[];
}
export interface LabReport {
  version: typeof LAB_VERSION; policy: LabPolicy; config: LabConfig;
  tape: LabTape; trades: LabTrade[]; points: LabPoint[]; accounts: LabAccount[];
  feePool: number; metrics: LabMetrics; digest: string;
}
export interface LabComparison {
  policy: Exclude<LabPolicy,'baseline'>; peakImpactBps: number|null;
  terminalImpactBps: number|null; recoveryHalfLifeTicks: number|null;
}
export interface LabResult {
  version: typeof LAB_VERSION; config: LabConfig;
  reports: Record<LabPolicy,LabReport>; comparisons: LabComparison[];
}
export interface LabExport {
  version: typeof LAB_VERSION; config: LabConfig;
  tapes: Record<LabPolicy,LabTape>; digests: Record<LabPolicy,string>;
}
