# Market microstructure laboratory

[English README](../README.md) · [中文 README](../README.zh.md)

The **Research → Market microstructure laboratory** panel is an isolated, reproducible teaching market. Its initial release is `sgp-microstructure-1`. It makes liquidity, execution cost, information delay, and inventory visible without changing production player assets or the hosted price generator.

## Run an experiment

1. Choose a random seed, number of steps, target shares, and buy/sell direction.
2. Optionally change quote size, refresh interval, public information delay, informed accounts, inventory risk, or the synthetic news shock.
3. Run the comparison. Review **fill rate before execution cost**, then inspect the price, liquidity, flow, and impact charts. Switch the observed policy to examine its role markouts and final ledger.
4. Export the JSON event log. Import it to replay recorded commands rather than regenerate agent decisions. All four report checksums must agree with the file. Cancel or leave Research to terminate the worker.

Steps are artificial decision intervals, not exchange minutes. Experiments use synthetic currency and do not require an open exchange session. The UI runs them in a Web Worker on HTTPS or localhost; it sends no experiment commands to the game API.

## Market and accounts

One asset starts at a reference value of 10,000 cents. Prices and cash use integer cents; share quantities are integers. A midpoint or average fill can contain half/fractional cents as a derived statistic, but settlement does not. The market is continuous, T+0, long only, with market and limit orders. CN settlement, auctions, daily bands, short borrowing, and the production engine's other order types are outside this laboratory.

| Role | Accounts | Initial cash per account | Initial shares per account | Information |
| --- | ---: | ---: | ---: | --- |
| Market maker | 3 | 1,500,000 | 4,000 | Public signal, book, own inventory |
| Noise trader | 6 | 400,000 | 1,500 | Public signal, book, seeded random decisions |
| Informed trader | 0–4 | 500,000 | 2,000 | Current latent value and visible best quotes |
| Parent execution account | 1 | 3,000,000 | Zero for a buy; target quantity for a sell | Preset execution schedule |

Cash figures in the table are currency units, not cents. Accounts cannot borrow cash or sell reserved/unowned shares. Every resting buy reserves its limit price plus a conservative per-share fee allowance; every resting sell reserves its remaining shares. Each participant pays `ceil(price × shares × 5 / 10000)` cents per fill. Fees enter a separate pool. Total cash including that pool and total shares remain constant through trading.

The book matches best price, then event sequence, then identifier. A fill executes at the resting order's price and consumes its actual remaining shares. An incoming order stops if its next counterparty is itself; its unfilled remainder cancels. Market orders never rest or consume fictitious fallback liquidity. New maker orders replenish depth only at explicit refresh events. Order identifiers cannot be reused after a fill or cancellation.

## Value, public information, and market making

A counter-based integer random generator has separate streams for latent value and agent decisions. The seed and stream/tick/actor coordinates determine each draw; execution policies cannot consume each other's random numbers. All four worlds therefore share exogenous value shocks and background random draws, while their books and agent reactions can diverge.

The latent value follows small bounded integer innovations, with one configurable jump at 40% of the experiment. It remains between 5,000 and 15,000 cents. The public signal is this value delayed by the configured number of steps, initially 10,000 cents. Latent-value updates **do not write transaction prices or book quotes**. Informed accounts trade when the current value offers an edge over the visible quote; other decision functions cannot read that private value. They can learn indirectly from quotes produced by other traders.

Each maker cancels its old quotes on a staggered refresh schedule and submits three finite levels on each side. Its center combines public value and visible midpoint, then shifts against its own inventory deviation from the initial target. Quote distance responds to observed public-value changes and a seeded width perturbation. This is an inventory-aware heuristic, **not a solution of the Avellaneda–Stoikov optimal-control problem**. Noise accounts submit a mixture of market and passive orders, with passive orders cancelled after twelve steps. Informed agents have a synthetic information advantage; they are neither trained agents nor users of future prices.

## Execution policies

