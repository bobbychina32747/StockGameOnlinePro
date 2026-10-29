import { FiniteOrderBook } from './lab-book';
import { calculateLabMetrics, compareLabReports, eventOFI } from './lab-metrics';
import {
  LAB_POLICIES, LAB_VERSION, LabAccount, LabConfig, LabEvent, LabExport,
  LabPolicy, LabPoint, LabReport, LabResult, LabSide, LabTape,
} from './lab-types';

export { LAB_VERSION, LAB_POLICIES } from './lab-types';
export const LAB_DEFAULTS: Readonly<LabConfig> = Object.freeze({
  seed: 20261029, ticks: 180, quantity: 3000, side: 'buy', quoteSize: 80,
  replenishEvery: 5, informationDelay: 20, informedCount: 2,
  inventoryAversion: 2, newsJumpBps: 100,
});
export const LAB_MAX_EVENTS = 20000;
const INITIAL_PRICE = 10000;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function integer(value: unknown, low: number, high: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high)
    throw new Error(`LAB_RANGE:${name}`);
  return value;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('LAB_FIELDS');
}
export function normalizeLabConfig(input: unknown = {}): LabConfig {
  if (!object(input)) throw new Error('LAB_CONFIG');
  exactKeys(input, Object.keys(LAB_DEFAULTS));
  const c = { ...LAB_DEFAULTS, ...input };
  if (c.side !== 'buy' && c.side !== 'sell') throw new Error('LAB_RANGE:side');
  return {
    seed: integer(c.seed, 0, 0xffffffff, 'seed'), ticks: integer(c.ticks, 60, 300, 'ticks'),
    quantity: integer(c.quantity, 1, 20000, 'quantity'), side: c.side,
    quoteSize: integer(c.quoteSize, 10, 400, 'quoteSize'),
    replenishEvery: integer(c.replenishEvery, 3, 30, 'replenishEvery'),
    informationDelay: integer(c.informationDelay, 1, 60, 'informationDelay'),
    informedCount: integer(c.informedCount, 0, 4, 'informedCount'),
    inventoryAversion: integer(c.inventoryAversion, 0, 10, 'inventoryAversion'),
    newsJumpBps: integer(c.newsJumpBps, -300, 300, 'newsJumpBps'),
  };
}

