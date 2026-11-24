import gameTables from './game-tables.json';

interface SchemaDatabase { prepare(query: string): { all(): Array<{ name: string }> } }

/** Fail before ORM synchronization if a production process receives website secrets. */
export function assertGameEnvironment(env: Record<string, string | undefined>, production: boolean): void {
    if (!production) return;
    const sitePrefixes = /^(IDENTITY_|BLOG_|CHAT_|RESOURCES?_|RESEND_|TURNSTILE_|ARCADE_|SAVES_|GAME_SAVES_|OAUTH_)/;
    const siteNames = new Set(['APP_BASE_URL', 'COOKIE_DOMAIN', 'COOKIE_SECURE', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']);
    const unexpected = Object.keys(env).filter(key => env[key] && (sitePrefixes.test(key) || siteNames.has(key)));
    if (unexpected.length) throw new Error('Game process received site-only configuration; use an isolated .env.game: ' + unexpected.join(', '));
}

/** SQLite schema inspection only: never reads a user's credential or account records. */
export function assertGameDatabase(database: SchemaDatabase, production: boolean): void {
    if (!production) return;
    const allowed = new Set([...gameTables, 'migrations', 'typeorm_metadata']);
    const unexpected = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map(row => row.name).filter(name => !name.startsWith('sqlite_') && !allowed.has(name));
    if (unexpected.length) throw new Error('Game database contains tables outside the game boundary; export an isolated game database before cutover: ' + unexpected.join(', '));
}

/** TypeORM invokes this before schema synchronization and service initialization. */
export function prepareGameDatabase(database: SchemaDatabase & { close(): void }, production: boolean): void {
    try { assertGameDatabase(database, production); }
    catch (error) { database.close(); throw error; }
}
