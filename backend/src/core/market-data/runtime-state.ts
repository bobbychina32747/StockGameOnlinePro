// One row per realm in the existing SQLite volume; no player or credential data.
export class MarketRuntimeStore {
    private ready = false;
    constructor(private readonly manager: any) {}
    private async init() {
        if (!this.ready) {
            await this.manager.query('CREATE TABLE IF NOT EXISTS market_runtime_state (market TEXT PRIMARY KEY, payload TEXT NOT NULL)');
            this.ready = true;
        }
    }
    async load(market: string) {
        await this.init();
        const rows = await this.manager.query('SELECT payload FROM market_runtime_state WHERE market = ?', [market]);
        return rows.length ? JSON.parse(rows[0].payload) : null;
    }
    async save(market: string, snapshot: any) {
        await this.init();
        await this.manager.query('INSERT INTO market_runtime_state (market,payload) VALUES (?,?) ON CONFLICT(market) DO UPDATE SET payload=excluded.payload',
            [market, JSON.stringify(snapshot)]);
    }
}

export function encodeAiLedger(ledger: any[]) {
    return ledger.map(row => ({ ...row, positions: [...row.positions], restingOrders: [], restingValue: 0,
        treePrediction: null })); // Virtual orders disappear on restart; release their reservations.
}

export function decodeAiLedger(rows: any[], market: string, symbols: Set<string>) {
    if (!Array.isArray(rows) || rows.length !== 10) throw new Error('Invalid AI ledger length');
    return rows.map(row => {
        if (!Number.isFinite(row.cash) || row.cash < 0 || !(row.initialCash > 0) || !Array.isArray(row.positions)) throw new Error('Invalid AI balance');
        for (const [symbol, position] of row.positions) {
            if (!symbols.has(symbol) || !(position.qty > 0) || !(position.cost > 0) || !Number.isFinite(position.qty * position.cost)) {
                throw new Error('Invalid AI position in ' + market);
            }
        }
        return { ...row, positions: new Map(row.positions), restingOrders: [], restingValue: 0, treePrediction: null };
    });
}