// Separate counter streams keep exogenous draws identical across execution policies.
// Integer arithmetic also makes browser and Node replay independent of libm/RNG state.
function draw(seed: number, stream: number, tick: number, actor = 0, slot = 0): number {
  let n = seed ^ Math.imul(stream + 1, 0x9e3779b9) ^ Math.imul(tick + 1, 0x85ebca6b)
    ^ Math.imul(actor + 1, 0xc2b2ae35) ^ Math.imul(slot + 1, 0x27d4eb2f);
  n = Math.imul(n ^ (n >>> 16), 0x7feb352d);
  n = Math.imul(n ^ (n >>> 15), 0x846ca68b);
  return (n ^ (n >>> 16)) >>> 0;
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export function createLabAccounts(config: LabConfig): LabAccount[] {
  const accounts: LabAccount[] = [];
  const add = (id: string, role: LabAccount['role'], cash: number, inventory: number) =>
    accounts.push({ id, role, cash, inventory, initialCash: cash, initialInventory: inventory, targetInventory: inventory });
  for (let i = 0; i < 3; i++) add(`maker-${i}`, 'maker', 150000000, 4000);
  for (let i = 0; i < 6; i++) add(`noise-${i}`, 'noise', 40000000, 1500);
  for (let i = 0; i < config.informedCount; i++) add(`informed-${i}`, 'informed', 50000000, 2000);
  add('parent', 'parent', 300000000, config.side === 'sell' ? config.quantity : 0);
  return accounts;
}

class Experiment {
  readonly book: FiniteOrderBook;
  readonly events: LabEvent[] = [];
  readonly points: LabPoint[] = [];
  fundamental = INITIAL_PRICE;
  publicValue = INITIAL_PRICE;
  private flow = 0;
  private sampledTrades = 0;
  private lastMid = INITIAL_PRICE;
  constructor(readonly config: LabConfig, readonly policy: LabPolicy) {
    this.book = new FiniteOrderBook(createLabAccounts(config), 5,
      (before, after) => { this.flow += eventOFI(before, after); });
  }
  apply(event: LabEvent): void {
    this.events.push(event);
    if (event.kind === 'fundamental') this.fundamental = event.value;
    else if (event.kind === 'public') this.publicValue = event.value;
    else if (event.kind === 'sample') {
      const view = this.book.snapshot(1000);
      const trades = this.book.getTrades();
      const newTrades = trades.slice(this.sampledTrades);
      const last = trades.length ? trades[trades.length - 1].price : INITIAL_PRICE;
      if (view.mid !== null) this.lastMid = view.mid;
      this.points.push({
        tick: event.tick, mid: this.lastMid, last, fundamental: this.fundamental, publicValue: this.publicValue,
        bid: view.bid, ask: view.ask, spread: view.spread,
        bidDepth: view.bids.reduce((sum, level) => sum + level.quantity, 0),
        askDepth: view.asks.reduce((sum, level) => sum + level.quantity, 0),
        imbalance: view.imbalance, ofi: this.flow,
        volume: newTrades.reduce((sum, trade) => sum + trade.quantity, 0),
        twoSided: view.mid !== null,
        makerInventory: this.book.getAccounts().filter(a => a.role === 'maker')
          .reduce((sum, a) => sum + a.inventory - a.targetInventory, 0),
      });
      this.flow = 0;
      this.sampledTrades = trades.length;
    } else {
      if (event.kind === 'cancel') this.book.cancel(event.actor, event.id);
      else if (event.kind === 'order') this.book.submit(event);
    }
  }
  order(tick: number, actor: string, side: LabSide, quantity: number, price?: number): void {
    const sequence = this.events.length;
    this.apply({ kind: 'order', sequence, tick, actor, id: `${actor}-${sequence}`, side, quantity, ...(price === undefined ? {} : { price }) });
  }
  cancelOld(tick: number, actor: string, age: number): void {
    for (const order of this.book.getOrders(actor)) if (tick - order.tick >= age)
      this.apply({ kind: 'cancel', sequence: this.events.length, tick, actor, id: order.id });
  }
  value(tick: number, kind: 'fundamental' | 'public', value: number): void {
    this.apply({ kind, sequence: this.events.length, tick, value });
  }
  async report(): Promise<LabReport> {
    const trades = this.book.getTrades(), accounts = this.book.getAccounts();
    const tape: LabTape = { version: LAB_VERSION, policy: this.policy, config: this.config, events: this.events };
    const body = {
      version: LAB_VERSION, policy: this.policy, config: this.config, tape, trades,
      points: this.points, accounts, feePool: this.book.getFeePool(),
      metrics: calculateLabMetrics(this.config, this.policy, this.points, trades, accounts),
    };
    return { ...body, digest: await hash(body) };
  }
}

interface PublicObservation {
  publicValue: number; mid: number; inventory: number; target: number;
}
// This decision function cannot read the current private value or future news.
function makerCenter(observation: PublicObservation, aversion: number): number {
  const skew = clamp(Math.trunc((observation.inventory - observation.target) * aversion / 100), -100, 100);
  return clamp(Math.round((4 * observation.publicValue + observation.mid) / 5) - skew, 5000, 15000);
}
function replenish(world: Experiment, tick: number, i: number): void {
  const c = world.config, actor = `maker-${i}`;
  if (tick !== 0 && tick % c.replenishEvery !== i % c.replenishEvery) return;
  world.cancelOld(tick, actor, 0);
  const account = world.book.getAccounts().find(a => a.id === actor)!;
  const view = world.book.snapshot();
  const center = makerCenter({ publicValue: world.publicValue, mid: view.mid ?? world.publicValue,
    inventory: account.inventory, target: account.targetInventory }, c.inventoryAversion);
  const lastPublic = world.points.length ? world.points[world.points.length - 1].publicValue : INITIAL_PRICE;
  const width = 12 + Math.min(30, Math.abs(world.publicValue - lastPublic))
    + draw(c.seed, 2, tick, i) % 8;
  for (let level = 0; level < 3; level++) {
    const distance = width + level * 18 + i * 2;
    const size = c.quoteSize + Math.floor(c.quoteSize * level / 3);
    world.order(tick, actor, 'buy', size, center - distance);
    world.order(tick, actor, 'sell', size, center + distance);
  }
}
function noiseDecision(observation: PublicObservation, coin: number, sizeDraw: number): {side:LabSide;quantity:number} {
  const difference = observation.publicValue - observation.mid;
  const side = Math.abs(difference) > 12 && coin % 100 < 75
    ? (difference > 0 ? 'buy' : 'sell') : (coin % 2 === 0 ? 'buy' : 'sell');
  return { side, quantity: 10 + sizeDraw % 76 };
}
function tradeNoise(world: Experiment, tick: number, i: number): void {
  const c = world.config, actor = `noise-${i}`;
  world.cancelOld(tick, actor, 12);
  const coin = draw(c.seed, 3, tick, i);
  if (coin % 100 >= 50) return;
  const a = world.book.getAccounts().find(item => item.id === actor)!;
  const view = world.book.snapshot(), mid = view.mid ?? world.publicValue;
  const action = noiseDecision({ publicValue: world.publicValue, mid, inventory: a.inventory, target: a.targetInventory },
    draw(c.seed, 4, tick, i), draw(c.seed, 5, tick, i));
  const limit = draw(c.seed, 6, tick, i) % 100 >= 65;
  const distance = 8 + draw(c.seed, 7, tick, i) % 33;
  const price = limit ? clamp(Math.round(mid) + (action.side === 'buy' ? -distance : distance), 100, 10000000) : undefined;
  world.order(tick, actor, action.side, action.quantity, price);
}
function tradeInformed(world: Experiment, tick: number, i: number): void {
  if (draw(world.config.seed, 8, tick, i) % 100 >= 45) return;
  const view = world.book.snapshot();
  // Private information is used to submit orders; it never directly overwrites a quote/trade.
  const edgeBuy = view.ask === null ? 0 : world.fundamental - view.ask;
  const edgeSell = view.bid === null ? 0 : view.bid - world.fundamental;
  const side = edgeBuy > 12 ? 'buy' : edgeSell > 12 ? 'sell' : null;
  if (side) world.order(tick, `informed-${i}`, side, 20 + draw(world.config.seed, 9, tick, i) % 61);
}

export function executionWindow(config: LabConfig): {start:number;end:number} {
  return { start: Math.floor(config.ticks * .2), end: Math.floor(config.ticks * .7) };
}
export function plannedSlices(config: LabConfig, policy: LabPolicy): Map<number, number> {
  const { start, end } = executionWindow(config), slices = new Map<number, number>();
  if (policy === 'baseline') return slices;
  if (policy === 'lump') return new Map([[start, config.quantity]]);
  const count = 15;
  // Ex-ante U-shaped expected-volume curve. No future realized volume is consulted.
  const weights = Array.from({ length: count }, (_, i) => policy === 'twap' ? 1 : 4 + Math.abs(2 * i - count + 1));
  const total = weights.reduce((sum, n) => sum + n, 0);
  let cumulative = 0, assigned = 0;
  for (let i = 0; i < count; i++) {
    cumulative += weights[i];
    const target = Math.floor(config.quantity * cumulative / total);
    const tick = start + Math.floor(i * (end - start) / count);
    if (target > assigned) slices.set(tick, target - assigned);
    assigned = target;
  }
  return slices;
}
async function generate(config: LabConfig, policy: LabPolicy): Promise<LabReport> {
  const world = new Experiment(config, policy), values: number[] = [], slices = plannedSlices(config, policy);
  let value = INITIAL_PRICE;
  for (let tick = 0; tick < config.ticks; tick++) {
    value += (draw(config.seed, 1, tick) % 7) - 3;
    if (tick === Math.floor(config.ticks * .4)) value += Math.round(value * config.newsJumpBps / 10000);
    value = clamp(value, 5000, 15000);
    values.push(value);
    world.value(tick, 'fundamental', value);
    world.value(tick, 'public', tick < config.informationDelay ? INITIAL_PRICE : values[tick - config.informationDelay]);
    for (let i = 0; i < 3; i++) replenish(world, tick, i);
    for (let i = 0; i < 6; i++) tradeNoise(world, tick, i);
    for (let i = 0; i < config.informedCount; i++) tradeInformed(world, tick, i);
    const quantity = slices.get(tick);
    if (quantity) world.order(tick, 'parent', config.side, quantity);
    world.apply({ kind: 'sample', sequence: world.events.length, tick });
  }
  return world.report();
}
export async function runLab(input: unknown = {}): Promise<LabResult> {
  const config = normalizeLabConfig(input);
  const reports = {} as Record<LabPolicy, LabReport>;
  for (const policy of LAB_POLICIES) reports[policy] = await generate(config, policy);
  return { version: LAB_VERSION, config, reports, comparisons: compareLabReports(reports) };
}

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), n => n.toString(16).padStart(2, '0')).join('');
}
function fullConfig(input: unknown): LabConfig {
  if (!object(input) || Object.keys(LAB_DEFAULTS).some(key => !Object.prototype.hasOwnProperty.call(input, key)))
    throw new Error('LAB_CONFIG');
  return normalizeLabConfig(input);
}
function parseTape(input: unknown): LabTape {
  if (!object(input) || input.version !== LAB_VERSION || !LAB_POLICIES.includes(input.policy as LabPolicy))
    throw new Error('LAB_VERSION');
  exactKeys(input, ['version', 'policy', 'config', 'events']);
  const config = fullConfig(input.config);
  if (!Array.isArray(input.events) || input.events.length > LAB_MAX_EVENTS || input.events.length < config.ticks * 3)
    throw new Error('LAB_EVENTS');
  const actors = new Set(createLabAccounts(config).map(a => a.id));
  let sampled = -1, previousTick = 0, fundamentalTick = -1, publicTick = -1;
  const events: LabEvent[] = input.events.map((raw: unknown, sequence: number): LabEvent => {
    if (!object(raw) || raw.sequence !== sequence) throw new Error('LAB_SEQUENCE');
    const tick = integer(raw.tick, 0, config.ticks - 1, 'tick');
    if (tick < previousTick || tick > sampled + 1 || tick <= sampled) throw new Error('LAB_SEQUENCE');
    previousTick = tick;
    if (raw.kind === 'fundamental' || raw.kind === 'public') {
      exactKeys(raw, ['kind', 'sequence', 'tick', 'value']);
      if (raw.kind === 'fundamental') {
        if (fundamentalTick === tick) throw new Error('LAB_SEQUENCE');
        fundamentalTick = tick;
      } else {
        if (publicTick === tick) throw new Error('LAB_SEQUENCE');
        publicTick = tick;
      }
      return { kind: raw.kind, sequence, tick, value: integer(raw.value, 5000, 15000, 'value') };
    }
    if (fundamentalTick !== tick || publicTick !== tick) throw new Error('LAB_SEQUENCE');
    if (raw.kind === 'sample') {
      exactKeys(raw, ['kind', 'sequence', 'tick']);
      sampled = tick;
      return { kind: 'sample', sequence, tick };
    }
    if (typeof raw.actor !== 'string' || !actors.has(raw.actor) || typeof raw.id !== 'string'
      || raw.id.length < 1 || raw.id.length > 128) throw new Error('LAB_ACTOR');
    if (raw.kind === 'cancel') {
      exactKeys(raw, ['kind', 'sequence', 'tick', 'actor', 'id']);
      return { kind: 'cancel', sequence, tick, actor: raw.actor, id: raw.id };
    }
    if (raw.kind !== 'order' || (raw.side !== 'buy' && raw.side !== 'sell')) throw new Error('LAB_ORDER');
    exactKeys(raw, ['kind', 'sequence', 'tick', 'actor', 'id', 'side', 'quantity', 'price']);
    const price = raw.price === undefined ? undefined : integer(raw.price, 100, 10000000, 'price');
    return { kind: 'order', sequence, tick, actor: raw.actor, id: raw.id, side: raw.side,
      quantity: integer(raw.quantity, 1, 50000, 'quantity'), ...(price === undefined ? {} : { price }) };
  });
  if (sampled !== config.ticks - 1) throw new Error('LAB_SEQUENCE');
  return { version: LAB_VERSION, policy: input.policy as LabPolicy, config, events };
}
export async function replayLab(input: unknown): Promise<LabReport> {
  const tape = parseTape(input), world = new Experiment(tape.config, tape.policy);
  for (const event of tape.events) world.apply(event);
  return world.report();
}
export function exportLab(result: LabResult): LabExport {
  const tapes = {} as LabExport['tapes'], digests = {} as LabExport['digests'];
  for (const policy of LAB_POLICIES) { tapes[policy] = result.reports[policy].tape; digests[policy] = result.reports[policy].digest; }
  return { version: LAB_VERSION, config: result.config, tapes, digests };
}
export async function verifyLabExport(input: unknown): Promise<LabResult> {
  if (!object(input) || input.version !== LAB_VERSION || !object(input.tapes) || !object(input.digests))
    throw new Error('LAB_VERSION');
  exactKeys(input, ['version', 'config', 'tapes', 'digests']);
  exactKeys(input.tapes, [...LAB_POLICIES]); exactKeys(input.digests, [...LAB_POLICIES]);
  const config = fullConfig(input.config), reports = {} as Record<LabPolicy, LabReport>;
  for (const policy of LAB_POLICIES) {
    const digest = input.digests[policy];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('LAB_DIGEST');
    const report = await replayLab(input.tapes[policy]);
    if (report.policy !== policy || JSON.stringify(report.config) !== JSON.stringify(config)) throw new Error('LAB_CONFIG');
    if (report.digest !== digest) throw new Error('LAB_DIGEST');
    reports[policy] = report;
  }
  return { version: LAB_VERSION, config, reports, comparisons: compareLabReports(reports) };
}
