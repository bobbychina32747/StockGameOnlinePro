import type {
  LabAccount,
  LabBookView,
  LabLevel,
  LabOrderEvent,
  LabOrderResult,
  LabRole,
  LabSide,
  LabTrade,
} from './lab-types';

/**
 * FiniteOrderBook — pure, deterministic limit order book for the isolated
 * synthetic research market.
 *
 * Units: all money/price values are INTEGER CENTS, all quantities are integer
 * shares. Time is an explicit (tick, sequence) pair supplied by the caller;
 * nothing here reads a clock or a random source.
 *
 * Conservative assumptions (short):
 * - Every resting sell reserves its remaining shares and every resting buy
 *   reserves cash, so a participant can never oversell or overspend.
 * - A resting buy reserves `price + ceil(price*feeBps/10000)` per share, which
 *   upper-bounds the sum of per-fill fees `ceil(price*qty*feeBps/10000)` and
 *   therefore covers fee rounding across partial fills.
 * - There is no synthetic liquidity and no refill: every fill consumes the
 *   actual quantity of a real resting order.
 * - Self-trade prevention cancels the incoming remainder at the first own
 *   opposite entry, so the book is never left crossed.
 */

const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 10_000_000;
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 50_000;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CASH_CENTS = 1_000_000_000_000;
const MAX_INVENTORY_SHARES = 10_000_000;
const MAX_TICK_OR_SEQUENCE = 10_000_000;
const MAX_FEE_BPS = 100;
const FEE_DENOMINATOR = 10_000;

const DEFAULT_SNAPSHOT_DEPTH = 100;
const MIN_SNAPSHOT_DEPTH = 1;
const MAX_SNAPSHOT_DEPTH = 1_000;

const ROLES: readonly LabRole[] = ['maker', 'noise', 'informed', 'parent'];

interface AccountState {
  id: string;
  role: LabRole;
  cash: number;
  inventory: number;
  initialCash: number;
  initialInventory: number;
  targetInventory: number;
  reservedCash: number;
  reservedInventory: number;
}

interface RestingOrder {
  id: string;
  actor: string;
  side: LabSide;
  price: number;
  remaining: number;
  sequence: number;
  tick: number;
}

interface ParsedOrderData {
  id: string;
  actor: string;
  side: LabSide;
  quantity: number;
  sequence: number;
  tick: number;
  price: number | undefined;
}

type OrderParse = ({ ok: true } & ParsedOrderData) | { ok: false; reason: string; unfilled: number };

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim().length > 0
  );
}

/** Per-trade fee in cents: `ceil(price * qty * feeBps / 10000)`. */
function feeFor(price: number, quantity: number, feeBps: number): number {
  return Math.ceil((price * quantity * feeBps) / FEE_DENOMINATOR);
}

/** Per-share cash reservation for a resting buy; covers per-fill fee rounding. */
function reservePerShare(price: number, feeBps: number): number {
  return price + Math.ceil((price * feeBps) / FEE_DENOMINATOR);
}