The execution window starts at `floor(steps × 0.2)` and ends at `floor(steps × 0.7)`. Child orders occur before the end boundary.

| Policy | Behavior |
| --- | --- |
| Baseline | No parent order; all other accounts and external random streams remain present. |
| Lump | One market order for the full target at the start. An unfilled remainder cancels. |
| TWAP | Fifteen equally weighted, evenly spaced market-order slices. Integer rounding preserves the exact planned target. |
| Expected-volume VWAP | Fifteen slices weighted by a preset U-shaped profile `4 + abs(2i − 14)`, for `i = 0…14`. It does not read future realized volume. |

Unfilled child shares are not carried into extra catch-up orders. This is why an incomplete lump order can appear cheap: it did not execute the same quantity. Reports display fill rates and terminal opportunity cost rather than ranking policies by average price alone. A VWAP schedule is not a claim to achieve the realized market VWAP.

## Metric definitions

Let `Q` be requested shares, `F` executed shares, `N` executed notional in cents, `C` parent fees in cents, and `d` be +1 for buying or −1 for selling. `A` is the sampled midpoint just before the execution window. `M` is the final marked midpoint. One basis point is 0.01%.

The sampled midpoint carries the last two-sided midpoint through an empty side, initially 10,000 cents. Such samples are flagged illiquid and plotted as gaps in quote paths. Cost/ledger marks can therefore be stale during a liquidity outage; they are explicit reference marks, not executable prices.

```text
fill rate               = F / Q
execution cost (bp)     = [d × (N − A × F) + C] / (A × F) × 10000
opportunity cost (bp)   = d × (M − A) × (Q − F) / (A × Q) × 10000
implementation shortfall (bp)
                       = [d × (N − A × F) + C
                          + d × (M − A) × (Q − F)] / (A × Q) × 10000
                       = fill rate × execution cost + opportunity cost
```

Execution cost is missing when nothing fills. Opportunity cost can be negative if not executing avoided an adverse price change. The baseline has no requested execution and is not assigned a comparable parent cost. No minimum positive return, artificial P&L credit, or free balancing account is added.

- **Market VWAP:** all actual fill notional divided by actual traded shares; missing without trades.
- **Spread:** mean `(ask − bid) / midpoint × 10000` over two-sided samples. Depth averages the two sides' summed resting shares, not just their best levels. Illiquid ticks count samples without both quotes.
- **Event OFI:** sums best-quote changes after each order insertion, cancellation, and individual fill, including each level consumed by a sweep. An improved bid contributes its new size; a worsened bid removes its old size; at an unchanged bid the size delta contributes. Ask signs are reversed. Empty-side transitions add/remove the corresponding best quantity. Static best-queue imbalance is a separate value and is not relabeled as flow.

The formal research panel also labels its static depth signal **queue imbalance (QI)**. Its historical API field is still named `flow.ofi` for compatibility; that field is not the laboratory's event OFI.

- **OFI/return correlation:** Pearson correlation with contemporaneous one-step midpoint returns, using consecutive two-sided samples only. Absolute-return autocorrelation uses adjacent valid triples. Insufficient or constant samples return missing values, not a fabricated zero.
- **Paired impact:** direction-adjusted policy midpoint minus baseline midpoint, divided by baseline midpoint. Pairs require two-sided quotes. Peak uses the largest absolute excursion after execution begins, retaining its sign. Terminal impact uses the final matched observation. A missing comparison remains missing.
- **Tail recovery half-life:** from the first maximum absolute paired impact in the post-execution tail, find the first later observed magnitude at or below half. Show the step difference, zero for a zero reference magnitude, or “not observed.” This descriptive tail statistic is not an estimated market resilience parameter or a guarantee of exponential recovery.
- **Five-step markout:** a buyer's `(midpoint at fill tick + 5 − fill price) / fill price`, with the opposite sign for a seller, in basis points. An exact, two-sided horizon quote is required. Average each role's valid participant observations equally; the observation count is not shares traded. Markout excludes fees and is not an account return.
- **Terminal mark-to-market P&L:** final cash plus inventory at `M`, less initial cash and initial inventory at 10,000 cents. This includes actual paid fees and the repricing of initial inventory. No missing observations are converted into profits.

