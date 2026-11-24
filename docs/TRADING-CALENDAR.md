# Exchange calendar maintenance

Runtime schedules use `backend/src/common/data/exchange-calendar.json`. It is a versioned offline snapshot with the review date, source URLs, full-day closures, half days and a confidence label for each market/year. No network request is required to decide whether trading is open.

`verified` means the listed current/future schedule was checked against the exchange's official source. `rule-derived` identifies Hong Kong 2027: full closures were checked against HKEX calendar entries, while half-day eves use the exchange's published rule. A 2027 annual securities circular was not retrieved. `historical` preserves the existing 2025 compatibility snapshot, including its prior half-day coverage; it does not claim a new historical audit.

The reviewed sources are the [SSE closure schedule](https://www.sse.com.cn/disclosure/dealinstruc/closed/), [HKEX 2026 securities circular](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf), [HKEX calendar](https://www.hkex.com.hk/News/HKEX-Calendar?sc_lang=en), the [HKEX market-data specification covering half-day eves](https://www.hkex.com.hk/eng/prod/dataprod/Documents/MDS3%208%20MDF%20Transmission%20Specification%20v7.8.pdf), and [NYSE regular-session calendars](https://www.nyse.com/trade/hours-calendars).

The old unverified CN 2027 forecast is removed. No verified CN 2027 schedule was retrieved during this check; this does not assert that no official notice exists. Real-time clocks fail closed for missing years and expose `clock.calendar.available=false` rather than silently treating an empty holiday list as a normal trading day. Add a reviewed CN schedule before that year is used. Legacy helpers for the standalone simulated calendar keep their existing semantics.

For a fresh real-time database, minute-history warmup now uses the last thirty completed exchange sessions. It excludes an ongoing session, respects reviewed closures and half-day lengths, and uses exchange-local timestamps instead of the legacy 2024 virtual origin. A restored runtime snapshot is retained without replaying the warmup. Post-close news accumulates in the next opening price; it cannot change the completed session's displayed close or candles.

Existing candle archives are not automatically redated. Older synthetic daily listing history remains an approximate weekday calendar, anchored before the minute window; it is not exchange-verified historical data. Repairing an existing archive requires a separate data review and an explicitly authorized migration.

## Updating the snapshot

Prepare a reviewed JSON file using the current schema, then run from `backend/`:

```sh
node scripts/calendar-data.cjs --update /absolute/path/reviewed-calendar.json
npm run check:calendar
npm run build
npm test -- --runInBand test/calendar-data.test.js test/real-clock.test.js test/sessions.test.js test/constants.test.js
```

The updater validates dates, ordering, duplicates, market/year boundaries, half-day conflicts, confidence labels and official source origins before writing either copy. It synchronizes the frontend JSON. The calendar TypeScript source and JSON must both match byte for byte between backend and legacy frontend; the build and commit checks enforce this.

The backend-only container build uses `--schema-only`, validating the bundled backend snapshot without requiring a frontend directory in that Docker context. The ordinary repository build and CI still perform the full copy check.

Changes to exchange hours, emergency closures or holiday rules still require source review. Format validation does not prove that dates were transcribed correctly. Published cash-equity sessions do not imply support for derivative holiday trading, US extended-hours sessions or bond-market calendars.