function compareIdentifiers(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Bids: best = highest price, then earliest explicit sequence, then id. */
function compareBids(a: RestingOrder, b: RestingOrder): number {
  if (a.price !== b.price) return b.price - a.price;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return compareIdentifiers(a.id, b.id);
}

/** Asks: best = lowest price, then earliest explicit sequence, then id. */
function compareAsks(a: RestingOrder, b: RestingOrder): number {
  if (a.price !== b.price) return a.price - b.price;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return compareIdentifiers(a.id, b.id);
}

function rejectResult(reason: string, unfilled: number): LabOrderResult {
  return { filled: 0, unfilled, resting: 0, trades: [], reason };
}

function toAccountState(account: LabAccount): AccountState {
  if (account === null || typeof account !== 'object') {
    throw new Error('FiniteOrderBook: each account must be an object');
  }
  const { id, role } = account;
  if (!isIdentifier(id)) {
    throw new Error('FiniteOrderBook: account id must be a non-empty string of at most 128 characters');
  }
  if (!ROLES.includes(role)) {
    throw new Error(`FiniteOrderBook: account "${id}" has an invalid role`);
  }
  if (!isSafeIntegerInRange(account.cash, 0, MAX_CASH_CENTS)) {
    throw new Error(`FiniteOrderBook: account "${id}" has an invalid cash balance`);
  }
  if (!isSafeIntegerInRange(account.inventory, 0, MAX_INVENTORY_SHARES)) {
    throw new Error(`FiniteOrderBook: account "${id}" has an invalid inventory`);
  }
  if (!isSafeIntegerInRange(account.initialCash, 0, MAX_CASH_CENTS)) {
    throw new Error(`FiniteOrderBook: account "${id}" has an invalid initialCash`);
  }
  if (!isSafeIntegerInRange(account.initialInventory, 0, MAX_INVENTORY_SHARES)) {
    throw new Error(`FiniteOrderBook: account "${id}" has an invalid initialInventory`);
  }
  if (!isSafeIntegerInRange(account.targetInventory, 0, MAX_INVENTORY_SHARES)) {
    throw new Error(`FiniteOrderBook: account "${id}" has an invalid targetInventory`);
  }
  return {
    id,
    role,
    cash: account.cash,
    inventory: account.inventory,
    initialCash: account.initialCash,
    initialInventory: account.initialInventory,
    targetInventory: account.targetInventory,
    reservedCash: 0,
    reservedInventory: 0,
  };
}

function parseOrderEvent(event: LabOrderEvent): OrderParse {
  const raw: unknown = event;
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'invalid-event', unfilled: 0 };
  }
  const candidate = raw as Partial<LabOrderEvent> & { kind?: unknown };
  if (candidate.kind !== 'order') {
    return { ok: false, reason: 'invalid-kind', unfilled: 0 };
  }
  if (!isIdentifier(candidate.id)) {
    return { ok: false, reason: 'invalid-id', unfilled: 0 };
  }
  if (!isIdentifier(candidate.actor)) {
    return { ok: false, reason: 'invalid-actor', unfilled: 0 };
  }
  if (!isSafeIntegerInRange(candidate.quantity, MIN_QUANTITY, MAX_QUANTITY)) {
    return { ok: false, reason: 'invalid-quantity', unfilled: 0 };
  }
  const quantity = candidate.quantity;
  if (!isSafeIntegerInRange(candidate.sequence, 0, MAX_TICK_OR_SEQUENCE)) {
    return { ok: false, reason: 'invalid-sequence', unfilled: quantity };
  }
  if (!isSafeIntegerInRange(candidate.tick, 0, MAX_TICK_OR_SEQUENCE)) {
    return { ok: false, reason: 'invalid-tick', unfilled: quantity };
  }
  if (candidate.side !== 'buy' && candidate.side !== 'sell') {
    return { ok: false, reason: 'invalid-side', unfilled: quantity };
  }
  let price: number | undefined;
  if (candidate.price !== undefined) {
    if (!isSafeIntegerInRange(candidate.price, MIN_PRICE_CENTS, MAX_PRICE_CENTS)) {
      return { ok: false, reason: 'invalid-price', unfilled: quantity };
    }
    price = candidate.price;
  }
  return {
    ok: true,
    id: candidate.id,
    actor: candidate.actor,
    side: candidate.side,
    quantity,
    sequence: candidate.sequence,
    tick: candidate.tick,
    price,
  };
}

function clampDepth(depth: number): number {
  if (!isSafeIntegerInRange(depth, MIN_SNAPSHOT_DEPTH, MAX_SNAPSHOT_DEPTH))
    throw new Error('FiniteOrderBook: invalid snapshot depth');
  return depth;
}

