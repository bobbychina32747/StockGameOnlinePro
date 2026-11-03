# Production microstructure contract

This change applies to the authoritative NestJS continuous matching engine and its Go `/api/v2` adapter. The isolated browser laboratory keeps its `sgp-microstructure-1` replay contract. It is a separate experiment, not a second production ledger.

## Finite execution

`backend/src/core/trading-engine/finite-execution.ts` builds a deterministic, non-mutating execution plan. `matching-engine.ts` applies it to resting player/AI/MM orders and synthetic quotes together, ordered by price, entry time, and sequence. Equal-price iceberg replenishment joins the queue behind existing liquidity. An order cannot trade against its own account.

Prices are normalized to integer cents for notional arithmetic. Quantity, prices, safe-integer notional, input size, and slice count are bounded. The default 10,000-slice cap can stop a very fragmented sweep; `execution.truncated` makes that limit explicit. The planner never substitutes a reference price for missing offers.

- Market: execute the available quantity and cancel the remainder.
- IOC: execute only eligible depth inside the limit and cancel the remainder.
- FOK: require the complete quantity within the limit before any book mutation; otherwise execute nothing.
- Limit: keep the unfilled order pending. An iceberg's aggressive pass is bounded by its display size, and replenished passive slices lose queue priority.
- Liquidation: remove only executed shares. Illiquid positions and their applicable collateral/debt remain outstanding.

For example, asks of 20 shares at 10.01 and 30 shares at 10.02 fill 50 of a requested 100 shares, for exactly 500.80. Another immediate buy sees no remaining ask until a quote changes. Splitting the same request without replenishment cannot create extra supply or change aggregate notional.

Synthetic liquidity is an external, unowned quote source. It is finite between refreshes, but refreshes still use the existing market generator. This production model therefore does not conserve a closed population's global cash/shares, model every cancellation or solve an equilibrium. The laboratory provides a closed synthetic ledger for that different teaching purpose.

## Settlement and rollback

Real-account continuous submissions reserve the affected symbol while settlement runs. Other executions of that symbol cannot consume the reservation; quote changes wait in order. The actual TypeORM repositories settle the taker, real counterparties, execution records and order progress in one database transaction. Counterparty slices from the same order are aggregated before fees and order progress are computed. A failed counterparty or database write rolls back the transaction and restores exact synthetic depth, hidden quantity and queue priority.

Virtual-counterparty callbacks and the taker's market print run after commit. A failed FOK or rolled-back settlement cannot earn AI profits. Counterparty settlement does not publish a second print for the same user-submitted trade. Cash and fees use the plan's exact notional; the rounded four-decimal VWAP is a display value. Market orders now store `clientOrderId` in their execution record. The execution queue rechecks the key after earlier submissions settle, so concurrent duplicate submissions cannot both trade.

This transactional boundary covers the continuous real-account submission/pending-order paths. Opening auctions, after-hours execution, forced-liquidation workflows and AI-initiated ledger callbacks retain their separate settlement workflows; this release does not claim a general transaction spanning those workflows and all in-memory AI state. In-memory repository adapters used by unit tests have no SQL transaction and use prechecks instead. Production must use the real database repositories.

## Preview contract

The existing `POST /api/trading/estimate?mode=...` returns validation plus a `preview` object. Relevant fields are `requestedQuantity`, `filledQuantity`, `remainingQuantity`, `avgPrice`, `totalCost`, `busy`, `waitingForTrigger`, `rejectedFok`, `observedAt`, and `execution`. It never returns maker account/order identifiers.

`execution.model` is `finite-depth-v1`. `referencePrice` is the current market mark; `touchPrice` is the best eligible executed quote, excluding the submitting account; `lastPrice` is the last slice's price. For direction `d=+1` on buy/cover and `d=-1` on sell/short:

```text
depth impact (bp) = d × (VWAP / touchPrice − 1) × 10,000
mark cost (bp)    = d × (VWAP / referencePrice − 1) × 10,000
```

These values exclude fees and describe the observed execution plan. They are not permanent causal impact estimates. The book uses currency units internally. The Go `/api/v2/orders/estimate` adapter converts price/notional fields to cents, exposes `filled`, `remaining`, `total`, `fee`, `depthPreview`, and preserves `estimated=true`: a preview is neither a reservation nor a guarantee of the book at submission. Stops awaiting their trigger and rejected FOK plans report zero immediately executable shares. The ticket refreshes active estimates every three seconds and cancels stale draft responses.

Finite-execution prints set the market's last price to the last matched price, within the existing market price limits. They do not also add the former turnover-based price shock. Price, traded volume/value and current minute/five-minute/daily candles update together. Subsequent exogenous ticks may still move the mark.

## QI and observed event OFI

`order-flow.ts` observes committed best-quote transitions. Static QI remains `(bestBidSize − bestAskSize) / (bestBidSize + bestAskSize)`. The old `flow.ofi` API field remains its compatibility alias; new clients should read `queueImbalance` and `eventOfi` separately.

The event contribution follows the best-quote definition in [Cont, Kukanov and Stoikov](https://arxiv.org/abs/1011.6402):

```text
e = 1(bidNext >= bidPrev) × bidSizeNext − 1(bidNext <= bidPrev) × bidSizePrev
  − 1(askNext <= askPrev) × askSizeNext + 1(askNext >= askPrev) × askSizePrev
```

The observer retains up to 128 changed-quote events per symbol. `netOrderFlow` sums their contributions in shares. Each event's depth is the mean of the four before/after best sizes; `normalizedOfi = sum(e) / sum(eventDepth)`, without clipping, and `averageDepth = sum(eventDepth) / eventCount`. It is a count window, not a time window or executed volume. Unchanged samples add nothing. Missing quotes mark the signal unavailable; restoration establishes a new baseline without inventing flow across the gap. Rejected/rolled-back executions do not enter the observer.

A committed sweep is sampled at its before/after best quotes. Insertions, cancellations and external quote replacements are observed as separate book changes, including synthetic replenishment. This is a partial feed of simulator quote events, not reconstructed real Level 2 data, and not attribution to informed traders. Production and laboratory sampling/empty-side policies differ intentionally; their raw OFI figures must not be compared as identical feeds.

## What remains a model assumption

The production price generator still combines calibrated stochastic factors, news and fundamental drift with actual execution prices. It is not fully endogenous price discovery. Inventory-aware market making and informed/noise agents in the laboratory remain controlled heuristics; the project does not claim to solve Kyle or Avellaneda–Stoikov equilibrium models. Finite-depth execution alone does not establish real-market impact laws, optimal TWAP/VWAP, or calibrated resilience. Historical OHLCV backtests retain their legacy approximate costs because no historical depth tape is supplied.

Run backend compilation and Jest, `go test ./...` under `backend-go`, and the remaster web typecheck/build/tests. The focused backend suites are `finite-execution.test.js`, `finite-settlement.test.js`, and `order-flow.test.js`; they include real SQL.js rollback/fault injection, quote exhaustion, FOK non-mutation, iceberg priority, exact notional, liquidation residuals, and preview equivalence. Production uses the compatible native SQLite repository driver, so deployment also checks the live runtime modules and read-only service health.
