import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

// 限流维度：IP 与账号各一组，任一命中即拦（规格：登录/注册/重置/认领按 IP + 账号双维度）
export type RateLimitDimension = 'ip' | 'account';

interface Bucket {
    /** 窗口内的尝试时间戳（滑动窗口，做"洪水式枚举"的体量拦截） */
    hits: number[];
    /** 连续失败次数（跨窗口累计，直到成功或锁定期满） */
    strikes: number;
    /** 锁定截止时间戳；0 = 未锁定 */
    lockedUntil: number;
    /** 累计触发锁定的次数（决定下一次锁多久：递增惩罚） */
    lockCount: number;
    /** 最后一次更新时间（惰性清理判据） */
    updatedAt: number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 限流器：内存 Map 实现（单进程部署够用；多实例部署需换 Redis，见 README 待办）。
// 独立成 service 的原因：这部分逻辑要能脱离 HTTP/Nest 上下文单测（规格第 6 条）。
@Injectable()
export class RateLimitService implements OnModuleDestroy {
    private readonly logger = new Logger(RateLimitService.name);

    // 常量做成实例字段：单测可直接覆写（与既有 auth.service 的 LOGIN_MAX_FAILS 同款做法），
    // 不必为了测试把阈值塞进构造函数或环境变量。
    /** 连续失败达到该次数即锁定 */
    MAX_STRIKES = 5;
    /** 首次锁定时长；每多锁一次翻倍（短时锁定 + 递增惩罚） */
    LOCK_BASE_MS = 60 * 1000;
    LOCK_MAX_MS = 15 * 60 * 1000;
    /** 失败后的递增延迟：第 n 次失败等待 BASE * 2^(n-1)，上限 MAX */
    BASE_DELAY_MS = 250;
    MAX_DELAY_MS = 4000;
    /** 滑动窗口内允许的尝试次数（拦"高频猜邮箱"这类体量攻击，而非失败次数） */
    WINDOW_MS = 5 * 60 * 1000;
    MAX_HITS_IN_WINDOW = 30;
    /** 键数量上限：超过即清理，避免被伪造 IP/邮箱刷爆内存 */
    MAX_KEYS = 5000;
    /** 定期清理间隔 */
    SWEEP_INTERVAL_MS = 60 * 1000;

    private buckets = new Map<string, Bucket>();
    private timer: NodeJS.Timeout | null = null;

    constructor() {
        this.timer = setInterval(() => this.sweep(), this.SWEEP_INTERVAL_MS);
        // unref：清理定时器不阻止进程退出（否则 jest 跑完会挂着不结束）
        this.timer.unref?.();
    }

    onModuleDestroy() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }

    /** 当前记录条数（单测用来观察清理行为） */
    get size(): number {
        return this.buckets.size;
    }

    key(action: string, dimension: RateLimitDimension, value: string): string {
        return `${action}|${dimension}|${value}`;
    }

    /** 双维度键（值为空则不建键：例如无 IP 的场景） */
    private keysFor(action: string, ip?: string, account?: string): string[] {
        const keys: string[] = [];
        // IP/账号一律小写归并：避免 a@x.com 与 A@X.com 各记一份而绕过锁定
        if (ip)
            keys.push(this.key(action, 'ip', String(ip).toLowerCase()));
        if (account)
            keys.push(this.key(action, 'account', String(account).toLowerCase()));
        return keys;
    }

    private bucketOf(key: string): Bucket {
        let bucket = this.buckets.get(key);
        if (!bucket) {
            bucket = { hits: [], strikes: 0, lockedUntil: 0, lockCount: 0, updatedAt: Date.now() };
            this.buckets.set(key, bucket);
            this.enforceKeyCap();
        }
        return bucket;
    }

