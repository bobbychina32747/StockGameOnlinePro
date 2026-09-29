import { BadRequestException, Injectable, Logger } from '@nestjs/common';

// Cloudflare Turnstile 人机验证（注册 / 忘记口令入口）。
//
// 为什么不塞进 IdentityController 或 IdentityService：
//  - 它是**外部依赖 + 开关策略**（CF 侧没配好时不能把注册口封死），单独一个 service 才能被单测用假 fetch 打穿；
//  - IdentityService 的构造函数被既有测试装置按位置参数装配，不该为一个人机校验再动它。
//
// 密钥只从环境变量读（TURNSTILE_SECRET）——代码里不存在任何密钥常量，也不回显。
// 关于 Node 版本：用全局 fetch（Node 18+），不引 node-fetch 之类的新依赖。

/** 校验模式（TURNSTILE_MODE） */
export type TurnstileMode = 'off' | 'optional' | 'required';

/** CF 校验接口（固定地址，非密钥） */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** 网络超时：CF 抖动不能把注册请求挂死（超时按校验失败处理） */
const VERIFY_TIMEOUT_MS = 5000;
/** 客户端传来的 token 长度上限（与 DTO 的 MaxLength 同口径） */
const MAX_TOKEN_LENGTH = 4096;
/** 统一文案：与其它校验错误同风格，且不区分失败原因（不泄露配置状态） */
const HUMAN_CHECK_FAILED = '人机验证未通过，请刷新页面后重试';

export interface TurnstileResult {
    ok: boolean;
    errorCodes: string[];
    /** CF 回报的 action / hostname：用于"这张 token 是不是本站在本页面签出来的"纵深校验 */
    action?: string;
    hostname?: string;
}

@Injectable()
export class TurnstileService {
    private readonly logger = new Logger('IdentityTurnstile');

    /** 运行期可覆写：单测注入受控环境变量与假 fetch，避免打真网络 */
    env: NodeJS.ProcessEnv = process.env;
    // 用 any 而非 typeof fetch：仓库 tsconfig 只开 lib ES2021 + @types/node，全局 fetch 的类型不一定在
    fetchImpl: any = typeof (globalThis as any).fetch === 'function' ? (globalThis as any).fetch.bind(globalThis) : null;
    /** 配置缺失只报错一次，避免每个请求刷屏 */
    private missingSecretLogged = false;

    mode(): TurnstileMode {
        const raw = String(this.env.TURNSTILE_MODE || 'optional').trim().toLowerCase();
        return raw === 'off' || raw === 'required' ? raw : 'optional'; // 取值非法时退回默认 optional（不 fail-open 到 off）
    }

    secret(): string {
        return String(this.env.TURNSTILE_SECRET || '').trim();
    }

