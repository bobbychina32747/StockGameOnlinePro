**English** | [中文](README.zh.md)

# StockSim Pro — Stock Trading Simulation

[![Release](https://img.shields.io/github/v/release/bobbychina32747/StockGameOnlinePro?label=Release&color=2f6fed)](https://github.com/bobbychina32747/StockGameOnlinePro/releases)
[![Changelog](https://img.shields.io/badge/Changelog-Keep%20a%20Changelog-8251EE)](CHANGELOG.md)
[![License](https://img.shields.io/badge/License-PolyForm%20Noncommercial-10b981)](LICENSE)
[![Last Commit](https://img.shields.io/github/last-commit/bobbychina32747/StockGameOnlinePro?label=Last%20Commit)](https://github.com/bobbychina32747/StockGameOnlinePro/commits)

## Unified Production Version 2.0 (2026-10-11)

The workbench removes migration notes, developer API explanations, duplicate event panels, slogans, and generic advice. Trading data, errors, and essential trading rules remain. Unsupported short/cover actions are hidden in the China realm, and missing P/E values no longer occupy a placeholder.

Intraday volatility is fitted to real five-minute data and responds to actual minute returns, including news and execution shocks. News activity updates volume, traded value, and all candle intervals together. Ordinary candles include bounded simulated shadows. Existing assets and history remain intact; the changes affect subsequent minutes. See the [realism audit](docs/REALISM-AUDIT-20261013.md) for findings, holdout validation, and remaining limitations.

**Public beta reset, 2026-10-12:** accounts, passwords, site-account links, and fixed realm character IDs were retained. Beta positions, orders, funds, debt, seasons, market history, and AI state were cleared. Each realm character received 100,000 in initial funds. The server retains the previous databases for rollback; blog data and cloud saves for other games were preserved. This reset supersedes the asset-preservation policy used during the earlier merge.

Production uses `TICK_INTERVAL_MS=60000` and `SANDBOX_FAST=false`: one real minute advances one trading minute. Continuous simulation can run throughout the day, but closed sessions no longer trigger automatic second-by-second playback. One simulated China trading day takes 240 minutes. Startup loads bounded caches per instrument instead of scanning or deleting the full candle archive. Repeated writes retain the same candle ID. See the [beta reset and rollback guide](docs/PUBLIC-BETA-RESET-20261012.md).

News, macroeconomic releases, and earnings shocks share the daily price-limit checks. They update minute, five-minute, and daily candles, plus daily highs and lows. Volatility and trend signals use actual returns after price limits; blocked moves do not accumulate fictitious momentum. Overnight events apply after the close, while the previous close remains the actual closing price. See the [price-boundary regression](docs/MARKET-BOUNDARY-REGRESSION-20261012.md), which covers four scenarios of 30 trading days each.

Joint price-volume calibration uses 350,111 daily bars, 173,865 five-minute bars, 95,314 China traded-value/turnover records, and 24,546 observations of interest rates, exchange rates, oil prices, and credit spreads. It covers 69 sector/market combinations. Volume responds to absolute returns, persistent activity, and each market's intraday pattern. Earnings can cause bounded volume pulses, and market-maker depth responds to simulated activity. The production API exposes traded value and estimated simulated turnover. Higher volume is not treated as a bullish signal. In the volume-seasonality holdout test, 68 of 69 stocks improved over the previous model, with a median error reduction of about 57%. See the [price-volume and liquidity report](docs/MARKET-MICROSTRUCTURE-20261012.md) for methods, data gaps, and full results.

The intraday chart displays one-minute candles. Recent five-minute candles aggregate the same minute data, keeping open, high, low, close, and volume consistent. Earlier complete five-minute history remains available; a partial bucket at the beginning of the bounded minute cache does not overwrite a complete historical candle. Zoom and replay remain available in the workbench.

When a runtime snapshot exists, restart restores the market state directly instead of generating another random historical path. Active one-minute and five-minute candles persist with the snapshot. Repeated saves reuse their records, so intraday history does not depend solely on end-of-day settlement.

An initial rebuild generates 30 trading days with the joint price-volume model. Warm-up uses 240 minutes for China, 330 for Hong Kong, and 390 for the US. Minute and five-minute runtime windows, daily bars, and the initial snapshot persist in batches. Repeated beta resets use separate backup directories and preserve accounts, realm bindings, and other application data.

Sector feedback is scaled per minute, with cumulative daily transmission capped at 0.5%. It respects China price limits and synchronizes candles. Restart uses the latest close as the previous-close baseline. Ordinary stocks receive an intrinsic value so AI valuation guards can operate.

Factor signals become bounded daily drift, and valuation reversion has a limited rate. The market maker's normal total bid-ask spread is about 0.28%; inventory skew is normalized against inventory limits. Value strategies keep their valuation guards, while confirmed trend strategies can take small positions in expensive stocks. Market and AI ledgers persist to the original SQLite volume every 30 seconds and at each day-end. Restart restores cash, cost basis, losses, and the market clock. Rankings show status and actual execution counts. See the [multi-day market regression](docs/AI-MARKET-REGRESSION-20261011.md).

**Game entry point: [game.bobbycn.cc](https://game.bobbycn.cc/).** The 2.0 workbench and original production game share one production system. The merge initially retained original account UUIDs, cash, positions, debt, funds, open orders, executions, and seasons; the beta reset described above later replaced the financial state. Test assets were archived separately and never added to production principal. `/remaster/` redirects to the unified version.

- The original production ledger and matching engine remain the authoritative core. The 2.0 workbench provides charts, bottom navigation, fixed realm sessions, replay, persistent zoom, and two-decimal prices.
- The base catalog contains 414 fictional stocks: three realms, each with 23 sectors and six stocks per sector. Existing legacy stocks and listed IPOs are also supported. Each account can have one character in each realm. Characters cannot change realm, trade across realms, or transfer assets between them.
- The original market integrates sector calibration, heavy tails, conditional volatility, and intraday activity from 2.0. Macroeconomics, earnings, news drift, AI, market makers, and trading restrictions continue to operate. The initial calibration used 173,066 real daily bars, 15,591 five-minute bars, and 28 announcement events. Historical association does not establish causation.
- Site-account login and game username/password login resolve to the same original game user. An unlinked site identity can bind an existing game account.
- Funds, margin borrowing, stock-borrow information, earnings surprises, order flow, seasons, performance, achievements, and reviews remain available. Production preflight uses the original engine's fees and validation. Research backtests are separate simulations and do not count as production account performance.

See the [merge design](docs/UNIFIED-FORMAL-20261011.md) for architecture, asset policies, and rollback boundaries, and the [initial realism report](docs/MARKET-REALISM-20261010.md) for calibration methods. Player databases, credentials, and raw collected market data are not stored in the repository.

AI opponents manage all positions on each tick, with per-stock and portfolio exposure limits, entry cooldowns, and drawdown pauses. Returns are calculated from their actual simulated assets. See the [AI risk controls](docs/AI-RISK-20261011.md) for strategy changes and controlled comparisons. Profit is not guaranteed for every opponent. Restart restores real simulated cash, costs, and returns rather than resetting losses to zero.

Legacy sector aliases map to 23 standard sectors. Each realm has at least six stocks per sector, and IPOs join their corresponding sector. The workbench supports Simplified Chinese, Traditional Chinese, and English. Company names and player content retain their original text. China quotes show backend-calculated upper/lower price limits and limit status; Hong Kong and US quotes state that there is no daily price limit. Market-risk events and personal trade reviews appear separately.

Market history loads through bounded per-stock caches to avoid loading the entire expanded archive into memory. Complete persisted history and assets remain in SQLite, while minute caches stay within their configured limits.

### Local development

Run both the original backend and the unified workbench adapter with Node.js 22:

```bash
cd backend
npm ci
npm run build
npm start

# In a second terminal, from the repository root:
cd remaster
npm ci
REMASTER_WEB_BASE=/ npm run build
npm run typecheck:web
npm test
npm run start:formal
```

The unified service defaults to `http://127.0.0.1:8321`; the original backend defaults to `http://127.0.0.1:8000`. In Windows PowerShell, set the build base with `$env:REMASTER_WEB_BASE='/'`. Configure the original identity service according to the deployment contract; do not copy production secrets. See [unified-compose.yml](remaster/deploy/unified-compose.yml) for the production containers.

---

## Original Ledger Backend and Legacy Implementation

The following sections describe the legacy `backend/` and `frontend/`. Their features, counts, and launch instructions are historical and do not constitute acceptance results for the unified workbench.

> **BETA:** prices and funds are simulated. They are not investment advice.

An AI-assisted stock-trading simulation built through vibe coding. The legacy goal was a terminal experience comparable to major Chinese retail trading platforms, with a simulated market engine, macroeconomic feedback, sector rotation, news, short selling, margin, and a quantitative API.

The original project notes credit DeepSeek-v4-pro for implementation and AI for the README. They also note that the contributor account was operated by AI.

## Features of the Legacy Implementation

### Market engine: a simulated world

- **Historical 68-stock catalog:** 28 China stocks, 20 Hong Kong stocks, and 20 US stocks. Each market reflects local company themes, such as Hong Kong finance/property/shipping and US technology/blue chips. Instruments include a code, listing date, and company description. The unified catalog is larger, as described above.
- **Charts and history:** intraday, one-minute, five-minute, 60-minute, daily, weekly, and monthly candles; MA/BOLL/RSI indicators; daily history backfilled to each listing date, exceeding 30 years for some legacy stocks; weekly/monthly aggregation; forward-adjusted and unadjusted views for dividend adjustments.
- **Opening call auction:** maximum executable volume determines the opening price within the China price band. Crossing orders execute at that price. China pre-open phases are 09:15–09:20 submission/cancellation, 09:20–09:25 submission without cancellation, and matching at 09:25.
- **Exchange calendars and US daylight saving:** shared CN/HK/US holiday data for 2025–2027. US opening is 21:30 China time during daylight saving and 22:30 during standard time. Sessions crossing midnight use the US Eastern trading date.
- **Overnight gaps:** a shared market shock, including crash nights, scales by stock beta and combines with a stock-specific heavy-tailed shock. China opening gaps respect the ±10% band and can be tagged as limit-up/down openings.
- **Configurable tick rate:** `TICK_INTERVAL_MS=60000` is the default minute pace. A 1,000 ms fast replay requires explicit `SANDBOX_FAST=true`. The legacy status bar labels fast sandbox playback.
- **Macroeconomic factors:** economic conditions, sector conditions, sentiment, and policy risk affect prices through sector sensitivities. Collective stock behavior feeds back into macroeconomic state.
- **Indices:** Shanghai Composite, Shenzhen Component, ChiNext, STAR 50, an entertainment index, Hang Seng, Nasdaq, and Dow Jones. Values use constituent stocks, and index moves affect global sentiment.
- **Sector transmission:** the legacy 32-sector relationship matrix transmits every five minutes in calm periods and immediately after volatile events. A shock in renewable energy can propagate into automotive stocks.
- **Player price impact:** each execution affects price, current-candle volume, and traded value. Large orders can move the market.
- **Hot-sector rotation:** one or two daily themes add momentum over several days; the legacy UI includes a hot-sector strip.
- **Two-sided event shocks:** the legacy event model uses an approximately 3% trigger probability, with 60% negative shocks and 40% positive policy/order/technology events. Shocks can affect the market, a sector, or one stock.
- **Bubble cycles:** sector prices can diverge from intrinsic value. A small sale in an expensive sector can trigger contagion and a return toward intrinsic value. The legacy design exposes no explicit bubble warning.
- **IPOs:** one or two new stocks can list every ten trading days, with elevated first-day volatility.
- **Earnings and dividends:** staggered disclosures occur roughly every 45 game days. Revenue growth, net margin, ROE, and consensus estimates evolve. Five surprise categories affect disclosure-day price changes, five-day post-earnings drift, and consensus revisions. Dividends depend on profitability and include price adjustment and position cash payments.
- **Macro release calendar:** CPI, PMI, central-bank decisions, and employment reports publish on scheduled game days. Consensus surprises transmit through sector sensitivities and can persist for several days.
- **Sector business cycles:** expansion, peak, contraction, and trough evolve as a Markov process and affect revenue, valuations, and volatility.
- **News:** more than 190 templates span early, growth, and mature market phases. Dynamic placeholders extend variety across more than 100 game days. Opening/closing news broadcasts across successive ticks instead of arriving all at once.

### Trading

- **Order-book matching:** resting limit orders use price-time priority. Crossing orders execute at the counterparty price. Market orders consume depth and can fill partially; remaining limit quantity stays queued. Self-trade prevention and cancellations update the visible book.
- **Order types:** market, limit, stop, stop-limit, FOK (fill or kill), IOC (immediate or cancel), and iceberg orders with hidden quantity and replenished display size.
- **Market makers:** two per market quote both sides, using volatility-dependent spreads, inventory skew, and scheduled order replacement.
- **Dynamic slippage:** order-flow imbalance and volatility affect market-order impact. Adverse conditions increase slippage; favorable conditions reduce it. Total slippage is capped at 2%.
- **Short selling and margin in Hong Kong/US:** opening shorts locks collateral with stock-specific factors of 0.50–0.65; covering releases it proportionally. Maintenance ratios trigger warning below 140%, partial liquidation below 130%, and full liquidation below 120%. Interest settles daily.
- **China rules:** T+1 selling and ±10% daily limits. Orders can queue at sealed limits and execute when the market opens away from the limit.
- **Fees:** market-specific simulated commission, stamp duty, levies, and regulatory fees.
- **Independent sessions:** China 09:30–11:30/13:00–15:00, Hong Kong 09:30–12:00/13:00–16:00, and US 21:30–04:00 the next day in China time during daylight saving. Market generation, order validation, and closed-session overlays follow each market's calendar.
- **Legacy cross-market transfers:** currency conversion used CN=1, HK≈0.92, US≈7.12, with a 0.1% fee. The unified game uses fixed realms and does not permit these transfers.

### Legacy interface

- Three columns for stocks, charts, and order book/order entry/account data, with persistent draggable widths.
- Intraday/candle view switching, wheel zoom, and a bottom range slider.
- Historical intraday replay at 1×/4×/16×, with pause/resume and progress controls.
- Optional animated numbers and price flashes, with China-style red-up/green-down colors.
- Stock search, watchlists, sector rankings, and advance/decline counts.
- Company details: code, listing date, reports, dividends, fund flow, and announcements.
- Notifications for executions, news, insider events, and major shocks; activity records, equity curves, achievements, and simulated competitions.
- An AI assistant with MA/RSI signals and spoken price alerts; keyboard shortcuts for stock selection, periods, and navigation.
- Dark/light themes covering chart axes, tooltips, and range sliders; density and animation settings.
- Performance measures: return, Sharpe ratio, maximum drawdown, annualized volatility, Calmar ratio, profitable-day fraction, trade count, equity history, and tiers.
- Mobile layout at widths of 768 px or less, with bottom tabs and touch controls.

### AI opponents

The legacy presentation challenges players to compete with ten named algorithmic opponents that quote, trade, follow themes, and realize losses. Its original interface also includes playful opponent remarks.

- **Ten named opponents:** trend following, mean reversion, momentum, herding, reversal, and noise strategies, including five retail-style characters.
- **Local execution:** rule strategies and eight decision stumps run without external APIs or training dependencies. The legacy README calls this ensemble a local random forest; it is not a trained market-prediction guarantee.
- **Cash and position constraints:** buys require cash and sells require positions. The legacy strategy description includes +5% take-profit and −3% stop-loss rules; the unified risk changes are documented above.
- **Herding:** themes attract AI orders, price feedback can build bubbles, and selling can trigger reversals. Opponents can also suffer losses.
- **Visible performance:** returns, win rates, tiers, and opponent remarks appear in the legacy assistant panel.
- **Order-flow signals:** buying/selling pressure and large institutional/speculative flows provide market activity information.
- **Actual matching participation:** AI executions affect depth, price, and volume, and can fill player orders.
- **Three market instances:** China, Hong Kong, and US have independent engines, sessions, holidays, factors, themes, and events. Accounts and rankings are separate; the legacy UI offers a cross-market board. IPOs originate in China only.
- **Closed-session and debug modes:** the legacy chart shows a closed-market overlay and next opening time. Administrators can enable personal or global off-hours trading.

### Quantitative integration

- REST API and WebSocket streams: [API documentation](docs/API.md).
- Backtests with trading fees, configurable slippage, MA crossover/RSI reversal/momentum strategies, a buy-and-hold benchmark, annualized return, drawdown, Sharpe ratio, and profit factor. The legacy CLI is `node backend/scripts/backtest.js`.
- `backend/scripts/quant-bot.js` provides an executable bot example tested with automated orders.

---

## Legacy Quick Start

Use the unified development instructions above for the production workbench. These commands launch the legacy frontend.

### Option 1: Windows launcher

Double-click `start.bat`. It starts the backend on port 8000, waits for readiness, starts the frontend on port 3000, and opens a browser.

### Option 2: Manual launch

```bash
# Terminal 1: backend
cd backend
npm install
npm run build
npm start

# Terminal 2, from the repository root: legacy frontend
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000` and register a game account.

### Development and quality gates

```bash
# Backend: build, unit tests, and optional sql.js -> better-sqlite3 migration
cd backend
npm run build && npm test -- --runInBand
npm run db:migrate

# Legacy frontend: lint, types, unit tests, and production/PWA build
cd frontend
npm run lint && npx tsc -b && npm test -- --runInBand && npm run build
```

The migration command performs a backup, an integrity check, per-table count verification, and a switch to WAL. The legacy documentation originally listed 368 backend tests and 59 frontend tests; these are historical counts, not the current suite totals.

- **CI:** `.github/workflows/ci.yml` runs on pushes and pull requests, covering backend build/tests/startup smoke checks and legacy frontend lint/types/tests/build.
- **Pre-commit:** `git config core.hooksPath .githooks` enables backend build/tests and legacy frontend lint/type checks on commits.
- **Database driver:** `DB_TYPE=sqlite` uses better-sqlite3 with incremental WAL writes. The legacy `DB_TYPE=sqljs` driver remains available. Both use compatible SQLite file formats; validate migration before switching.

First startup generates listing-date daily history. The legacy description estimates about 250,000 bars and one to two minutes, but generation time depends on the machine and catalog. Later startup restores persisted history. `backend/.env` controls `TICK_INTERVAL_MS`; 60,000 ms is the minute default. `start-fast.bat` explicitly sets `SANDBOX_FAST=true` for fast sandbox replay. Game-day interest, IPOs, and dividends accelerate with that clock.

### Default development account

| Role | Username | Password |
| --- | --- | --- |
| Administrator | `admin` | Set by `ADMIN_PASSWORD`; development fallback is `admin123` when unset. |

The account is created on first startup. Production requires a strong `ADMIN_PASSWORD` of at least eight characters and a strong `JWT_SECRET`; otherwise the backend rejects default administrator creation or startup.

### Legacy markets and rules

The stock counts in this table describe the original catalog, not the unified 414-stock base catalog. Fees are game parameters.

| Market | Settlement | Short selling | Daily limits | Simulated fees |
| --- | --- | --- | --- | --- |
| China (28 legacy stocks) | T+1; next-day selling | No | ±10% | 0.025% commission; 0.1% stamp duty on sells |
| Hong Kong (20 legacy stocks) | T+0 | Yes | None | 0.03% commission, minimum 50; 0.13% stamp duty on sells |
| US (20 legacy stocks) | T+0 | Yes | None | SEC/TAF fees; zero commission |

Legacy accounts have separate cash and positions, with a market selector and currency-converted transfers subject to a 0.1% fee. Unified realm characters cannot change realm or transfer assets across realms.

China-time sessions: China 09:30–11:30/13:00–15:00; Hong Kong 09:30–12:00/13:00–16:00; US 21:30–04:00 the next day during daylight saving, with separate holiday calendars and standard-time adjustment.

---

## Technology

| Layer | Technology |
| --- | --- |
| Backend | NestJS, TypeORM, better-sqlite3, SQLite with incremental WAL writes |
| Frontend | React, Vite, ECharts, Zustand, Socket.IO; unified workbench under `remaster/` |
| Market simulation | Conditional volatility, heavy-tailed jumps, overnight gaps, macro factors, sector feedback, and trend state |
| Matching | Price-time-priority order book, maximum-volume opening auction, and slippage model |
| Real-time transport | WebSocket price/news/execution streams with JWT handshake authentication |

## Repository Layout

```text
backend/
  src/core/          # Market engine, matching engine, risk controls
  src/modules/       # Auth, trading, market, ranking, account, funds
  src/common/        # Stock catalog, factor settings, calibration, news templates
  scripts/           # Quant bot, backtests, migration, calibration checks
frontend/
  src/components/    # Legacy charts, book, order entry, notifications, settings
  src/pages/         # Legacy trading, rankings, activity, backtests, profile
  src/store/         # Zustand state
remaster/
  apps/web/          # Unified production workbench
  apps/game-api/     # Unified ledger adapter and standalone simulation API
  packages/domain/   # Shared simulation types and catalog
  deploy/            # Unified container definitions
docs/
  API.md             # Quantitative integration
  REALISM.md         # Legacy realism gaps and roadmap
```

---

## Beta Status and Historical Roadmap

The project is in beta and continues to evolve. The following checklist records legacy milestones; deployment modes and the unified workbench can differ from these historical defaults.

- [x] Market simulation, matching, macro feedback, indices, news, themes, events, IPOs, and dividends.
- [x] Legacy trading terminal, quantitative API, backtests, and notifications.
- [x] Exchange sessions aligned with local time; weekends and closed-session trading restrictions in normal calendar mode.
- [x] Persistent candles and restored player/market history across restarts.
- [x] Mobile bottom tabs, overlays, and horizontally scrolling index strips.
- [x] Three market instances with independent clocks, factors, events, accounts, and legacy cross-market rankings.
- [x] Institutional/speculative/retail AI participants whose executions affect volume.
- [x] Price-time-priority matching, partial fills, self-trade prevention, FOK, and IOC.
- [x] Opening auctions, China pre-open phases, and limit-price queues.
- [x] Forward adjustment and listing-date daily history.
- [x] CN/HK/US sessions and holiday calendars.
- [x] Margin warning, partial liquidation, full liquidation, and stock-specific collateral factors.
- [x] Legacy currency-converted cross-market transfers.
- [x] Configurable market pace and market-order slippage.
- [x] Staggered news broadcasts and AI cash/position ledgers.
- [x] Performance measures and administrator off-hours trading controls.
- [x] Backtests with fees, slippage, three strategies, buy-and-hold comparison, and risk/performance measures.

The legacy README marked all v0.2.0 planned items complete.

### Historical v0.3.0 plan: trading rules and mobile support

The legacy plan recorded Phase 6 backtesting as merged into `main`, pending the v0.3.0 release.

**Trading-rule milestones:**

- [x] Backtest upgrades: trading fee conventions, slippage, three strategies, benchmark, and performance measures (REALISM #24).
- [x] China closing-price orders during 15:00–15:30 (REALISM #3).
- [x] Float-weighted indices and progressive IPO inclusion (REALISM #12).
- [x] Fund subscription/redemption fees, ETF stamp-duty exemption, and tiered commission (REALISM #17).
- [ ] Explicit stock-borrow renewal (REALISM #15): intentionally out of scope. Borrowing has no fixed expiry, and daily interest includes stock-borrow fees. See [the scope decisions](docs/PHASE-ROADMAP.md).
- [x] Market-specific dividend taxes, including China holding-period bands (REALISM #19).
- [x] Data-driven trade reviews, achievements, and tiers (REALISM #25).
- [x] AI parameter adaptation based on performance and market state (REALISM #20, Phase F).

**Experience and ecosystem milestones:**

- [x] Mobile PWA packaging, offline support, and home-screen installation.
- [x] Build-time PWA precache manifest and bundle-size gates (Phase F).
- [x] Weekly, fortnightly, and monthly competitions, points, and season archives (Phase E).
- [x] Optional browser smoke checks for login, order, cancellation, rankings, and disconnected UI (Phase F).
- [x] English and Traditional Chinese in the unified workbench; this was unfinished in the historical legacy plan.

### Realism gaps

See [REALISM.md](docs/REALISM.md) for the legacy gap list and priorities, and [the 2026-10-13 audit](docs/REALISM-AUDIT-20261013.md) for the latest implementation checks and measured limitations.

### Longer-term directions

- [ ] Optional real market-data sources.
- [ ] Player community and trading competitions.
- [ ] Native mobile app.
- [ ] Real company reports linked with macro release calendars.

Simulated data is for entertainment and learning, not investment advice.

### Deployment security

- **`JWT_SECRET`:** configure a strong secret in `backend/.env`; startup validation rejects weak secrets. See `jwt.strategy.ts`.
- **Default accounts:** `ADMIN_PASSWORD` controls the administrator password. Only `NODE_ENV=development` falls back to `admin123`. Other environments refuse to create a default administrator without a strong password of at least eight characters. Demo-account seeding has similar constraints in `backend/src/infrastructure/database/seed.ts`.
- **WebSocket:** the `/market` gateway requires JWT authentication through handshake `auth.token` and disconnects unauthenticated clients.
- **Database:** do not commit `backend/data/*.db`; these files are ignored. The default better-sqlite3 driver uses WAL. The older sql.js periodic-export path remains for compatibility and rollback.

---

## Versions and Releases

- **Legacy release reference:** [v0.2.0 and release history](https://github.com/bobbychina32747/StockGameOnlinePro/releases), covering order-book matching, auctions, adjustment, exchange sessions, and margin liquidation. This is the release reference from the legacy README; the unified production version is described at the top.
- **Historical next-release plan:** v0.3.0, including the backtesting phase and rule/mobile milestones above.
- **Changelog:** [CHANGELOG.md](CHANGELOG.md) uses Keep a Changelog; `Unreleased` records ongoing changes.
- **Versioning:** semantic versions and Git tags identify releases; GitHub Releases provides notes and downloadable source archives.
- **History:** see the [Releases page](https://github.com/bobbychina32747/StockGameOnlinePro/releases) for published versions.

Feature iterations update the changelog; release size determines whether a new version is published.

## License

**PolyForm Noncommercial License 1.0.0** — see [LICENSE](LICENSE).

- Forking, modification, and personal deployments are allowed under the license.
- Commercial use requires separate authorization.
- Retain copyright and license notices.
