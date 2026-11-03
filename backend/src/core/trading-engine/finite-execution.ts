/**
 * Finite price/time priority execution planner.
 *
 * Pure and self-contained: no IO, no clock, no randomness, no imports and no
 * shared state. The planner only consumes liquidity that is already in the
 * input (resting rows plus explicit external quotes), fills at most the
 * requested quantity and reports what it would have printed together with the
 * book that survives the plan.
 *
 * Conventions and invariants:
 * - `price` values are currency units with cent precision. Internally they are
 *   normalised once with `Math.round(price * 100)` and kept as integer cents;
 *   executed notional accumulates in integer cents and is only converted back
 *   to currency units when the plan is returned.
 * - `qty` / `size` are integer share counts.
 * - Priority: price first (buy/cover take the cheapest ask, sell/short the
 *   highest bid), then arrival clock ascending, then sequence ascending, then
 *   RESTING before EXTERNAL, then the row's original index. External quotes
 *   without a clock read as 0 and without a sequence read as their index.
 * - Icebergs: the visible `qty` trades first. When it is depleted the row
 *   re-enters its own price level at the back of the queue with
 *   `min(displayQty, hiddenQty)` shares, so other rows already queued at that
 *   price are matched first. Re-entry rewrites that row's `time`/`sequence` to
 *   the level clock and a monotonic counter so the queue position can be
 *   reproduced by the next planner run without a wall clock.
 * - Rows whose visible and hidden quantity reach zero are dropped from
 *   `restingAfter`; every other survivor (including excluded own-account rows,
 *   which are never touched) is copied, never mutated.
 * - The slice cap never hides a partial fill: `remaining` always reflects the
 *   quantity that was not filled and `truncated` only says that more fillable
 *   depth existed when the cap stopped the walk.
 */

export type ExecutionSide = 'buy' | 'sell' | 'short' | 'cover';

export interface RestingLiquidity {
  orderId: string | null;
  accountId: string | null;
  side: string;
  price: number;
  qty: number;
  time: number;
  sequence?: number;
  displayQty?: number;
  hiddenQty?: number;
  virtual?: boolean;
  expiresAtTick?: number;
  mmId?: string | null;
  tag?: string | null;
}

export interface ExternalLiquidity {
  price: number;
  size: number;
  time?: number;
  sequence?: number;
}

export interface FiniteSlice {
  source: 'resting' | 'external';
  index: number;
  price: number;
  quantity: number;
  order: RestingLiquidity | null;
}

export interface FinitePlan {
  requested: number;
  filled: number;
  remaining: number;
  totalCost: number;
  averagePrice: number;
  restingAfter: RestingLiquidity[];
  slices: FiniteSlice[];
  truncated: boolean;
}

const MAX_ROWS = 100_000;
const MAX_REQUESTED_QTY = 1_000_000_000;
const DEFAULT_MAX_SLICES = 10_000;
const MAX_SLICES = 100_000;

/** Book keeping for one resting row; `qty`/`hidden` are the live amounts. */
interface RestingState {
  index: number;
  order: RestingLiquidity;
  priceCents: number;
  time: number;
  sequence: number;
  qty: number;
  hidden: number;
  hadHidden: boolean;
  display: number;
  tradeable: boolean;
  revealed: boolean;
}

/** Book keeping for one external quote; `size` is the immutable input size. */
interface ExternalState {
  index: number;
  priceCents: number;
  time: number;
  sequence: number;
  size: number;
}

/**
 * One executable lot. Iceberg lots are appended to the level queue they belong
 * to, which is what keeps them behind the rows that were already queued.
 */
interface WorkItem {
  source: 'resting' | 'external';
  index: number;
  priceCents: number;
  time: number;
  sequence: number;
  quantity: number;
  state: RestingState | null;
  external: ExternalState | null;
}

function reject(message: string): never {
  throw new RangeError(message);
}

/** Currency price -> integer cents, rejecting anything that is not a price. */
function readPrice(price: number, where: string): number {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    reject(`${where} must be a positive finite price`);
  }
  const priceCents = Math.round(price * 100);
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    reject(`${where} cannot be represented with cent precision`);
  }
  return priceCents;
}

function readQty(value: number, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    reject(`${where} must be a non-negative safe integer quantity`);
  }
  return value;
}

function readClock(value: number | undefined, where: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    reject(`${where} must be a non-negative finite clock value`);
  }
  return value;
}

function ensureNotional(quantity: number, priceCents: number, where: string): void {
  if (!Number.isSafeInteger(quantity * priceCents)) {
    reject(`${where} notional does not fit integer-cent arithmetic`);
  }
}

function readRequestedQty(quantity: number): number {
  if (
    typeof quantity !== 'number' ||
    !Number.isFinite(quantity) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_REQUESTED_QTY
  ) {
    reject(`quantity must be an integer between 1 and ${MAX_REQUESTED_QTY}`);
  }
  return quantity;
}

