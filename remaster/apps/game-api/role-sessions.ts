import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';

export const REMEMBER_SECONDS = 7 * 24 * 60 * 60;

export class RoleSessions {
  private readonly key: Buffer;
  constructor(private readonly db: any, keyPath?: string) {
    this.key = keyPath ? this.readKey(keyPath) : randomBytes(32);
    db.exec('CREATE TABLE IF NOT EXISTS remembered_roles (digest TEXT PRIMARY KEY, sealed TEXT NOT NULL, expires INTEGER NOT NULL)');
    db.prepare('DELETE FROM remembered_roles WHERE expires <= ?').run(Date.now());
  }
  private readKey(path: string): Buffer {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, randomBytes(32)); } finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const key = readFileSync(path);
    if (key.length !== 32) throw new Error('Invalid role session encryption key');
    return key;
  }
  private digest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  save(token: string, value: unknown, expires: number): void {
    const digest = this.digest(token), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(digest));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    this.db.prepare('INSERT OR REPLACE INTO remembered_roles VALUES (?, ?, ?)').run(digest, sealed, expires);
  }
  load(token: string): any {
    const digest = this.digest(token);
    const row = this.db.prepare('SELECT sealed, expires FROM remembered_roles WHERE digest = ?').get(digest);
    if (!row) return null;
    if (row.expires <= Date.now()) { this.remove(token); return null; }
    try {
      const bytes = Buffer.from(row.sealed, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(digest)); cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
    } catch { this.remove(token); return null; }
  }
  remove(token: string): void { this.db.prepare('DELETE FROM remembered_roles WHERE digest = ?').run(this.digest(token)); }
}