## Replay contract

`lab-types.ts` specifies configuration, events, trades, accounts, points, metrics, and exports. A tape contains the model version, policy, complete configuration, and ordered fundamental/public/order/cancel/sample events. Initial accounts are deterministic functions of the configuration. Replay applies those events mechanically to a fresh finite book; it does not rerun random decisions.

SHA-256 covers the canonical report, including tape, fills, points, final accounts, fee pool, and metrics, excluding the digest itself. The export contains all four tapes and their expected report digests. This is an unkeyed integrity/consistency check, **not a signature or proof of authorship**. A file whose commands and expected hashes were both deliberately regenerated can describe a different valid experiment.

Imports reject unknown versions/fields, missing configuration, invalid actors or integer ranges, out-of-order events, missing samples, and digest mismatches. Each tape is capped at 20,000 events; the browser caps an import at 8 MiB, steps at 300, target size at 20,000, and informed accounts at four. The worker is terminated on cancellation, navigation, or a 30-second timeout. Older versions need an explicit version-aware replay implementation if semantics change; do not reuse the version identifier for a different model.

## Code and verification

| File | Responsibility |
| --- | --- |
| `remaster/packages/engine/lab-book.ts` | Finite matching, reservations, settlement, quote-change notifications |
| `remaster/packages/engine/lab.ts` | Seed streams, agent observations/decisions, event generation/replay, validation, checksums |
| `remaster/packages/engine/lab-metrics.ts` | OFI, execution costs, markouts, paired comparisons |
| `remaster/apps/web/src/Laboratory.tsx` | Controls, charts, import/export, worker lifecycle |
| `remaster/apps/web/src/lab-worker.ts` | Bounded compute-only run/replay entry |
| `remaster/tests/lab.test.cjs` | Conservation, finite depth, reservation/fee edge cases, reproducibility and malformed/tampered imports |

Run `npm run verify` from `remaster/`. Browser acceptance also exercises the real worker build, Node/browser digest agreement, download/import, checksum rejection, cancellation/navigation, chart views, English/Chinese labels, and a mobile viewport against synthetic fixtures. Production acceptance checks static asset delivery and API health without player actions.

The [validation artifact](MICROSTRUCTURE-LAB-VALIDATION.json) records the default report digests and metrics, sixty passing remaster tests (sixteen laboratory tests), browser results, a twenty-seed conservation exercise, and a maximum-settings export/replay exercise. These checks verify this implementation's mechanics; they do not validate its financial realism.

## Interpretation and remaining limitations

This experiment enables controlled questions: does a larger order exhaust visible depth; does splitting alter fill rates and shortfall; how do information delay and inventory settings alter spread, inventory, and markouts? Change one parameter while keeping the seed fixed, then repeat across independent seeds before reporting aggregate behavior. Shared random numbers reduce a comparison's random variation; they do not turn a single simulated difference into an empirical causal estimate.

The model has no calibrated Level 2 queue distributions, exchange latency, hidden orders, adaptive learning, strategic news production, fitted jump intensities, or fitted optimal market maker. Latent value remains exogenous. It does not establish real-market volatility clustering, a Kyle lambda, a universal square-root impact law, execution profitability, or a new real-world financial regularity. Existing OHLCV calibration studies concern the hosted price generator and cannot validate this order-book model by transfer.

The distinction between quote-event OFI and static depth follows the mechanism studied by [Cont, Kukanov and Stoikov](https://arxiv.org/abs/1011.6402). Inventory-sensitive quoting is motivated by the problem in [Avellaneda and Stoikov](https://math.nyu.edu/~avellane/HighFrequencyTrading.pdf); the laboratory does not claim to implement or empirically validate either paper's full model.