function readSliceCap(maxSlices: number | undefined): number {
  if (maxSlices === undefined) return DEFAULT_MAX_SLICES;
  if (
    typeof maxSlices !== 'number' ||
    !Number.isFinite(maxSlices) ||
    !Number.isSafeInteger(maxSlices) ||
    maxSlices < 1 ||
    maxSlices > MAX_SLICES
  ) {
    reject(`maxSlices must be an integer between 1 and ${MAX_SLICES}`);
  }
  return maxSlices;
}

function readExcludeAccountId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') reject('excludeAccountId must be a string when provided');
  return value;
}

/**
 * Validates resting rows and copies them into planner state. Zero-quantity rows
 * are dropped (they carry no visible liquidity) unless they hide quantity,
 * which the caller has to reveal first.
 */
function buildRestingStates(rows: RestingLiquidity[], excludeAccountId: string | undefined): RestingState[] {
  if (!Array.isArray(rows)) reject('resting must be an array of resting quotes');
  if (rows.length > MAX_ROWS) reject(`resting must not hold more than ${MAX_ROWS} rows`);

  const states: RestingState[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const where = `resting[${index}]`;
    const raw: unknown = rows[index];
    if (raw === null || typeof raw !== 'object') reject(`${where} must be an object`);
    const row = raw as RestingLiquidity;

    const qty = readQty(row.qty, `${where}.qty`);
    const hiddenQty = row.hiddenQty === undefined ? 0 : readQty(row.hiddenQty, `${where}.hiddenQty`);
    if (qty === 0) {
      if (hiddenQty > 0) {
        reject(`${where} hides ${hiddenQty} shares behind a zero visible quantity; reveal it before planning`);
      }
      continue;
    }

    const priceCents = readPrice(row.price, `${where}.price`);
    ensureNotional(qty + hiddenQty, priceCents, where);
    const displayQty = row.displayQty === undefined ? qty : readQty(row.displayQty, `${where}.displayQty`);

    states.push({
      index,
      order: row,
      priceCents,
      time: readClock(row.time, `${where}.time`),
      sequence: row.sequence === undefined ? index : readClock(row.sequence, `${where}.sequence`),
      qty,
      hidden: hiddenQty,
      hadHidden: row.hiddenQty !== undefined,
      display: displayQty > 0 ? displayQty : qty,
      tradeable: !(excludeAccountId !== undefined && row.accountId === excludeAccountId),
      revealed: false,
    });
  }
  return states;
}

/** Validates external quotes; zero-size quotes are dropped as stale. */
function buildExternalStates(rows: ExternalLiquidity[]): ExternalState[] {
  if (!Array.isArray(rows)) reject('external must be an array of external quotes');
  if (rows.length > MAX_ROWS) reject(`external must not hold more than ${MAX_ROWS} rows`);

  const states: ExternalState[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const where = `external[${index}]`;
    const raw: unknown = rows[index];
    if (raw === null || typeof raw !== 'object') reject(`${where} must be an object`);
    const row = raw as ExternalLiquidity;

    const size = readQty(row.size, `${where}.size`);
    if (size === 0) continue;

    const priceCents = readPrice(row.price, `${where}.price`);
    ensureNotional(size, priceCents, where);
    states.push({
      index,
      priceCents,
      time: readClock(row.time, `${where}.time`),
      sequence: row.sequence === undefined ? index : readClock(row.sequence, `${where}.sequence`),
      size,
    });
  }
  return states;
}

function compareItems(a: WorkItem, b: WorkItem, direction: number): number {
  if (a.priceCents !== b.priceCents) return (a.priceCents - b.priceCents) * direction;
  if (a.time !== b.time) return a.time - b.time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.source !== b.source) return a.source === 'resting' ? -1 : 1;
  return a.index - b.index;
}

function compareSurvivors(a: RestingState, b: RestingState, direction: number): number {
  if (a.priceCents !== b.priceCents) return (a.priceCents - b.priceCents) * direction;
  if (a.time !== b.time) return a.time - b.time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.index - b.index;
}

/** Copy of a resting record with the live quantities (never the input object). */
function copyOrder(state: RestingState, qty: number, hidden: number): RestingLiquidity {
  const copy: RestingLiquidity = { ...state.order, price: state.priceCents / 100, qty };
  if (state.hadHidden || hidden > 0) copy.hiddenQty = hidden;
  if (state.revealed) {
    copy.time = state.time;
    copy.sequence = state.sequence;
  }
  return copy;
}

function hasFillableDepth(
  states: RestingState[],
  items: WorkItem[],
  allowed: (priceCents: number) => boolean,
): boolean {
  for (const state of states) {
    if (state.tradeable && state.qty > 0 && allowed(state.priceCents)) return true;
  }
  for (const item of items) {
    if (item.source === 'external' && item.quantity > 0 && allowed(item.priceCents)) return true;
  }
  return false;
}