export class FiniteOrderBook {
  private readonly feeBps: number;
  private readonly accounts = new Map<string, AccountState>();
  private readonly accountIds: string[] = [];
  private readonly bids: RestingOrder[] = [];
  private readonly asks: RestingOrder[] = [];
  private readonly tradeLog: LabTrade[] = [];
  private readonly usedIds = new Set<string>();
  private feePool = 0;

  constructor(accounts: LabAccount[], feeBps = 5,
    private readonly onQuoteChange?: (before: LabBookView, after: LabBookView) => void) {
    if (!isSafeIntegerInRange(feeBps, 0, MAX_FEE_BPS)) {
      throw new Error('FiniteOrderBook: feeBps must be an integer between 0 and 100');
    }
    if (!Array.isArray(accounts) || accounts.length > 100) {
      throw new Error('FiniteOrderBook: accounts must be an array');
    }
    this.feeBps = feeBps;
    for (const account of accounts) {
      const state = toAccountState(account);
      if (this.accounts.has(state.id)) {
        throw new Error(`FiniteOrderBook: duplicate account id "${state.id}"`);
      }
      this.accounts.set(state.id, state);
      this.accountIds.push(state.id);
    }
  }

  submit(event: LabOrderEvent): LabOrderResult {
    const parsed = parseOrderEvent(event);
    if (!parsed.ok) return rejectResult(parsed.reason, parsed.unfilled);

    const { id, actor, side, quantity, sequence, tick, price } = parsed;
    const account = this.accounts.get(actor);
    if (account === undefined) return rejectResult('unknown-actor', quantity);

    this.sortBids();
    this.sortAsks();
    if (this.usedIds.has(id)) return rejectResult('duplicate-order-id', quantity);

    const isBuy = side === 'buy';

    // Validate free resources before touching any state.
    if (isBuy) {
      if (price !== undefined) {
        const required = quantity * reservePerShare(price, this.feeBps);
        if (required > this.freeCash(account)) {
          return rejectResult('insufficient-cash', quantity);
        }
      }
      // Market buys may fill partially within the unreserved cash.
    } else if (quantity > this.freeInventory(account)) {
      return rejectResult('insufficient-inventory', quantity);
    }

    this.usedIds.add(id);
    const trades: LabTrade[] = [];
    let remaining = quantity;
    let selfTradeBlocked = false;
    let cashLimited = false;

    if (isBuy) {
      this.sortAsks();
      while (remaining > 0 && this.asks.length > 0) {
        const resting = this.asks[0];
        if (price !== undefined && resting.price > price) break;
        if (resting.actor === actor) {
          selfTradeBlocked = true;
          break;
        }
        let fillQuantity = Math.min(remaining, resting.remaining);
        if (price === undefined) {
          const affordable = this.affordableQuantity(account, resting.price, fillQuantity);
          if (affordable < fillQuantity) {
            cashLimited = true;
            fillQuantity = affordable;
          }
          if (fillQuantity <= 0) break;
        }
        trades.push(this.executeFill(actor, true, resting, fillQuantity, sequence, tick, trades.length));
        remaining -= fillQuantity;
      }
    } else {
      this.sortBids();
      while (remaining > 0 && this.bids.length > 0) {
        const resting = this.bids[0];
        if (price !== undefined && resting.price < price) break;
        if (resting.actor === actor) {
          selfTradeBlocked = true;
          break;
        }
        const fillQuantity = Math.min(remaining, resting.remaining);
        trades.push(this.executeFill(actor, false, resting, fillQuantity, sequence, tick, trades.length));
        remaining -= fillQuantity;
      }
    }

    const filled = quantity - remaining;
    let restingQuantity = 0;
    let reason: string | undefined;

    if (remaining > 0) {
      if (selfTradeBlocked) {
        // The incoming remainder is cancelled: never rest a crossed book.
        reason = 'self-trade-prevented';
      } else if (price === undefined) {
        // Market remainder never rests.
        reason = cashLimited ? 'insufficient-cash' : 'market-remainder-cancelled';
      } else {
        const before = this.onQuoteChange ? this.snapshot(1) : undefined;
        const order: RestingOrder = { id, actor, side, price, remaining, sequence, tick };
        if (isBuy) {
          this.bids.push(order);
          this.sortBids();
          account.reservedCash += remaining * reservePerShare(price, this.feeBps);
        } else {
          this.asks.push(order);
          this.sortAsks();
          account.reservedInventory += remaining;
        }
        restingQuantity = remaining;
        this.assertReservations(account);
        if (before) this.onQuoteChange!(before, this.snapshot(1));
      }
    }

    const result: LabOrderResult = {
      filled,
      unfilled: quantity - filled - restingQuantity,
      resting: restingQuantity,
      trades: trades.map((trade) => ({ ...trade })),
    };
    if (reason !== undefined) result.reason = reason;
    return result;
  }

