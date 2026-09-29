import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KeyObject, createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

// Ed25519 密钥与 JWKS（阶段一：跨服务统一身份）。
//
// 为什么自带一套密钥服务，而不是用 @nestjs/jwt：
//  1) 既有 AuthModule 的 JWT 用 HS256 对称密钥，**子域/Worker 校验必须拿到同一把密钥** ⇒ 密钥扩散；
//     Ed25519 是「私钥签、公钥验」，公钥可以随便公开，正好适合"一次登录、异地验签"。
//  2) 少一个依赖、少一处版本漂移，Node 内置 crypto 已完全够用。
//
// 硬要求：**私钥缺失不得让应用启动失败**（身份服务不可用不能拖垮全站）——
// 加载失败只降级为「不签发令牌」：jwks 给空 set，exchange 返回 503。

/** 部署机约定的默认私钥路径（systemd 环境变量未配置时使用） */
export const DEFAULT_KEY_FILE = '/opt/stockgame/keys/identity-ed25519.pem';
/** 公钥 JWK 的固定字段（Ed25519 → OKP/Ed25519，签名用途） */
export const SIGNING_ALG = 'EdDSA';

/** 运行期重新扫描密钥的最小间隔：让"密钥后补到位"和"目录里新增 *.pub.pem"能自愈，又不至于每请求都读盘 */
const RESCAN_INTERVAL_MS = 30_000;

export interface JwkPublicKey {
    kty: 'OKP';
    crv: 'Ed25519';
    use: 'sig';
    alg: 'EdDSA';
    kid: string;
    /** 裸公钥（32 字节）的 base64url —— RFC 8037 规定的 Ed25519 JWK 形式 */
    x: string;
}

interface PublishedKey {
    kid: string;
    publicKey: KeyObject;
    origin: string;
}

/** 环境变量里的 PEM 常被写成单行（`\n` 转义），这里还原成真换行，省得部署脚本踩坑 */
function normalizePem(value?: string | null): string {
    const raw = String(value || '').trim();
    if (!raw)
        return '';
    if (raw.includes('\\n') && !raw.includes('\n'))
        return raw.replace(/\\n/g, '\n').trim();
    return raw;
}

@Injectable()
export class KeysService implements OnModuleInit {
    private readonly logger = new Logger('IdentityKeys');

    /** 密钥来源：默认进程环境变量；单测可覆写成受控对象，避免污染真实环境 */
    env: NodeJS.ProcessEnv = process.env;

    private signingKey: KeyObject | null = null;
    private signingKid: string | null = null;
    /** kid → 公钥；轮换期同时含新旧键（发布多把，签发只用 signingKey） */
    private published = new Map<string, PublishedKey>();
    /** 降级日志只打一次（缺密钥是常态化的部署状态，不能每请求刷屏） */
    private degradeLogged = false;
    private lastScanAt = 0;

    onModuleInit(): void {
        this.reload(); // 绝不抛出：加载失败只降级
    }

    // ───────────────────────── 加载 / 轮换 ─────────────────────────

