/**
 * 下单幂等键（clientOrderId）——REFACTOR-5 批次 E
 *
 * 背景：后端 POST /trading/order 接受可选 clientOrderId；同一账户重复提交同一个 id 时，
 * 服务端返回既有订单并带 duplicate:true，不会再下一笔。
 *
 * 为什么网络失败要复用 id、业务失败要换 id：
 * - 网络类失败（超时 / 断连 / 5xx）意味着请求可能已经到达服务端并成交，只是前端"结果未知"。
 *   这时若换一个新 id 重试，服务端会把它当成一笔全新的订单 —— 等于用户一次下单扣两次钱。
 *   复用同一个 id，服务端去重后返回既有订单，重试才是安全的（这是防重复下单的关键路径）。
 * - 业务拒绝（4xx 校验错误 / success:false）是服务端明确答复"这笔单没被受理"，订单并不存在；
 *   继续复用旧 id 只会让用户改对参数后的下一次合法提交被误判成重复而静默返回错误订单，所以必须换新 id。
 * - 成功同理：本次链路已终结，下一笔单要用全新 id。
 */

/** 幂等键长度上限（与后端 DTO/网关约定一致） */
export const MAX_CLIENT_ORDER_ID_LENGTH = 64;

// 幂等键要能安全穿过 JSON / 日志 / 网关：非 ASCII、空白、控制字符都可能被改写，
// 一旦服务端收到的 id 与前端记录的 id 不一致，去重就会静默失效 → 统一收敛到 URL-safe 字符集。
const NON_ID_CHARS = /[^A-Za-z0-9_-]/g;

function normalizeClientOrderId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(NON_ID_CHARS, '').slice(0, MAX_CLIENT_ORDER_ID_LENGTH);
}

/**
 * 生成一个新的下单幂等键：非空、纯 ASCII、长度 ≤ 64。
 * 优先 crypto.randomUUID（非安全上下文/老浏览器可能没有 randomUUID）。
 */
export function newClientOrderId(): string {
  const uuid = normalizeClientOrderId(globalThis.crypto?.randomUUID?.());
  if (uuid) return uuid;

  // 回退：时间戳(36 进制) + 8 位随机(36 进制)
  const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // 兜底：Math.random 返回 0 时随机段为空 → 用纯时间戳保证非空
  return normalizeClientOrderId(fallback) || normalizeClientOrderId(Date.now().toString(36));
}

// axios 里"请求已发出但结果未知"的错误码（客户端超时 / 连接被中断 / 网络不可达）
const UNKNOWN_OUTCOME_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'ECONNRESET',
  'EPIPE',
  'ERR_CONNECTION_ABORTED',
  'ERR_CANCELED',
]);

interface ErrorLike {
  code?: unknown;
  success?: unknown;
  isAxiosError?: unknown;
  request?: unknown;
  response?: { status?: unknown; data?: { success?: unknown } | null } | null;
}

function asErrorLike(err: unknown): ErrorLike | null {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : null;
}

/**
 * 是否应当保留（复用）本次提交的 clientOrderId。
 *
 * 唯一判据：**请求可能已到达服务端、但结果未知** → true；服务端已明确答复（受理/拒绝）→ false。
 * 口径基于 api.client.ts 的 axios 错误形态：
 *   1. `err.response.status` 存在 ⇒ 服务端已答复：≥500 说明服务端处理中出错（订单可能已落库、响应丢了）→ 复用；
 *      <500（400/401/403/422…）⇒ 明确未受理 → 换新 id。
 *   2. 无 `response` ⇒ 超时/断网/连接重置等，请求可能已到达服务端 → 复用（读 `err.code` 佐证）。
 *   3. 形如 `{ success:false }` 的业务结果被当异常抛出 ⇒ 明确未下单 → 换新 id。
 *   4. 其余（`undefined`、普通 Error、无任何 axios 痕迹的对象）⇒ 判定请求根本没发出去（本地代码异常或
 *      调用方没传错误），按业务失败换新 id：换 id 的最坏代价只是去重窗口重置，而误保留会让真实订单被吞掉。
 */
export function shouldKeepClientOrderId(err: unknown): boolean {
  const e = asErrorLike(err);
  if (!e) return false;

  const status = typeof e.response?.status === 'number' ? e.response.status : undefined;

  if (status !== undefined && status < 500) return false;
  if (status !== undefined) return true;

  if (typeof e.code === 'string' && UNKNOWN_OUTCOME_CODES.has(e.code)) return true;

  if (e.success === false || e.response?.data?.success === false) return false;

  // 无 response 但有 axios 请求痕迹（isAxiosError / request）→ 请求已发出、结果未知
  return e.isAxiosError === true || e.request !== undefined;
}
