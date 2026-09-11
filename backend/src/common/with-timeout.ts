/**
 * G-4：给"可能永远不返回"的异步动作加上界。
 *
 * 为什么需要它（真实现象）：行情 tick 循环是**串行递归**的——`processing` 置位后某个 await 永不返回，
 * 循环就再也不会被重新调度（进程还活着、HTTP 还能响应、排行榜还在刷新，但行情彻底停更，
 * 用户看到的就是"股票数据不更新了"，而且没有任何报错）。
 * 机器人玩家是 tick 循环内新引入的**外部副作用路径**（下单 → 撮合 → 结算 → 落库），
 * 它属于旁路增强，绝不该有能力把主循环拖停；因此这里给一个上界：超时就放弃本 tick 的这部分动作。
 *
 * 语义约定：
 *   - 超时 → resolve 出 TIMEOUT 哨兵（不 reject：调用方只需判断"没等到"，且不产生未处理拒绝）
 *   - 原 promise 正常/异常 → 原样透传（异常仍由调用方的 try/catch 处理，不吞错）
 *   - 定时器 unref：被测/被短命进程使用时不会因为它在跑而吊住事件循环
 */
export const TIMEOUT = Symbol('withTimeout.timeout');

export function withTimeout<T>(work: Promise<T> | T, ms: number): Promise<T | typeof TIMEOUT> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            resolve(TIMEOUT);
        }, Math.max(1, Number(ms) || 1));
        if (timer && typeof timer.unref === 'function')
            timer.unref();
        Promise.resolve(work).then((value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
    });
}
