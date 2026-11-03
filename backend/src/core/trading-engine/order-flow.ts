/**
 * Best-quote event order-flow imbalance (OFI) observer.
 *
 * Definition (Cont, Kukanov & Stoikov, "The Price Impact of Order Book
 * Events", arXiv:1011.6402), evaluated on every observed best-quote
 * transition of one symbol:
 *
 *   e = 1(Pb_n >= Pb_prev) * qb_n - 1(Pb_n <= Pb_prev) * qb_prev
 *     - 1(Pa_n <= Pa_prev) * qa_n + 1(Pa_n >= Pa_prev) * qa_prev
 *
 * Equal prices therefore reduce to size deltas (qb_n - qb_prev for bids,
 * qa_prev - qa_n for asks). Only the best quote is stored, so changes behind
 * the top of book are invisible here.
 *
 * Intentional semantics:
 * - The first valid sample, and the first sample after an unavailable quote,
 *   only establish the baseline; no event is manufactured from the gap.
 * - A missing/invalid side marks the symbol unavailable and drops the
 *   baseline. A price of zero is never invented. Already collected aggregates
 *   are preserved, the empty state is reported as unavailable.
 * - An unchanged quote (same prices and sizes) emits no event.
 * - No trade prints are consumed, so there is no executed volume to carry.
 * - This is quote-replacement flow: synthetic or replaced liquidity is part of
 *   the number and must not be read as direct attribution to informed trades.
 *
 * Units: `e` is in quoted size units at the top of book (positive = net buying
 * pressure). `normalizedOfi` = sum(e) / sum((qb_prev + qa_prev + qb_n + qa_n)/4)
 * is dimensionless ("net top-of-book flow per unit of mean quoted depth").
 * It is returned raw, never clipped: each contribution is bounded by four mean
 * depths, so the ratio stays within [-4, 4] but is not scaled into [-1, 1].
 * `averageDepth` is the mean of the same per-event mean depth over the window
 * (denominator = number of events in the window).
 *
 * Bounded and dependency free: per symbol a fixed ring of at most `window`
 * events (default 128), at most 4096 symbols, explicit errors instead of
 * silent eviction, no timestamps, randomness or IO.
 */

export interface QuoteLevel {
  readonly price: number;
  readonly size: number;
}

export interface QuoteSample {
  readonly bids: readonly QuoteLevel[];
  readonly asks: readonly QuoteLevel[];
}

export interface OrderFlowOptions {
  /** Rolling event window; integer in [1, 4096]. Defaults to 128. */
  readonly window?: number;
}

export interface OrderFlowSnapshot {
  /** False while the last observed sample had a missing/invalid side. */
  readonly available: boolean;
  /** Number of events currently retained in the rolling window. */
  readonly eventCount: number;
  /** Sum of e_n over the retained events. */
  readonly netOrderFlow: number;
  /** netOrderFlow / summed mean depth; `0` when no events are retained. */
  readonly normalizedOfi: number;
  /** Current (qb - qa) / (qb + qa) of the best quote; `0` when unavailable. */
  readonly queueImbalance: number;
  /** Mean quoted depth per retained event; `0` when no events are retained. */
  readonly averageDepth: number;
}

const MAX_SYMBOLS = 4096;
const MAX_WINDOW = 4096;
const DEFAULT_WINDOW = 128;

interface BestQuote {
  readonly price: number;
  readonly size: number;
}

interface SymbolState {
  available: boolean;
  bid: BestQuote | null;
  ask: BestQuote | null;
  readonly flows: Float64Array;
  readonly depths: Float64Array;
  head: number;
  count: number;
  flowSum: number;
  depthSum: number;
}

function isValidLevel(level: unknown): level is QuoteLevel {
  if (typeof level !== "object" || level === null) return false;
  const { price, size } = level as { price?: unknown; size?: unknown };
  return (
    typeof price === "number" &&
    Number.isFinite(price) &&
    price > 0 &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size > 0
  );
}

/** First valid level in caller order is the best quote; levels are not sorted. */
function bestQuote(levels: unknown): BestQuote | null {
  if (!Array.isArray(levels)) return null;
  for (const level of levels) {
    if (isValidLevel(level)) return { price: level.price, size: level.size };
  }
  return null;
}

function bidContribution(prev: BestQuote, next: BestQuote): number {
  if (next.price > prev.price) return next.size;
  if (next.price < prev.price) return -prev.size;
  return next.size - prev.size;
}

