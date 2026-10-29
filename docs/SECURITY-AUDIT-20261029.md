# Security and game audit — 2026-10-29

This audit covers the shared TypeScript backend, the production Go game API, both frontend dependency trees, and the chart/login browser state. It is not a penetration test or a claim that the project has no vulnerabilities.

## Dependency findings

The repository's Dependabot page was inaccessible to the available web session, and the local GitHub CLI returned HTTP 401. The counts below come from `npm audit --package-lock-only --json` against the checked-out lockfiles. They count affected packages, including propagated parent findings, rather than GitHub alerts or unique advisories. Counts across directories overlap.

| Tree | Before: critical / high / moderate / low | After: critical / high / moderate / low |
| --- | --- | --- |
| `backend` | 1 / 6 / 11 / 6 | 0 / 0 / 10 / 6 |
| `frontend` | 0 / 2 / 2 / 6 | 0 / 0 / 0 / 6 |
| `remaster` | 0 / 4 / 6 / 0 | 0 / 0 / 4 / 0 |

The original production backend was checked separately and contained body-parser 1.20.4, multer 2.0.2, bcrypt 5.1.1, and tar 6.2.1. The game API runs Go; the shared identity, market, and asset backend still runs NestJS. Migrating the game adapter did not remove the backend dependency risks.

### Changes

- Pin body-parser 1.20.9 and multer 2.5.0 through overrides in the two Node service trees. Pinning patched dependencies avoids an unreviewed whole-framework migration. The request-parser advisory describes a process crash from trailing data after a compressed request. [GitHub advisory](https://github.com/advisories/GHSA-27r3-jxmh-p828).
- Restrict the actual private-line and resource upload interceptors to flat fields, eight fields, nine multipart parts, and 100-byte field names, retaining their existing file-size limits. Updating Multer alone does not configure the application's nesting policy. [Nested-field advisory](https://github.com/advisories/GHSA-72gw-mp4g-v24j).
- Upgrade bcrypt to 6.0.0, removing the old node-pre-gyp/tar dependency chain. Verify a published legacy `$2a$` compatibility vector and native hashing/comparison. No password hashes are rewritten. The tar alert concerns archive parsing; installed-package severity alone does not establish an exploitable public game route. [Archive-parser advisory](https://github.com/advisories/GHSA-23hp-3jrh-7fpw).
- Update ECharts to 6.1.0 and Vite to 6.4.5 in both UI trees. Patch follow-redirects, lodash, js-yaml, and qs within their corresponding dependency families. Both UI production builds pass; the game workbench is tested in a real browser after the ECharts update.
- Do not disable audit rules, dismiss alerts, run `npm audit fix --force`, downgrade Jest, or treat development-server findings as confirmed public-site exploits.

### Remaining findings

- The backend retains moderate findings in the NestJS 10 dependency family, file-type, ip-address, and uuid; propagated parent packages appear separately in npm's count. The Node compatibility adapter retains four moderate package findings. A supported NestJS-family migration needs separate integration work across the shared identity, upload, blog, and game modules.
- Both Jest trees retain low-severity deepmerge-related findings. npm's suggested Jest downgrade is not adopted as an automatic fix.
- These findings remain open. A successful application test suite does not establish that a vulnerable code path is unreachable. Review remaining advisory conditions and upgrade compatibility before claiming resolution.
- Dependabot state must be checked again with working repository authorization after the lockfiles are pushed. This report does not claim that GitHub has closed its alerts.

## Functional defects reproduced and fixed

- Logout previously waited for the HTTP response before stopping the stream and polling. Delayed responses could allow continued activity or clear a subsequent login. Invalidation now starts immediately, late snapshots are ignored, and completion is scoped to its original session generation. If server-side logout fails, trading remains disabled and the failure is reported; server-side revocation is not falsely claimed.
- Five-second chart polling could overlap ten-second requests. A subscription now has at most one pending history request and ignores results after cleanup.
- Full chart-option replacement discarded legend choices. Refresh now retains the selection and existing zoom for the same stock/period key.
- Order controls and command submission now use one fifteen-second freshness rule, avoiding an enabled order button when the command would reject stale data.

Six executable frontend regressions were added. The five logout/chart cases failed before the fixes and passed afterward. The freshness boundary has a separate test.

## Validation

- TypeScript backend: build and **67 suites / 850 tests** pass, including compressed trailing-byte requests, nested multipart rejection through both real upload interceptors, and bcrypt compatibility.
- Remaster: API/web builds, web typecheck, and **44 tests** pass.
- Legacy frontend: production build and **22 suites / 133 tests** pass.
- Go API: `go test ./... -count=1` and `go vet ./...` pass; the Go implementation was not replaced during this change.
- Real browser with a local synthetic account: slow history requests remain serialized; a completed refresh preserves legend selection and zoom; 1m/5m chart tabs render; stale data disables trading; recovery restores it; logout closes SSE. Desktop/mobile screenshots were inspected. No real player orders or identities are used by this browser test.
- Production read-only baseline: both game containers healthy; market timestamps match their exchange zones; the server can fetch the public game health endpoint with HTTP 200. The local workstation's Cloudflare route intermittently resets, which is distinct from an observed backend outage.

## Deployment boundaries

Only the backend's dependency tree, the two upload interceptor artifacts, and the game frontend assets need updating. The existing Go service, account database, market history, identity keys, role-session store, and player balances are retained. Keep the previous image and static assets for rollback; do not restore an older asset database over later trades.

### Activated release

- Release directory: `/opt/stockgame/releases/security-audit-20261029`.
- Production core image: `sgp-security:20261029`, image ID prefix `cf90caeb9d83`. The previous image is retained as `sgp-before-security:20261029`; the release directory contains `rollback.sh` and the preceding static entry files. Old hashed frontend assets are retained for rollback.
- The image build verifies Linux native SQLite/bcrypt/Argon2 loading and legacy bcrypt compatibility. Its `npm audit --omit=dev` reports **0 critical, 0 high, 10 moderate, 0 low** affected packages.
- After activation, production reports body-parser **1.20.9**, multer **2.5.0**, bcrypt **6.0.0**; legacy tar is absent. The public game health endpoint returns HTTP 200. Both formal containers are healthy with zero restart-loop counts. The existing Go API image is retained.
- Public HTML references the updated frontend assets. No database reset, schema migration, password rewrite, or real-player transaction is part of this release. Staging and unrelated services are not included in this rollout.

Read-only market checks after activation:

| Realm | Stocks | Sectors | Smallest sector | Sampled completed 5m groups | OHLCV mismatches |
| --- | ---: | ---: | ---: | ---: | ---: |
| CN | 146 | 23 | 6 | 10 | 0 |
| HK | 138 | 23 | 6 | 10 | 0 |
| US | 138 | 23 | 6 | 10 | 0 |

These aggregation checks sample one stock per realm, comparing the last ten complete five-minute buckets to their one-minute components, including volume. Each sampled 1m window contains 1,440 bars with valid OHLC bounds and nonnegative volume. They do not prove that every archived candle is correct. The latest morning bars are 11:29 China time and 11:59 Hong Kong time, consistent with their lunch breaks; the completed US session ends at 15:59 New York time.