    /**
     * 放行判定：锁定中或窗口内尝试过多则抛 429。
     * 调用时机在「任何查库/哈希之前」——锁定期内不做 IO、不跑 argon2（省 CPU 且不可被计时旁路）。
     */
    assertAllowed(action: string, ip?: string, account?: string): void {
        const now = Date.now();
        for (const key of this.keysFor(action, ip, account)) {
            const bucket = this.buckets.get(key);
            if (!bucket)
                continue;
            if (bucket.lockedUntil > now)
                throw this.locked(bucket, now);
            if (bucket.lockedUntil > 0)
                bucket.lockedUntil = 0; // 锁定期满：惰性解除
            bucket.hits = bucket.hits.filter((t) => now - t < this.WINDOW_MS);
            if (bucket.hits.length >= this.MAX_HITS_IN_WINDOW) {
                // 体量超限也按锁定处理（递增惩罚），避免"只延迟不拦"被批量脚本磨穿
                bucket.lockedUntil = now + this.nextLockMs(bucket);
                throw this.locked(bucket, now);
            }
        }
        for (const key of this.keysFor(action, ip, account)) {
            const bucket = this.bucketOf(key);
            bucket.hits.push(now);
            bucket.updatedAt = now;
        }
    }

    /** 记一次失败：返回本次应施加的递增延迟毫秒数（由调用方 await，避免在锁里睡） */
    recordFailure(action: string, ip?: string, account?: string): number {
        const now = Date.now();
        let delay = 0;
        for (const key of this.keysFor(action, ip, account)) {
            const bucket = this.bucketOf(key);
            bucket.strikes += 1;
            bucket.updatedAt = now;
            delay = Math.max(delay, Math.min(this.MAX_DELAY_MS, this.BASE_DELAY_MS * 2 ** (bucket.strikes - 1)));
            if (bucket.strikes >= this.MAX_STRIKES) {
                bucket.lockedUntil = now + this.nextLockMs(bucket);
                bucket.strikes = 0; // 重置计数：锁内不再累加，锁定期满从零开始
                bucket.lockCount += 1;
                this.logger.warn(`触发限流锁定：${key}，时长 ${Math.round((bucket.lockedUntil - now) / 1000)}s`);
            }
        }
        return delay;
    }

    /**
     * 记一次成功：只清账号维度。
     * 不清 IP 维度——否则攻击者只要用自己账号成功登录一次，就能把该 IP 的失败计数洗白。
     */
    recordSuccess(action: string, account?: string): void {
        if (!account)
            return;
        this.buckets.delete(this.key(action, 'account', String(account).toLowerCase()));
    }

    /** 递增锁定：第 n 次锁定 = BASE * 2^(n-1)，封顶 LOCK_MAX_MS */
    private nextLockMs(bucket: Bucket): number {
        return Math.min(this.LOCK_MAX_MS, this.LOCK_BASE_MS * 2 ** bucket.lockCount);
    }

    private locked(bucket: Bucket, now: number): HttpException {
        const retryAfterSec = Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000));
        // 文案与状态码不区分「IP 被锁」与「账号被锁」，避免成为账号存在性的探测面
        return new HttpException(
            { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: '尝试次数过多，请稍后再试', retryAfterSec },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }

    /** 清理：先回收陈旧桶，再兜底削峰（保最新的一批，丢最旧的） */
    sweep(now = Date.now()): void {
        for (const [key, bucket] of this.buckets) {
            const idle = now - bucket.updatedAt;
            if (bucket.lockedUntil > now)
                continue;
            // 无失败计数、窗口内无尝试的桶没有任何价值，可直接丢
            if (bucket.strikes === 0 && bucket.hits.every((t) => now - t >= this.WINDOW_MS)) {
                this.buckets.delete(key);
                continue;
            }
            // 长期无活动（超过窗口 + 最长锁）的桶也回收，防止 strikes 永久占位
            if (idle > this.WINDOW_MS + this.LOCK_MAX_MS)
                this.buckets.delete(key);
        }
        this.enforceKeyCap();
    }

    private enforceKeyCap(): void {
        if (this.buckets.size <= this.MAX_KEYS)
            return;
        this.sweep();
        if (this.buckets.size <= this.MAX_KEYS)
            return;
        // Map 迭代顺序 = 插入顺序：先丢最早创建的键（最可能是被伪造的脏数据）
        const overflow = this.buckets.size - this.MAX_KEYS;
        let dropped = 0;
        for (const key of this.buckets.keys()) {
            if (dropped >= overflow)
                break;
            this.buckets.delete(key);
            dropped += 1;
        }
        this.logger.warn(`限流键超上限，已丢弃最旧 ${dropped} 条记录`);
    }
}