  cancel(actor: string, id: string): number {
    if (!isIdentifier(actor) || !isIdentifier(id)) return 0;
    const order = this.findById(id);
    if (order === null || order.actor !== actor) return 0;

    const before = this.onQuoteChange ? this.snapshot(1) : undefined;
    this.removeOrder(order);
    const account = this.accounts.get(actor);
    if (account !== undefined) {
      if (order.side === 'buy') {
        account.reservedCash -= order.remaining * reservePerShare(order.price, this.feeBps);
      } else {
        account.reservedInventory -= order.remaining;
      }
      this.assertReservations(account);
    }
    if (before) this.onQuoteChange!(before, this.snapshot(1));
    return order.remaining;
  }

  snapshot(depth = DEFAULT_SNAPSHOT_DEPTH): LabBookView {
    const maxLevels = clampDepth(depth);
    this.sortBids();
    this.sortAsks();

    const bids = this.aggregate(this.bids, maxLevels);
    const asks = this.aggregate(this.asks, maxLevels);

    const bidSize = bids[0]?.quantity ?? 0;
    const askSize = asks[0]?.quantity ?? 0;

    const bid = bids.length > 0 ? bids[0].price : null;
    const ask = asks.length > 0 ? asks[0].price : null;
    const twoSided = bid !== null && ask !== null;
    const totalSize = bidSize + askSize;

    return {
      bids,
      asks,
      bid,
      ask,
      bidSize,
      askSize,
      mid: twoSided ? ((bid as number) + (ask as number)) / 2 : null,
      spread: twoSided ? (ask as number) - (bid as number) : null,
      imbalance: totalSize > 0 ? (bidSize - askSize) / totalSize : null,
    };
  }

  getAccounts(): LabAccount[] {
    return this.accountIds.map((id) => {
      const account = this.accounts.get(id) as AccountState;
      return {
        id: account.id,
        role: account.role,
        cash: account.cash,
        inventory: account.inventory,
        initialCash: account.initialCash,
        initialInventory: account.initialInventory,
        targetInventory: account.targetInventory,
      };
    });
  }

  getTrades(): LabTrade[] {
    return this.tradeLog.map((trade) => ({ ...trade }));
  }

  getFeePool(): number {
    return this.feePool;
  }

  getOrders(actor?: string): {
    id: string;
    actor: string;
    side: LabSide;
    price: number;
    remaining: number;
    sequence: number;
    tick: number;
  }[] {
    this.sortBids();
    this.sortAsks();
    const orders = [...this.bids, ...this.asks];
    const selected = actor === undefined ? orders : orders.filter((order) => order.actor === actor);
    return selected.map((order) => ({
      id: order.id,
      actor: order.actor,
      side: order.side,
      price: order.price,
      remaining: order.remaining,
      sequence: order.sequence,
      tick: order.tick,
    }));
  }

  private freeCash(account: AccountState): number {
    return account.cash - account.reservedCash;
  }

  private freeInventory(account: AccountState): number {
    return account.inventory - account.reservedInventory;
  }