function askContribution(prev: BestQuote, next: BestQuote): number {
  if (next.price < prev.price) return -next.size;
  if (next.price > prev.price) return prev.size;
  return prev.size - next.size;
}

function emptySnapshot(): OrderFlowSnapshot {
  return {
    available: false,
    eventCount: 0,
    netOrderFlow: 0,
    normalizedOfi: 0,
    queueImbalance: 0,
    averageDepth: 0,
  };
}

export class BestQuoteOrderFlowObserver {
  private readonly window: number;
  private readonly states = new Map<string, SymbolState>();

  constructor(options: OrderFlowOptions = {}) {
    const window = options.window ?? DEFAULT_WINDOW;
    if (!Number.isInteger(window) || window < 1 || window > MAX_WINDOW) {
      throw new RangeError(
        `OrderFlowObserver window must be an integer in [1, ${MAX_WINDOW}], received ${String(window)}`,
      );
    }
    this.window = window;
  }

  /** Feeds one best-quote sample; returns the symbol state after the update. */
  observe(symbol: string, sample: QuoteSample): OrderFlowSnapshot {
    const state = this.ensureState(symbol);
    const raw = (sample ?? {}) as { readonly bids?: unknown; readonly asks?: unknown };
    const bid = bestQuote(raw.bids);
    const ask = bestQuote(raw.asks);

    if (bid === null || ask === null) {
      state.available = false;
      state.bid = null;
      state.ask = null;
      return this.snapshot(state);
    }

    const prevBid = state.bid;
    const prevAsk = state.ask;
    state.available = true;
    state.bid = bid;
    state.ask = ask;

    // First sample or re-baseline after unavailability: no manufactured event.
    if (prevBid === null || prevAsk === null) return this.snapshot(state);

    const unchanged =
      prevBid.price === bid.price &&
      prevBid.size === bid.size &&
      prevAsk.price === ask.price &&
      prevAsk.size === ask.size;
    if (unchanged) return this.snapshot(state);

    const flow = bidContribution(prevBid, bid) + askContribution(prevAsk, ask);
    const depth = (prevBid.size + prevAsk.size + bid.size + ask.size) / 4;
    this.push(state, flow, depth);
    return this.snapshot(state);
  }

  /** Snapshot of a symbol; unknown symbols read as unavailable zeros. */
  get(symbol: string): OrderFlowSnapshot {
    const state = this.states.get(symbol);
    return state === undefined ? emptySnapshot() : this.snapshot(state);
  }

  /** Drops all state for the symbol; returns whether it existed. */
  forget(symbol: string): boolean {
    return this.states.delete(symbol);
  }

  private ensureState(symbol: string): SymbolState {
    if (typeof symbol !== "string" || symbol.length === 0) {
      throw new TypeError("OrderFlowObserver symbol must be a non-empty string");
    }
    const existing = this.states.get(symbol);
    if (existing !== undefined) return existing;
    if (this.states.size >= MAX_SYMBOLS) {
      throw new RangeError(
        `OrderFlowObserver symbol capacity exceeded (${MAX_SYMBOLS}); call forget() for a symbol first`,
      );
    }
    const state: SymbolState = {
      available: false,
      bid: null,
      ask: null,
      flows: new Float64Array(this.window),
      depths: new Float64Array(this.window),
      head: 0,
      count: 0,
      flowSum: 0,
      depthSum: 0,
    };
    this.states.set(symbol, state);
    return state;
  }

  private push(state: SymbolState, flow: number, depth: number): void {
    if (state.count === this.window) {
      state.flowSum -= state.flows[state.head];
      state.depthSum -= state.depths[state.head];
    } else {
      state.count += 1;
    }
    state.flows[state.head] = flow;
    state.depths[state.head] = depth;
    state.flowSum += flow;
    state.depthSum += depth;
    state.head = (state.head + 1) % this.window;
  }

  private snapshot(state: SymbolState): OrderFlowSnapshot {
    const bid = state.bid;
    const ask = state.ask;
    const hasEvent = state.count > 0;
    const totalDepth = bid === null || ask === null ? 0 : bid.size + ask.size;
    return {
      available: state.available,
      eventCount: state.count,
      netOrderFlow: hasEvent ? state.flowSum : 0,
      normalizedOfi: hasEvent && state.depthSum > 0 ? state.flowSum / state.depthSum : 0,
      queueImbalance: bid !== null && ask !== null && totalDepth > 0 ? (bid.size - ask.size) / totalDepth : 0,
      averageDepth: hasEvent ? state.depthSum / state.count : 0,
    };
  }
}