export function planFiniteExecution(input: {
  side: ExecutionSide;
  quantity: number;
  resting: RestingLiquidity[];
  external: ExternalLiquidity[];
  limitPrice?: number;
  excludeAccountId?: string;
  maxSlices?: number;
}): FinitePlan {
  const rawInput: unknown = input;
  if (rawInput === null || typeof rawInput !== 'object') reject('input must be an object');

  const side = input.side;
  if (side !== 'buy' && side !== 'sell' && side !== 'short' && side !== 'cover') {
    reject("side must be one of 'buy', 'sell', 'short' or 'cover'");
  }
  const isBuySide = side === 'buy' || side === 'cover';
  const direction = isBuySide ? 1 : -1;

  const requested = readRequestedQty(input.quantity);
  const sliceCap = readSliceCap(input.maxSlices);
  const limitCents = input.limitPrice === undefined ? null : readPrice(input.limitPrice, 'limitPrice');
  const excludeAccountId = readExcludeAccountId(input.excludeAccountId);

  const states = buildRestingStates(input.resting, excludeAccountId);
  const externals = buildExternalStates(input.external);

  const allowed = (priceCents: number): boolean =>
    limitCents === null || (isBuySide ? priceCents <= limitCents : priceCents >= limitCents);

  const items: WorkItem[] = [];
  let sequenceFloor = 0;
  for (const state of states) {
    if (state.sequence > sequenceFloor) sequenceFloor = state.sequence;
    if (state.index > sequenceFloor) sequenceFloor = state.index;
    if (!state.tradeable) continue;
    items.push({
      source: 'resting',
      index: state.index,
      priceCents: state.priceCents,
      time: state.time,
      sequence: state.sequence,
      quantity: state.qty,
      state,
      external: null,
    });
  }
  for (const external of externals) {
    if (external.sequence > sequenceFloor) sequenceFloor = external.sequence;
    items.push({
      source: 'external',
      index: external.index,
      priceCents: external.priceCents,
      time: external.time,
      sequence: external.sequence,
      quantity: external.size,
      state: null,
      external,
    });
  }
  items.sort((a, b) => compareItems(a, b, direction));

  const slices: FiniteSlice[] = [];
  let remaining = requested;
  let totalCents = 0;
  let capHit = false;
  let sequenceCounter = sequenceFloor;

  let cursor = 0;
  levelLoop: while (cursor < items.length && remaining > 0) {
    const levelPriceCents = items[cursor].priceCents;
    if (!allowed(levelPriceCents)) break;

    // One price level: its queue grows when an iceberg lot is revealed, so the
    // revealed lots are matched strictly after the lots already queued there.
    const level: WorkItem[] = [];
    while (cursor < items.length && items[cursor].priceCents === levelPriceCents) {
      level.push(items[cursor]);
      cursor += 1;
    }
    let levelMaxTime = 0;
    for (const item of level) {
      if (item.time > levelMaxTime) levelMaxTime = item.time;
    }

    for (let position = 0; position < level.length; position += 1) {
      const item = level[position];
      if (item.quantity <= 0) continue;
      if (remaining <= 0) break levelLoop;
      if (slices.length >= sliceCap) {
        capHit = true;
        break levelLoop;
      }

      const take = Math.min(remaining, item.quantity);
      const notional = take * item.priceCents;
      if (!Number.isSafeInteger(notional) || !Number.isSafeInteger(totalCents + notional)) {
        reject('matched notional does not fit integer-cent arithmetic');
      }
      totalCents += notional;
      remaining -= take;
      item.quantity -= take;

      const state = item.state;
      slices.push({
        source: item.source,
        index: item.index,
        price: item.priceCents / 100,
        quantity: take,
        order: state === null ? null : copyOrder(state, state.qty, state.hidden),
      });

      if (state === null) continue;
      state.qty -= take;
      if (state.qty > 0 || state.hidden <= 0) continue;

      // Visible depleted on an iceberg: re-enter the level queue at its back.
      const reveal = Math.min(state.display, state.hidden);
      state.qty = reveal;
      state.hidden -= reveal;
      state.revealed = true;
      state.time = levelMaxTime;
      sequenceCounter += 1;
      state.sequence = sequenceCounter;
      level.push({
        source: 'resting',
        index: state.index,
        priceCents: state.priceCents,
        time: state.time,
        sequence: state.sequence,
        quantity: reveal,
        state,
        external: null,
      });
    }
  }

  const filled = requested - remaining;
  const totalCost = totalCents / 100;
  const truncated = capHit && remaining > 0 && hasFillableDepth(states, items, allowed);

  const survivors = states.filter((state) => state.qty > 0 || state.hidden > 0);
  survivors.sort((a, b) => compareSurvivors(a, b, direction));
  const restingAfter = survivors.map((state) => copyOrder(state, state.qty, state.hidden));

  return {
    requested,
    filled,
    remaining,
    totalCost,
    averagePrice: filled > 0 ? totalCost / filled : 0,
    restingAfter,
    slices,
    truncated,
  };
}
