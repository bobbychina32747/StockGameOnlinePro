/**
 * Deterministic, side-effect free metrics for the isolated synthetic research market.
 *
 * Money and prices are integer cents, quantities are integer shares. This module does
 * not read the wall clock, does not draw randomness, performs no IO and never mutates
 * its arguments: every value below is derived only from the values handed in.
 */

import type {
  LabAccount,
  LabBookView,
  LabComparison,
  LabConfig,
  LabLevel,
  LabMetrics,
  LabPoint,
  LabPolicy,
  LabReport,
  LabRole,
  LabTrade,
} from './lab-types';
import { LAB_POLICIES } from './lab-types';

const POLICIES: readonly LabPolicy[] = LAB_POLICIES;
const ROLES: readonly LabRole[] = ['maker', 'noise', 'informed', 'parent'];
const COMPARED_POLICIES = ['lump', 'twap', 'vwap'] as const;

/** Account id of the strategy under test. */
const PARENT_ID = 'parent';
/** Arrival fallback used when the pre-sample point is missing. */
const DEFAULT_ARRIVAL_PRICE = 10000;
const BPS = 1e4;
const MARKOUT_HORIZON_TICKS = 5;
const ARRIVAL_FRACTION = 0.2;
const PEAK_WINDOW_FRACTION = 0.2;
const RECOVERY_WINDOW_FRACTION = 0.7;

/* ------------------------------------------------------------------ */
/* validation helpers                                                  */
/* ------------------------------------------------------------------ */

function fail(message: string): never {
  throw new TypeError(`lab-metrics: ${message}`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerAtLeast(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function assertConfig(config: LabConfig): void {
  const raw = asObject(config);
  if (raw === null) fail('config must be an object');
  for (const key of [
    'seed',
    'ticks',
    'quantity',
    'quoteSize',
    'replenishEvery',
    'informationDelay',
    'informedCount',
    'inventoryAversion',
    'newsJumpBps',
  ] as const) {
    if (!isFiniteNumber(config[key])) fail(`config.${key} must be a finite number`);
  }
  if (!isIntegerAtLeast(config.ticks, 0)) fail('config.ticks must be a non-negative integer');
  if (!isIntegerAtLeast(config.quantity, 0)) fail('config.quantity must be a non-negative integer');
  if (config.side !== 'buy' && config.side !== 'sell') fail('config.side must be "buy" or "sell"');
}

function assertLevels(levels: LabLevel[], label: string): void {
  if (!Array.isArray(levels)) fail(`${label} must be an array of levels`);
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    const raw = asObject(level);
    if (raw === null) fail(`${label}[${index}] must be an object`);
    if (!isFiniteNumber(level.price)) fail(`${label}[${index}].price must be a finite number`);
    if (!isFiniteNumber(level.quantity)) fail(`${label}[${index}].quantity must be a finite number`);
  }
}

function assertBookView(book: LabBookView, label: string): void {
  const raw = asObject(book);
  if (raw === null) fail(`${label} must be a book view object`);
  assertLevels(book.bids, `${label}.bids`);
  assertLevels(book.asks, `${label}.asks`);
  for (const key of ['bid', 'ask', 'mid', 'spread', 'imbalance'] as const) {
    const value = book[key];
    if (value !== null && !isFiniteNumber(value)) fail(`${label}.${key} must be a finite number or null`);
  }
  if (!isFiniteNumber(book.bidSize)) fail(`${label}.bidSize must be a finite number`);
  if (!isFiniteNumber(book.askSize)) fail(`${label}.askSize must be a finite number`);
}

function assertPoints(points: LabPoint[]): void {
  if (!Array.isArray(points)) fail('points must be an array');
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const raw = asObject(point);
    if (raw === null) fail(`points[${index}] must be an object`);
    if (!isIntegerAtLeast(point.tick, 0)) fail(`points[${index}].tick must be a non-negative integer`);
    for (const key of ['mid', 'bidDepth', 'askDepth', 'volume', 'ofi'] as const) {
      if (!isFiniteNumber(point[key])) fail(`points[${index}].${key} must be a finite number`);
    }
    for (const key of ['bid', 'ask', 'spread', 'imbalance'] as const) {
      const value = point[key];
      if (value !== null && value !== undefined && !isFiniteNumber(value)) {
        fail(`points[${index}].${key} must be a finite number or null`);
      }
    }
    if (typeof point.twoSided !== 'boolean') fail(`points[${index}].twoSided must be a boolean`);
  }
}

function assertTrades(trades: LabTrade[]): void {
  if (!Array.isArray(trades)) fail('trades must be an array');
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    const raw = asObject(trade);
    if (raw === null) fail(`trades[${index}] must be an object`);
    if (!isIntegerAtLeast(trade.tick, 0)) fail(`trades[${index}].tick must be a non-negative integer`);
    if (!isIntegerAtLeast(trade.quantity, 0)) fail(`trades[${index}].quantity must be a non-negative integer`);
    if (!isFiniteNumber(trade.price)) fail(`trades[${index}].price must be a finite number`);
    if (typeof trade.buyer !== 'string' || trade.buyer.length === 0) {
      fail(`trades[${index}].buyer must be a non-empty string`);
    }
    if (typeof trade.seller !== 'string' || trade.seller.length === 0) {
      fail(`trades[${index}].seller must be a non-empty string`);
    }
    for (const key of ['buyerFee', 'sellerFee'] as const) {
      const value = trade[key];
      if (value !== undefined && !isFiniteNumber(value)) fail(`trades[${index}].${key} must be a finite number`);
    }
  }
}