    /**
     * 调 CF siteverify。
     * 注意：本方法只回答"CF 认不认这张 token"，**不决定放行与否**（策略在 assertHuman）。
     * 网络异常/超时也统一返回 ok:false + errorCodes:['network-error']，由上层按模式决定是否放行。
     */
    async verify(token: string, ip?: string): Promise<TurnstileResult> {
        const secret = this.secret();
        if (!secret || !token)
            return { ok: false, errorCodes: ['missing-input'] };
        if (!this.fetchImpl)
            return { ok: false, errorCodes: ['fetch-unavailable'] };

        const body = new URLSearchParams({ secret, response: token });
        // remoteip 可选：带上能让 CF 更准地判定（CF 侧看不到我们后端的真实客户端 IP）
        if (ip)
            body.set('remoteip', String(ip));

        // 超时保护：AbortController 在个别 Node 版本/环境下可能不存在，取不到就不设 signal（宁可无超时也不能崩）
        const Abort: any = (globalThis as any).AbortController;
        const controller = Abort ? new Abort() : null;
        const timer = controller ? setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS) : null;
        try {
            const res = await this.fetchImpl(TURNSTILE_VERIFY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                signal: controller ? controller.signal : undefined,
            });
            const data: any = await res.json().catch(() => null);
            if (!data || typeof data.success !== 'boolean') {
                this.logger.warn(`Turnstile 响应异常（HTTP ${res.status}），按校验失败处理`);
                return { ok: false, errorCodes: ['bad-response'] };
            }
            return {
                ok: data.success === true,
                errorCodes: Array.isArray(data['error-codes']) ? data['error-codes'].map(String) : [],
                action: typeof data.action === 'string' ? data.action : '',
                hostname: typeof data.hostname === 'string' ? data.hostname : '',
            };
        }
        catch (e: any) {
            // 只记错误类型，不记 token/secret（日志里绝不出现密钥类内容）
            this.logger.warn(`Turnstile 校验请求失败：${e && e.name === 'AbortError' ? 'timeout' : (e && e.message ? e.message : String(e))}`);
            return { ok: false, errorCodes: ['network-error'] };
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }

    /**
     * 放行判定（应用点在注册与忘记口令）。三种模式：
     *  - off      ：完全跳过（本机开发；连 token 都不看）
     *  - optional ：**只在「配了密钥」且「前端带了 token」时校验**——CF 侧还没配好的过渡期不能把注册口封死；
     *               但一旦带了 token，校验不过就拒（否则这个校验形同虚设）。
     *  - required ：必须带 token 且校验通过。
     * 失败一律 BadRequestException + 统一文案：不泄露是"没带 token"还是"token 无效"，也不暴露配置状态。
     *
     * @param cfToken 前端 Turnstile widget 产出的 token（DTO 字段 cfToken）
     * @param ip 客户端 IP（可选，透传给 CF）
     * @param expectedAction 该页面 widget 上写的 data-action（如 register / password-reset），用于纵深校验
     */
    async assertHuman(cfToken: string | undefined, ip?: string, expectedAction?: string): Promise<void> {
        const mode = this.mode();
        if (mode === 'off')
            return;

        const secret = this.secret();
        if (!secret) {
            if (mode === 'required') {
                // 刻意 fail-closed：required 是运维显式要求"必须人机验证"，此时缺密钥属于配置事故，
                // 静默放行等于把注册口敞开且无人察觉；拦住并打 error 日志，问题会立刻暴露。
                if (!this.missingSecretLogged) {
                    this.missingSecretLogged = true;
                    this.logger.error('TURNSTILE_MODE=required 但未配置 TURNSTILE_SECRET：注册/忘记口令入口已拒绝放行（请补密钥或先切回 optional）');
                }
                throw new BadRequestException(HUMAN_CHECK_FAILED);
            }
            return; // optional 且没配密钥：过渡期放行
        }

        const token = String(cfToken || '').trim();
        if (token.length > MAX_TOKEN_LENGTH)
            throw new BadRequestException(HUMAN_CHECK_FAILED);
        if (!token) {
            if (mode === 'required')
                throw new BadRequestException(HUMAN_CHECK_FAILED);
            return; // optional 且前端还没挂 widget：放行
        }

        const result = await this.verify(token, ip);
        if (result.ok) {
            // 纵深防御（CF 官方 frontend-edit 契约要求）：校验 action 与 hostname，
            // 免得"别的站点/别的页面签出的 token"被搬过来复用。字段缺失时不拦（不同模式可能不回报）。
            const why = this.surfaceMismatch(result, expectedAction);
            if (why) {
                this.logger.warn(`Turnstile token 与本站面不匹配：${why}`);
                throw new BadRequestException(HUMAN_CHECK_FAILED);
            }
            return;
        }
        // optional 模式下 CF 不可达（超时/网络异常）：宁可放行也不把注册口打死；required 模式则坚持拦截
        if (mode === 'optional' && result.errorCodes.includes('network-error')) {
            this.logger.warn('Turnstile 校验通道不可用，optional 模式下放行本次请求');
            return;
        }
        this.logger.warn(`Turnstile 校验未通过：${result.errorCodes.join(',') || 'unknown'}`);
        throw new BadRequestException(HUMAN_CHECK_FAILED);
    }

    /**
     * 软校验（用在**已经有别的强闸**的地方，目前是博客评论）：登录才能评论，登录本身就是强门槛，
     * 所以这里不跟随 TURNSTILE_MODE —— 带了 token 就必须过（照样打 CF，照样核 action/hostname），
     * 没带 token 也放行。这样 CF 抖动时不会把评论区一起锁死，而想绕过的人仍要过登录这一关。
     */
    async assertHumanOptional(cfToken: string | undefined, ip?: string, expectedAction?: string): Promise<void> {
        const token = String(cfToken || '').trim();
        if (!token)
            return;
        if (token.length > MAX_TOKEN_LENGTH)
            throw new BadRequestException(HUMAN_CHECK_FAILED);
        if (!this.secret())
            return;   // 没配密钥（本机/测试）时软校验直接放过
        const result = await this.verify(token, ip);
        if (!result.ok) {
            this.logger.warn(`Turnstile 软校验未通过：${result.errorCodes.join(',') || 'unknown'}`);
            throw new BadRequestException(HUMAN_CHECK_FAILED);
        }
        const why = this.surfaceMismatch(result, expectedAction);
        if (why) {
            this.logger.warn(`Turnstile token 与本站面不匹配（软校验）：${why}`);
            throw new BadRequestException(HUMAN_CHECK_FAILED);
        }
    }

    /** 允许的 hostname 清单（TURNSTILE_HOSTNAMES，逗号分隔）。生产环境**不得**含 localhost/127.0.0.1 */
    allowedHostnames(): string[] {
        return String(this.env.TURNSTILE_HOSTNAMES || 'bobbycn.cc,game.bobbycn.cc')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
    }

    /** 返回不匹配原因（空串 = 通过）。字段缺失一律放过，避免把注册口打死。 */
    private surfaceMismatch(result: TurnstileResult, expectedAction?: string): string {
        const host = String(result.hostname || '').toLowerCase();
        if (host && !this.allowedHostnames().includes(host))
            return `hostname=${host}`;
        if (expectedAction && result.action && result.action !== expectedAction)
            return `action=${result.action}（期望 ${expectedAction}）`;
        return '';
    }
}