    /**
     * 重新扫描密钥（启动时 + 运行期热轮换 + 自愈重试）。
     * 私钥来源优先级：IDENTITY_JWT_PRIVATE_KEY（PEM 内联）→ IDENTITY_JWT_KEY_FILE（默认 /opt/stockgame/keys/identity-ed25519.pem）。
     */
    reload(): void {
        this.lastScanAt = Date.now();
        try {
            const source = this.resolvePrivatePem();
            if (!source) {
                this.degrade('未找到 Ed25519 私钥：身份令牌签发已禁用（其它功能不受影响）');
                return;
            }
            const privateKey = createPrivateKey(source.pem);
            if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
                this.degrade(`私钥格式不符（需要 Ed25519 私钥，实际 ${privateKey.type}/${privateKey.asymmetricKeyType}）：来源 ${source.origin}`);
                return;
            }
            // 从私钥 PEM 直接导出对应公钥（Node 会做公私钥配对推导，不需要另存一份公钥文件）
            const publicKey = createPublicKey(source.pem);
            const kid = kidOf(publicKey);

            const published = new Map<string, PublishedKey>();
            published.set(kid, { kid, publicKey, origin: source.origin });
            for (const extra of this.loadPreviousKeys(kid))
                published.set(extra.kid, extra);

            this.signingKey = privateKey;
            this.signingKid = kid;
            this.published = published;
            this.degradeLogged = false;
            this.logger.log(`Ed25519 密钥已加载：kid=${kid}（来源 ${source.origin}），JWKS 共 ${published.size} 把公钥`);
        }
        catch (e: any) {
            this.degrade(`Ed25519 密钥加载失败：${e && e.message ? e.message : String(e)}`);
        }
    }

    /**
     * 旧公钥来源（轮换期必须继续可验旧令牌）：
     *  1) IDENTITY_JWT_PREV_KEYS = JSON 数组 [{kid, publicPem}, ...]；
     *  2) 密钥目录里额外的 *.pub.pem（约定「先放新私钥、旧私钥转存为 *.pub.pem 留验」）。
     * 单条坏数据只跳过该条：轮换现场不该因为一把旧公钥写错就整段降级。
     */
    private loadPreviousKeys(currentKid: string): PublishedKey[] {
        const found = new Map<string, PublishedKey>();

        const rawPrev = String(this.env.IDENTITY_JWT_PREV_KEYS || '').trim();
        if (rawPrev) {
            try {
                const parsed = JSON.parse(rawPrev);
                for (const item of Array.isArray(parsed) ? parsed : []) {
                    const pem = normalizePem(item && (item.publicPem || item.pem));
                    if (!pem) {
                        this.logger.warn('IDENTITY_JWT_PREV_KEYS 有一项缺少 publicPem，已跳过');
                        continue;
                    }
                    const publicKey = createPublicKey(pem);
                    const kid = String((item && item.kid) || '').trim() || kidOf(publicKey);
                    if (kid === currentKid || found.has(kid))
                        continue;
                    found.set(kid, { kid, publicKey, origin: 'env:IDENTITY_JWT_PREV_KEYS' });
                }
            }
            catch (e: any) {
                this.logger.warn(`IDENTITY_JWT_PREV_KEYS 不是合法 JSON，已忽略：${e && e.message ? e.message : String(e)}`);
            }
        }

        for (const file of this.listPublicKeyFiles()) {
            try {
                const publicKey = createPublicKey(readFileSync(file, 'utf8'));
                const kid = kidOf(publicKey);
                if (kid === currentKid || found.has(kid))
                    continue;
                found.set(kid, { kid, publicKey, origin: `file:${file}` });
            }
            catch (e: any) {
                this.logger.warn(`公钥文件不可用，已跳过：${file}（${e && e.message ? e.message : String(e)}）`);
            }
        }

        // 按 kid 排序：JWKS 响应体与 ETag 必须稳定（同一组密钥永远同一个哈希）
        return [...found.values()].sort((a, b) => (a.kid < b.kid ? -1 : a.kid > b.kid ? 1 : 0));
    }

    private listPublicKeyFiles(): string[] {
        const dir = dirname(this.keyFilePath());
        try {
            if (!existsSync(dir))
                return [];
            return readdirSync(dir)
                .filter((name) => name.endsWith('.pub.pem'))
                .map((name) => join(dir, name))
                .sort();
        }
        catch {
            return [];
        }
    }

    private keyFilePath(): string {
        return String(this.env.IDENTITY_JWT_KEY_FILE || DEFAULT_KEY_FILE);
    }

    private resolvePrivatePem(): { pem: string; origin: string } | null {
        const inline = normalizePem(this.env.IDENTITY_JWT_PRIVATE_KEY);
        if (inline)
            return { pem: inline, origin: 'env:IDENTITY_JWT_PRIVATE_KEY' };
        const file = this.keyFilePath();
        if (!existsSync(file))
            return null;
        return { pem: readFileSync(file, 'utf8'), origin: `file:${file}` }; // 只读文件，绝不回写/打印内容
    }

    private degrade(reason: string): void {
        this.signingKey = null;
        this.signingKid = null;
        this.published = new Map();
        if (!this.degradeLogged) {
            this.degradeLogged = true;
            this.logger.error(`${reason}——/api/auth/identity/token 将返回 503，jwks 为空 set（应用继续运行）`);
        }
    }

    /** 密钥可能"后补到位"：隔一段时间自愈重扫一次，省得为了一次部署重启整个后端 */
    private maybeRescan(): void {
        if (Date.now() - this.lastScanAt >= RESCAN_INTERVAL_MS)
            this.reload();
    }

    // ───────────────────────── 对外能力 ─────────────────────────

    isReady(): boolean {
        this.maybeRescan();
        return !!this.signingKey && !!this.signingKid;
    }

    currentKid(): string | null {
        this.maybeRescan();
        return this.signingKid;
    }

    /** 用当前私钥签名（Ed25519 无预哈希，算法参数必须是 null） */
    sign(data: Buffer): Buffer {
        if (!this.signingKey)
            throw new Error('Ed25519 私钥未加载，无法签发令牌');
        return cryptoSign(null, data, this.signingKey);
    }

    /** 验签用：kid → 公钥（含轮换期旧键）；未知 kid 返回 null */
    publicKeyFor(kid: string): KeyObject | null {
        this.maybeRescan();
        const hit = this.published.get(String(kid || ''));
        return hit ? hit.publicKey : null;
    }

    /**
     * JWKS 文档（RFC 8037：OKP / Ed25519 / use=sig / alg=EdDSA）。
     * 同时返回稳定序列化的 body 与内容哈希 ETag —— 由 controller 直接落响应头，避免重复序列化。
     */
    jwks(): { keys: JwkPublicKey[]; body: string; etag: string } {
        this.maybeRescan();
        const keys: JwkPublicKey[] = [];
        const current = this.signingKid;
        if (current) {
            const ordered = [current, ...[...this.published.keys()].filter((kid) => kid !== current).sort()];
            for (const kid of ordered) {
                const entry = this.published.get(kid);
                if (!entry)
                    continue;
                const jwk = toJwk(entry.publicKey, kid);
                if (jwk)
                    keys.push(jwk);
            }
        }
        // 私钥缺失时故意发布空 set：没有当前签名身份时，散播旧公钥只会让下游误判"身份服务可用"
        const body = JSON.stringify({ keys });
        return { keys, body, etag: `"${createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)}"` };
    }
}

/** kid = 公钥 DER(SPKI) 的 sha256 前 16 位 hex：由公钥内容决定，重新加载/换机器都复现同一 kid */
export function kidOf(publicKey: KeyObject): string {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/** 由 Node 直接导出 JWK（不手写 ASN.1 解析）；x 就是裸公钥的 base64url */
function toJwk(publicKey: KeyObject, kid: string): JwkPublicKey | null {
    try {
        const jwk = publicKey.export({ format: 'jwk' }) as any;
        if (!jwk || jwk.kty !== 'OKP' || typeof jwk.x !== 'string')
            return null;
        return { kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: SIGNING_ALG, kid, x: jwk.x };
    }
    catch {
        return null;
    }
}
