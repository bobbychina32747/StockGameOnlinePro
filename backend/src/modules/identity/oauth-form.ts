import { BadRequestException } from '@nestjs/common';
import type { RequestHandler } from 'express';

/**
 * OAuth 表单体解析（2026-10-08）
 *
 * RFC 6749 §4.1.3 规定令牌端点收 `application/x-www-form-urlencoded`，但 Nest 默认的
 * body-parser 只解 JSON —— 表单体会被解析成 `{}`，端点表现为"参数全缺"。
 *
 * 做法：在**具体的 handler 里**调用 `readOAuthForm(req)`，内部用 express 自带的
 * `express.raw()` 解析（流的归属确定），再把 `k=v&…` 解成对象。
 *
 * 为什么不用自定义中间件手工 `req.on('data')` 收流：实测在 Nest 的中间件链里会与
 * body-parser 抢流，请求直接挂住（连超时都不还）。
 * 为什么不用装饰器：Nest 没有 `@UseMiddleware`（只有 NestMiddleware + configure()，
 * 那又要动全局中间件顺序）。就地调用最小、最可控。
 */
/**
 * 自己把请求流读到 Buffer。
 *
 * 为什么不用 body-parser（express.raw / express.urlencoded）：
 *   · `express.raw({type:'application/x-www-form-urlencoded'})` 实测**不生效**（上游解析器已"标记"过该请求，raw 直接跳过）；
 *   · `express.urlencoded` 的匹配与挂载顺序由 Express 决定，而 Nest 的模块中间件注册在路由之后 —— 轮不到它。
 * 直接收流最简单也最确定：Content-Length 已知，`end` 必定触发。
 */
function readRawBody(req: any, limitBytes = 64 * 1024): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (Buffer.isBuffer(req.body))
            return resolve(req.body);
        if (typeof req.body === 'string')
            return resolve(Buffer.from(req.body, 'utf8'));
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limitBytes) {
                finish(() => reject(new BadRequestException('请求体过大')));
                req.destroy?.();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
        req.on('error', (err: any) => finish(() => reject(err)));
        const timer = setTimeout(() => finish(() => resolve(Buffer.concat(chunks))), 5000);
        if (typeof timer.unref === 'function')
            timer.unref();
    });
}

/**
 * 表单体解析中间件：**只认表单类型**，收到原始字节后解析成对象写回 `req.body`。
 *
 * 必须在 body-parser 之前挂上（main.ts 用 `NestFactory.create(AppModule, { bodyParser: false })`
 * 关掉了 Nest 自带的解析器，由我们自己按顺序装 json → 本中间件）。原因有两层：
 *   1. `express.urlencoded` 的挂载顺序在 Nest 里不可控，实测在这套组合下表单体收不到
 *      （流被消费、`req.body` 是空对象，端点表现成"参数全缺"）；
 *   2. 表单体是 OAuth 的硬要求（RFC 6749 §4.1.3），不能用"只收 JSON"糊过去。
 *
 * 只影响 `application/x-www-form-urlencoded`；其它类型一律 `next()`，JSON 端点行为不变。
 */
export const formBodyMiddleware: RequestHandler = function urlencodedParser(req: any, _res: any, next: any) {
    const type = String((req && req.headers && req.headers['content-type']) || '');
    if (!/application\/x-www-form-urlencoded/i.test(type))
        return next();
    readRawBody(req)
        .then((raw) => {
            req.body = parseFormBody(raw);
            next();
        })
        .catch((err) => next(err));
};

/**
 * 在 handler 里读请求体：表单类型直接取中间件解析好的结果，其它类型用 JSON 解析器的结果。
 * 保留这个函数的目的是让 handler 不必关心中间件细节（也留了"万一挂了别的解析器"的兜底）。
 */
export async function readOAuthForm(req: any): Promise<Record<string, any>> {
    const body = req && req.body;
    if (Buffer.isBuffer(body))
        return parseFormBody(body);
    if (typeof body === 'string')
        return parseFormBody(body);
    if (body && typeof body === 'object')
        return body as Record<string, any>;
    return {};
}

/** 解一层 `k=v&k2=v2`（不做嵌套/数组：OAuth 的参数都是标量） */
export function parseFormBody(raw: unknown): Record<string, string> {
    const text = typeof raw === 'string' ? raw : (Buffer.isBuffer(raw) ? raw.toString('utf8') : '');
    const out: Record<string, string> = {};
    for (const pair of text.split('&')) {
        if (!pair)
            continue;
        const i = pair.indexOf('=');
        const k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
        const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
        if (k)
            out[k] = v;
    }
    return out;
}

/** 合并两条来源（表单体 / JSON 体），表单体优先 */
export function mergeBody(form: Record<string, any>, body: any): Record<string, any> {
    const json = body && typeof body === 'object' && !Buffer.isBuffer(body) ? body : {};
    return Object.assign({}, json, form || {});
}

/** 供 controller 做"必须存在"校验时统一报错形状 */
export function requireField(input: Record<string, any>, field: string): string {
    const value = input && input[field];
    if (value === undefined || value === null || String(value) === '')
        throw new BadRequestException(`缺少参数 ${field}`);
    return String(value);
}
