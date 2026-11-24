# StockGame deployment

This directory contains game deployment examples. Personal-site nginx rules, OAuth/server documentation, private-line helpers and portal cache policies now belong to the independent site backend. The previous combined deployment guide is preserved there as `deploy/LEGACY-COMBINED-DEPLOYMENT.md` for migration review.

**The 2026-11-10 source extraction has not changed the live server.** Do not deploy the split game core alone: site login requires the independent site service and coordinated routing. Existing account/asset data remains in place.

## Services and data owners

- NestJS game core: port 8000; game users, accounts, orders, matching, markets, risk, funds and seasons. Its asset database remains the authority for all game mutations.
- Go game API: port 8321; HTTP/SSE, realm sessions and command idempotency. It calls the game ledger; it does not duplicate matching or asset rules.
- Independent site backend: normally port 8010; site identities, sessions, signing keys, blog, mail, resources, private line, arcade links and saves.
- Host reverse proxy: serves the game web build and routes game and identity requests to their respective service.

Keep service listeners private. The examples use loopback host ports; use the existing reviewed Cloudflare/TLS configuration appropriate to the deployment. Do not replace a running server configuration without inspecting it.

## Required identity configuration

| Process | Variable | Meaning |
| --- | --- | --- |
| Game core | `SITE_IDENTITY_URL` | Independent identity service origin reachable from this process/container |
| Go or Node adapter | `REMASTER_IDENTITY_URL` | Existing game-core origin; retained name for compatibility |
| Go or Node adapter | `REMASTER_SITE_IDENTITY_URL` | Independent identity service origin reachable from this process/container |

Origins must be HTTP(S) URLs without credentials, path, query or fragment. An absent identity origin fails site authorization with 503. Game password login remains available. No adapter falls back to a local identity database.

For containers, provide a private shared network or an explicitly reachable host address. `127.0.0.1` inside a container refers to that container. Do not assume that a service bound to the host's loopback address is reachable through the Docker host gateway.

The game reads `.env.game` and the production override requires `SGP_GAME_DATA_VOLUME`, an explicitly populated game-only volume. It does not mount the old combined volume, backups, site signing keys, blog content or blog output. Native SQLite refuses a missing production database or a mixed schema before ORM synchronization. Site-only environment keys are rejected without exposing their values. Supply `SITE_IDENTITY_URL` explicitly for the selected network. Site signing/encryption keys and attachment/content mounts belong only to the site deployment.

## Reverse proxy routes

Route `/api/v2/` to the Go game API, `/api/auth/identity/` to the independent site service, and other game `/api/` and legacy `/socket.io/` routes to the game core. Preserve no-store policies for authentication and private/account data. SSE needs buffering and caching disabled. The identity prefix includes the allowlisted `game-return` handler, so the login callback remains reachable.

`nginx/game.conf` and `frontend/nginx.conf` include a separate identity upstream. These are examples for the coordinated split, not evidence that the live proxy has changed.

## Cutover sequence

1. Review the independent site package, Linux/native dependencies, existing live configuration and private network. Keep the current release and data backups available.
2. Arrange an explicitly authorized write pause and a consistent, immutable combined-database snapshot. Run the site's `scripts/export-site-database.cjs` and the game's `backend/scripts/export-game-database.cjs`, each with an explicit `--source` and new `--output`. Create separate populated data volumes. Compare identities, bindings and game asset counts/values before cutover. Preserve identity/session IDs, OAuth grants, `app_secrets`, `identity_secrets`, signing-key references and content/attachment mounts. Do not reset game users or balances.
3. Start and verify the independent site service with its existing keys and exported database. Check owner login, publishing, mail, resources, private line, arcade binding and encrypted saves.
4. Configure both game identity clients, then switch identity/site proxy routes together with the game core. Native-password login, existing site sessions, mapping idempotency, logout revocation, quotes, order validation and SSE all need validation before opening writes.
5. Keep current data during rollback. An older database backup must not overwrite trades or site changes made after the cutover. Retain the original combined volume and backups offline; never mount them in the game after the separation. Any later deletion of those backups is a separate retention/removal operation.

Local checks include game/site compilation, strict pure-core contracts, calendar provenance/copy validation, finite settlement regressions, independent HTTP authority tests and Go/Node upstream separation tests. Local synthetic validation does not establish that the production data migration or Linux container build has succeeded.

See [the service boundary](../docs/SITE-SEPARATION.md), [site-account protocol](../docs/SITE-GAME-ACCOUNT.md), [production microstructure](../docs/PRODUCTION-MICROSTRUCTURE.md), [calendar maintenance](../docs/TRADING-CALENDAR.md) and [Go deployment notes](../backend-go/README.md).
