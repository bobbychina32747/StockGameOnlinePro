// These limits apply to the hot cache only. SQLite retains the full candle archive.
export const HISTORY_CACHE_LIMITS = { '1min': 1440, '5min': 1200, daily: 10000 };

export async function persistCandleBatches(repository, rows: any[]) {
    for (let offset = 0; offset < rows.length; offset += 500) {
        // Keep each ORM working set small and retain generated UUIDs for safe retries.
        await repository.save(rows.slice(offset, offset + 500));
        // Let HTTP, WebSocket and timers run between synchronous SQLite batches.
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

export async function restoreHistoryCache(repository, symbols: string[], restore: (symbol: string, rows: any[]) => void) {
    let count = 0;
    // Load one instrument at a time using the existing symbol/timeframe/time index.
    // Never hydrate the entire market's archive into JavaScript objects.
    for (const symbol of symbols) {
        const rows = [];
        for (const [timeframe, take] of Object.entries(HISTORY_CACHE_LIMITS)) {
            const recent = await repository.find({ where: { symbol, timeframe }, order: { time: 'DESC' }, take });
            rows.push(...recent.reverse());
        }
        if (rows.length) {
            restore(symbol, rows);
            count += rows.length;
        }
    }
    return count;
}