  /** Largest `quantity <= cap` whose gross+fee cost fits the account's free cash. */
  private affordableQuantity(account: AccountState, price: number, cap: number): number {
    const available = this.freeCash(account);
    let low = 0;
    let high = Math.max(0, Math.min(cap, MAX_QUANTITY));
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const cost = price * mid + feeFor(price, mid, this.feeBps);
      if (cost <= available) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** Settle one fill against a real resting order (trades print at resting price). */
  private executeFill(
    aggressor: string,
    aggressorIsBuy: boolean,
    resting: RestingOrder,
    quantity: number,
    sequence: number,
    tick: number,
    fillIndex: number,
  ): LabTrade {
    const before = this.onQuoteChange ? this.snapshot(1) : undefined;
    const price = resting.price;
    const buyerId = aggressorIsBuy ? aggressor : resting.actor;
    const sellerId = aggressorIsBuy ? resting.actor : aggressor;
    const buyer = this.accounts.get(buyerId);
    const seller = this.accounts.get(sellerId);
    if (buyer === undefined || seller === undefined) {
      throw new Error('FiniteOrderBook: fill against an unknown account');
    }

    const gross = price * quantity;
    const buyerFee = feeFor(price, quantity, this.feeBps);
    const sellerFee = feeFor(price, quantity, this.feeBps);

    buyer.cash -= gross + buyerFee;
    seller.cash += gross - sellerFee;
    buyer.inventory += quantity;
    seller.inventory -= quantity;
    this.feePool += buyerFee + sellerFee;

    const restingAccount = resting.side === 'buy' ? buyer : seller;
    if (resting.side === 'buy') {
      restingAccount.reservedCash -= quantity * reservePerShare(price, this.feeBps);
    } else {
      restingAccount.reservedInventory -= quantity;
    }

    resting.remaining -= quantity;
    if (resting.remaining === 0) this.removeOrder(resting);

    this.assertReservations(buyer);
    this.assertReservations(seller);

    const trade: LabTrade = {
      id: `T${sequence}-${fillIndex}`,
      tick,
      sequence,
      price,
      quantity,
      buyer: buyerId,
      seller: sellerId,
      buyerFee,
      sellerFee,
      aggressor,
      restingOrder: resting.id,
    };
    this.tradeLog.push(trade);
    if (before) this.onQuoteChange!(before, this.snapshot(1));
    return trade;
  }

  private sortBids(): void {
    this.bids.sort(compareBids);
  }

  private sortAsks(): void {
    this.asks.sort(compareAsks);
  }

  private findById(id: string): RestingOrder | null {
    for (const order of this.bids) {
      if (order.id === id) return order;
    }
    for (const order of this.asks) {
      if (order.id === id) return order;
    }
    return null;
  }

  private removeOrder(order: RestingOrder): void {
    const book = order.side === 'buy' ? this.bids : this.asks;
    const index = book.indexOf(order);
    if (index >= 0) book.splice(index, 1);
  }

  private aggregate(orders: readonly RestingOrder[], maxLevels: number): LabLevel[] {
    const levels: LabLevel[] = [];
    for (const order of orders) {
      const last = levels.length > 0 ? levels[levels.length - 1] : undefined;
      if (last !== undefined && last.price === order.price) {
        last.quantity += order.remaining;
        continue;
      }
      if (levels.length >= maxLevels) break;
      levels.push({ price: order.price, quantity: order.remaining });
    }
    return levels;
  }

  private assertReservations(account: AccountState): void {
    if (
      account.reservedCash < 0 ||
      account.reservedInventory < 0 ||
      account.reservedCash > account.cash ||
      account.reservedInventory > account.inventory
      || !Number.isSafeInteger(account.cash) || !Number.isSafeInteger(account.inventory)
    ) {
      throw new Error(`FiniteOrderBook: reservation invariant violated for "${account.id}"`);
    }
  }
}
