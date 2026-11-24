# Site and StockGame boundary

The 2026-11-10 local change removes personal-site implementations from this repository. The independent site backend is in the sibling local project `E:\Files\bobbycn-site-backend`. This directory is not a package inside the public game repository. No production cutover or player-data migration is implied by this source change.

| Owner | Responsibilities |
| --- | --- |
| Site backend | Identity credentials/sessions/signing keys, OAuth, blog, mail, resources, private line, arcade links, encrypted saves |
| NestJS game core | Game password login, identity-to-game-user mapping, player ledger, matching, risk, market simulation, funds, seasons |
| Go API | Game session transport, HTTP/SSE, snapshot adaptation, command idempotency; forwards financial mutations to the game core |
| Optional Node adapters | Supported compatibility entrypoints with the same split upstream configuration |

The game neither loads site entities nor opens the site database. A nullable unique scalar `users.identityId` preserves the current account binding without importing an identity entity. The `check:boundaries` gate prevents the removed site modules and entities from returning and verifies the seventeen-table game allowlist against its entities and runtime state.

The game loads `.env.game`, not the old combined `.env`. Production rejects site-only environment keys without displaying values. Native SQLite preparation rejects mixed schemas before synchronization; the production database file must already exist. These are native SQLite guards, not a claim that other database drivers have received the same cutover validation.

Site-only OAuth and local-development helpers have also moved to the independent site's `tools/legacy/`. Existing ignored local development databases and key files were not read, moved or deleted. They remain excluded from Git and game container inputs; the Go Dockerfile's root context now has an explicit build-input allowlist. Container execution itself still needs Linux validation.

## Configuration

| Process | Game ledger URL | External site identity URL |
| --- | --- | --- |
| Game core | Local ledger | `SITE_IDENTITY_URL` |
| Go / Node adapter | `REMASTER_IDENTITY_URL` (legacy configuration name) | `REMASTER_SITE_IDENTITY_URL` |

Both identity URLs must be explicit HTTP(S) service origins. Missing site configuration returns 503 for site login and verification; it never falls back to the game database. Native game password login continues independently. Only fixed identity routes can use the separate site upstream; financial requests continue to the ledger.

## Identity protocol

1. The game extracts only the opaque `sid` cookie or explicit session Bearer token.
2. The site's guarded `POST /api/auth/identity/session-context` returns a minimal current session and short Ed25519 access token. The game validates subject/session consistency, issuer, audience, expiry, status and the absence of third-party `client_id` before creating or binding a game user.
3. Each site-token authorization asks the issuer's existing `introspect` endpoint to verify the signature and revocation state. Subject, session and expiry must match the exact token. No positive-active cache is added.
4. Account creation and binding retain the game origin allowlist, transaction, unique mapping and password-proof requirements. Repeated site login does not create another account or grant starting funds again.

Invalid credentials return 401. A rate-limited authority returns 429. Network errors, malformed responses and upstream failures reject authorization with 503. Requests have a five-second bound, a 64 KiB response limit and no redirect or automatic retry. The game stores no site signing key.

## Validation and deployment scope

The backend tests use separate site-fixture and game HTTP listeners and separate in-memory SQLite databases. They check revoked/expired/disabled/mismatched/third-party sessions, unavailable and malformed authorities, hostile origins, repeated mapping, native game login during a site outage, and absence of site tables in the game ledger. Go and Node tests use distinct upstream fixtures to detect crossed requests.

Site module tests moved with their implementations rather than being discarded. They continue in the independent site project. They also exercise the real site's session-context endpoint, Ed25519 token verification, revocation and absence of game tables.

An eventual deployment requires two new database files, each exported by its owner's explicit allowlist from the same immutable combined snapshot. The game exporter preserves users, password hashes, identity bindings, assets, orders, funds, seasons, candles and runtime snapshots. It never selects site credential rows, so old site contents do not survive as free-page remnants in the new game file. Both exporters retain 64-bit integers, IDs, sequences and indexes and refuse overwrites.

Populate separate site and game data volumes. Keep the original combined volume and backups offline; do not mount them in the new game container. The production game override requires an explicitly named game-only volume. Split environment configuration without rotating the existing game JWT secret or site signing/encryption keys, then update content mounts, reverse-proxy routes and service origins together. No real configuration or database has been opened or migrated by these local checks. Keep the existing live service until migration is authorized and validated. Do not reset game accounts or balances. Removing tracked files does not rewrite existing Git history.