function assertAccounts(accounts: LabAccount[]): void {
  if (!Array.isArray(accounts)) fail('accounts must be an array');
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const raw = asObject(account);
    if (raw === null) fail(`accounts[${index}] must be an object`);
    if (typeof account.id !== 'string' || account.id.length === 0) {
      fail(`accounts[${index}].id must be a non-empty string`);
    }
    if (!ROLES.includes(account.role)) fail(`accounts[${index}].role must be one of ${ROLES.join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */
/* array helpers                                                       */
/* ------------------------------------------------------------------ */

function sortPoints(points: readonly LabPoint[]): LabPoint[] {
  return points.slice().sort((left, right) => left.tick - right.tick);
}

function indexByTick(points: readonly LabPoint[]): Map<number, LabPoint> {
  const byTick = new Map<number, LabPoint>();
  for (const point of points) {
    if (!byTick.has(point.tick)) byTick.set(point.tick, point);
  }
  return byTick;
}

/**
 * Pearson product-moment correlation of two equally sized samples.
 * Returns null when there are too few observations or either series has zero variance.
 */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const count = xs.length;
  if (count < 2 || ys.length !== count) return null;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < count; index += 1) {
    sumX += xs[index];
    sumY += ys[index];
  }
  const meanX = sumX / count;
  const meanY = sumY / count;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (!(varianceX > 0) || !(varianceY > 0)) return null;
  const denominator = Math.sqrt(varianceX * varianceY);
  if (!(denominator > 0) || !Number.isFinite(denominator)) return null;
  const correlation = covariance / denominator;
  if (!Number.isFinite(correlation)) return null;
  return Math.max(-1, Math.min(1, correlation));
}

/* ------------------------------------------------------------------ */
/* order flow imbalance                                                */
/* ------------------------------------------------------------------ */

/**
 * Event based order-flow imbalance between two consecutive best-quote snapshots.
 *
 * This is *flow*, not the *static* book imbalance: only a change of the best quote
 * contributes depth, so a book that merely sits still (however lopsided `bidSize`
 * versus `askSize` is, i.e. its static imbalance) contributes nothing at all.
 * Depth is counted with the sign implied by the quote move:
 *
 * - bid rise   -> +newBidSize, bid fall -> -oldBidSize, unchanged -> new - old
 * - ask fall   -> -newAskSize, ask rise -> +oldAskSize, unchanged -> old - new
 * - empty -> present adds the new side (+bid / -ask); present -> empty removes the
 *   old side (-bid / +ask); empty on both snapshots contributes nothing.
 */
export function eventOFI(before: LabBookView, after: LabBookView): number {
  assertBookView(before, 'before');
  assertBookView(after, 'after');
  const bidFlow = bidQuoteFlow(before, after);
  const askFlow = askQuoteFlow(before, after);
  if (!Number.isFinite(bidFlow) || !Number.isFinite(askFlow)) return 0;
  const total = bidFlow + askFlow;
  return Number.isFinite(total) ? total : 0;
}

function bidQuoteFlow(before: LabBookView, after: LabBookView): number {
  const previousPrice = before.bid;
  const currentPrice = after.bid;
  if (previousPrice === null && currentPrice === null) return 0;
  if (previousPrice === null) return after.bidSize; // empty -> present: new depth
  if (currentPrice === null) return -before.bidSize; // present -> empty: old depth removed
  if (currentPrice > previousPrice) return after.bidSize; // bid improved: new depth joins
  if (currentPrice < previousPrice) return -before.bidSize; // bid slipped: old depth leaves
  return after.bidSize - before.bidSize; // unchanged price: depth delta
}

function askQuoteFlow(before: LabBookView, after: LabBookView): number {
  const previousPrice = before.ask;
  const currentPrice = after.ask;
  if (previousPrice === null && currentPrice === null) return 0;
  if (previousPrice === null) return -after.askSize; // empty -> present: new ask depth
  if (currentPrice === null) return before.askSize; // present -> empty: old depth removed
  if (currentPrice < previousPrice) return -after.askSize; // ask improved: new depth joins
  if (currentPrice > previousPrice) return before.askSize; // ask slipped: old depth leaves
  return before.askSize - after.askSize; // unchanged price: depth delta
}

/**
 * Static (state based) depth imbalance of a single snapshot, provided for callers that
 * need to tell "the book is lopsided" apart from "order flow pushed the quote".
 * Null when the book shows no depth on either side.
 */
export function staticBookImbalance(book: LabBookView): number | null {
  assertBookView(book, 'book');
  const total = book.bidSize + book.askSize;
  if (!Number.isFinite(total) || total === 0) return null;
  const imbalance = (book.bidSize - book.askSize) / total;
  return Number.isFinite(imbalance) ? imbalance : null;
}

/* ------------------------------------------------------------------ */
/* execution metrics                                                   */
/* ------------------------------------------------------------------ */

export function calculateLabMetrics(
  config: LabConfig,
  policy: LabPolicy,
  points: LabPoint[],
  trades: LabTrade[],
  accounts: LabAccount[],
): LabMetrics {
  assertConfig(config);
  if (!POLICIES.includes(policy)) fail(`policy must be one of ${POLICIES.join(', ')}`);
  assertPoints(points);
  assertTrades(trades);
  assertAccounts(accounts);

  const baseline = policy === 'baseline';
  const requested = baseline ? 0 : config.quantity;
  const direction = config.side === 'buy' ? 1 : -1;

  const ordered = sortPoints(points);
  const pointByTick = indexByTick(ordered);

  const parentIds = new Set<string>([PARENT_ID]);
  for (const account of accounts) {
    if (account.role === 'parent') parentIds.add(account.id);
  }

  /* parent participation on the tape */
  let filled = 0;
  let executedNotional = 0;
  let fees = 0;
  for (const trade of trades) {
    const buyerIsParent = parentIds.has(trade.buyer);
    const sellerIsParent = parentIds.has(trade.seller);
    if (!buyerIsParent && !sellerIsParent) continue;
    filled += trade.quantity;
    executedNotional += trade.price * trade.quantity;
    if (buyerIsParent && isFiniteNumber(trade.buyerFee)) fees += trade.buyerFee;
    if (sellerIsParent && isFiniteNumber(trade.sellerFee)) fees += trade.sellerFee;
  }

  /* arrival: the sample immediately before the 20% mark of the tape */
  const arrivalTick = Math.floor(config.ticks * ARRIVAL_FRACTION) - 1;
  const arrivalPoint = pointByTick.get(arrivalTick);
  const arrivalPrice =
    arrivalPoint !== undefined && isFiniteNumber(arrivalPoint.mid) && arrivalPoint.mid !== 0
      ? arrivalPoint.mid
      : DEFAULT_ARRIVAL_PRICE;

  /* terminal: the last observed mid, else the arrival reference */
  let terminalPrice = arrivalPrice;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const mid = ordered[index].mid;
    if (isFiniteNumber(mid)) {
      terminalPrice = mid;
      break;
    }
  }

  const averagePrice = filled > 0 ? finiteOrNull(executedNotional / filled) : null;

  const executionDenominator = arrivalPrice * filled;
  const executionCostBps =
    filled > 0 && executionDenominator !== 0
      ? finiteOrNull(
          ((direction * (executedNotional - arrivalPrice * filled) + fees) / executionDenominator) * BPS,
        )
      : null;

  const requestedDenominator = arrivalPrice * requested;
  const opportunityCostBps =
    requested > 0 && requestedDenominator !== 0
      ? finiteOr(
          ((direction * (terminalPrice - arrivalPrice) * (requested - filled)) / requestedDenominator) * BPS,
          0,
        )
      : 0;

  const implementationShortfallBps =
    requested > 0 && requestedDenominator !== 0
      ? finiteOr(
          ((direction * (executedNotional - arrivalPrice * filled) +
            fees +
            direction * (terminalPrice - arrivalPrice) * (requested - filled)) /
            requestedDenominator) *
            BPS,
          0,
        )
      : 0;

  /* whole-tape VWAP */
  let tapeNotional = 0;
  let tapeVolume = 0;
  for (const trade of trades) {
    tapeNotional += trade.price * trade.quantity;
    tapeVolume += trade.quantity;
  }
  const marketVwap = tapeVolume > 0 ? finiteOrNull(tapeNotional / tapeVolume) : null;

  /* spread / depth / liquidity */
  let spreadSum = 0;
  let spreadCount = 0;
  let depthSum = 0;
  let illiquidTicks = 0;
  for (const point of ordered) {
    if (point.twoSided) {
      const spread = isFiniteNumber(point.spread)
        ? point.spread
        : point.bid !== null && point.ask !== null && isFiniteNumber(point.bid) && isFiniteNumber(point.ask)
          ? point.ask - point.bid
          : null;
      if (spread !== null && isFiniteNumber(spread) && isFiniteNumber(point.mid) && point.mid !== 0) {
        const spreadBps = (spread / point.mid) * BPS;
        if (Number.isFinite(spreadBps)) {
          spreadSum += spreadBps;
          spreadCount += 1;
        }
      }
    } else {
      illiquidTicks += 1;
    }
    depthSum += (point.bidDepth + point.askDepth) / 2;
  }
  const averageSpreadBps = spreadCount > 0 ? finiteOrNull(spreadSum / spreadCount) : null;
  const averageDepth = ordered.length > 0 ? finiteOr(averageDepthOf(depthSum, ordered.length), 0) : 0;

  /* OFI versus contemporaneous mid return, consecutive two-sided ticks only */
  const ofiSamples: number[] = [];
  const returnSamples: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.tick !== previous.tick + 1) continue;
    if (!previous.twoSided || !current.twoSided) continue;
    const previousMid = previous.mid;
    const currentMid = current.mid;
    if (!isFiniteNumber(previousMid) || !isFiniteNumber(currentMid)) continue;
    if (previousMid === 0 || !isFiniteNumber(current.ofi)) continue;
    const midReturn = currentMid / previousMid - 1;
    if (!Number.isFinite(midReturn)) continue;
    ofiSamples.push(current.ofi);
    returnSamples.push(midReturn);
  }
  const ofiReturnCorrelation = pearson(ofiSamples, returnSamples);

  /* lag-1 autocorrelation of absolute mid returns over consecutive triples only */
  const absoluteReturnSamples: number[] = [];
  const laggedAbsoluteReturnSamples: number[] = [];
  for (let index = 2; index < ordered.length; index += 1) {
    const first = ordered[index - 2];
    const second = ordered[index - 1];
    const third = ordered[index];
    if (second.tick !== first.tick + 1 || third.tick !== second.tick + 1) continue;
    if (!first.twoSided || !second.twoSided || !third.twoSided) continue;
    const firstMid = first.mid;
    const secondMid = second.mid;
    const thirdMid = third.mid;
    if (!isFiniteNumber(firstMid) || !isFiniteNumber(secondMid) || !isFiniteNumber(thirdMid)) continue;
    if (firstMid === 0 || secondMid === 0) continue;
    const previousAbsoluteReturn = Math.abs(secondMid / firstMid - 1);
    const currentAbsoluteReturn = Math.abs(thirdMid / secondMid - 1);
    if (!Number.isFinite(previousAbsoluteReturn) || !Number.isFinite(currentAbsoluteReturn)) continue;
    absoluteReturnSamples.push(previousAbsoluteReturn);
    laggedAbsoluteReturnSamples.push(currentAbsoluteReturn);
  }
  const absoluteReturnAutocorrelation = pearson(absoluteReturnSamples, laggedAbsoluteReturnSamples);

  /* per-role five tick markouts */
  const roleObservations: Record<LabRole, number[]> = { maker: [], noise: [], informed: [], parent: [] };
  const roleById = new Map<string, LabRole>();
  for (const account of accounts) {
    if (!roleById.has(account.id)) roleById.set(account.id, account.role);
  }
  if (!roleById.has(PARENT_ID)) roleById.set(PARENT_ID, 'parent');

  for (const trade of trades) {
    const horizon = pointByTick.get(trade.tick + MARKOUT_HORIZON_TICKS);
    if (horizon === undefined || !horizon.twoSided) continue;
    const horizonMid = horizon.mid;
    const price = trade.price;
    if (!isFiniteNumber(horizonMid) || !isFiniteNumber(price) || price <= 0) continue;
    const buyerMarkout = ((horizonMid - price) / price) * BPS;
    if (!Number.isFinite(buyerMarkout)) continue;
    const buyerRole = roleById.get(trade.buyer);
    const sellerRole = roleById.get(trade.seller);
    if (buyerRole !== undefined) roleObservations[buyerRole].push(buyerMarkout);
    if (sellerRole !== undefined && trade.seller !== trade.buyer) {
      roleObservations[sellerRole].push(-buyerMarkout);
    }
  }

  const roleMarkouts = ROLES.map((role) => {
    const samples = roleObservations[role];
    let sum = 0;
    for (const value of samples) sum += value;
    return {
      role,
      trades: samples.length,
      fiveTickMarkoutBps: samples.length > 0 ? finiteOrNull(sum / samples.length) : null,
    };
  });

  return {
    requested,
    filled,
    fillRatio: !baseline && requested > 0 ? finiteOr(filled / requested, 0) : 0,
    averagePrice,
    fees,
    arrivalPrice,
    terminalPrice,
    executionCostBps,
    opportunityCostBps,
    implementationShortfallBps,
    marketVwap,
    averageSpreadBps,
    averageDepth,
    illiquidTicks,
    ofiReturnCorrelation,
    absoluteReturnAutocorrelation,
    roleMarkouts,
  };
}

function averageDepthOf(total: number, count: number): number {
  if (count <= 0) return 0;
  return total / count;
}

/* ------------------------------------------------------------------ */
/* policy comparison                                                   */
/* ------------------------------------------------------------------ */

/**
 * Signed impact of each execution policy against the baseline tape.
 *
 * Note: these are post-execution *simulated paired-path* statistics. Two deterministic
 * replays are compared tick by tick, so the difference is a model artefact of running a
 * different policy, not measured real-world causality.
 */
export function compareLabReports(reports: Record<LabPolicy, LabReport>): LabComparison[] {
  const rawReports = asObject(reports);
  if (rawReports === null) fail('reports must be a record of policy reports');
  const baseline = reports.baseline;
  const rawBaseline = asObject(baseline);
  if (rawBaseline === null) fail('reports.baseline is required');
  if (!Array.isArray(baseline.points)) fail('reports.baseline.points must be an array');

  const baselineByTick = indexByTick(sortPoints(baseline.points));
  const comparisons: LabComparison[] = [];

  for (const policy of COMPARED_POLICIES) {
    const report = reports[policy];
    const rawReport = asObject(report);
    if (rawReport === null) fail(`reports.${policy} is required`);
    if (!Array.isArray(report.points)) fail(`reports.${policy}.points must be an array`);

    const side = report.config !== undefined && report.config !== null ? report.config.side : baseline.config.side;
    const direction = side === 'sell' ? -1 : 1;
    const ticks = report.config !== undefined && report.config !== null && isFiniteNumber(report.config.ticks)
      ? report.config.ticks
      : 0;

    const samples: { tick: number; impact: number }[] = [];
    for (const point of sortPoints(report.points)) {
      const reference = baselineByTick.get(point.tick);
      if (reference === undefined) continue;
      if (!point.twoSided || !reference.twoSided) continue;
      const mid = point.mid;
      const referenceMid = reference.mid;
      if (!isFiniteNumber(mid) || !isFiniteNumber(referenceMid) || referenceMid === 0) continue;
      const impact = ((direction * (mid - referenceMid)) / referenceMid) * BPS;
      if (!Number.isFinite(impact)) continue;
      samples.push({ tick: point.tick, impact });
    }
    samples.sort((left, right) => left.tick - right.tick);

    /* peak: largest signed excursion once the execution window has started */
    const peakStart = Math.floor(ticks * PEAK_WINDOW_FRACTION);
    let peakImpactBps = 0;
    let peakMagnitude = -1;
    for (const sample of samples) {
      if (sample.tick < peakStart) continue;
      const magnitude = Math.abs(sample.impact);
      if (magnitude > peakMagnitude) {
        peakMagnitude = magnitude;
        peakImpactBps = sample.impact;
      }
    }

    /* terminal: the last matched pair */
    const terminalImpactBps = samples.length > 0 ? samples[samples.length - 1].impact : null;

    /* recovery half-life inside the post-execution tail */
    const recoveryStart = Math.floor(ticks * RECOVERY_WINDOW_FRACTION);
    let recoveryHalfLifeTicks: number | null = null;
    let referenceIndex = -1;
    let referenceMagnitude = -1;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample.tick < recoveryStart) continue;
      const magnitude = Math.abs(sample.impact);
      if (magnitude > referenceMagnitude) {
        referenceMagnitude = magnitude;
        referenceIndex = index;
      }
    }
    if (referenceIndex >= 0) {
      if (referenceMagnitude <= 0) {
        recoveryHalfLifeTicks = 0;
      } else {
        const half = referenceMagnitude / 2;
        for (let index = referenceIndex + 1; index < samples.length; index += 1) {
          if (Math.abs(samples[index].impact) <= half) {
            recoveryHalfLifeTicks = samples[index].tick - samples[referenceIndex].tick;
            break;
          }
        }
      }
    }

    comparisons.push({
      policy,
      peakImpactBps: peakMagnitude >= 0 ? finiteOrNull(peakImpactBps) : null,
      terminalImpactBps,
      recoveryHalfLifeTicks,
    });
  }

  return comparisons;
}
