// P2 撮合引擎（独立纯类，无 Nest/TypeORM 依赖，可直接单测）：
// 真实盘口（价格-时间优先）与合成深度的全部撮合逻辑、冰山单逐档补量、
// 有限深度成交、开盘集合竞价、AI 虚拟挂单、做市商成交回调。
// TradingEngineService 持有本类实例并全部委托（maps 以别名共享，旧代码/测试无需改动）。
import market_utils_1 = require("../../common/market-utils");

// Legacy OHLCV backtest cost approximation; live matching uses finite-execution.
import slippage_1 = require("./slippage");
import { planFiniteExecution, FinitePlan } from './finite-execution';
import { BestQuoteOrderFlowObserver } from './order-flow';

// 公共常量/工具（symbolHash：券源池等按代码稳定取值，循环上界常量见 constants）
import constants_1 = require("../../common/constants");

// P5 类型安全：盘口条目 / 成交明细 / 盘口结构接口（替换裸 any）
export interface BookEntry {
    orderId: string | null;
    accountId: string | null;
    side: string;
    price: number;
    qty: number;
    displayQty?: number;
    hiddenQty?: number;
    time: number;
    sequence?: number;
    virtual?: boolean;
    expiresAtTick?: number;
    mmId?: string | null;
    // P0-3: 虚拟挂单归属标识（AI 账本回调按 tag 定位对手盘）；做市商挂单不用此字段
    tag?: string | null;
}
export interface Fill {
    orderId: string | null;
    accountId: string | null;
    side: string;
    price: number;
    qty: number;
    virtual: boolean;
    mmId?: string | null;
    // P0-3: 与盘口条目同源（虚拟挂单成交时带出，非虚拟挂单恒为 null）
    tag?: string | null;
}
export interface OrderBook {
    bids: BookEntry[];
    asks: BookEntry[];
    sealedUp?: boolean;
    sealedDown?: boolean;
}

export interface ExecutionOptions { deferVirtualFills?: boolean; requireFull?: boolean }
interface ExecutionReservation {
    symbol: string;
    synthetic: any | null;
    resting: OrderBook | null;
    hooks: any[];
    deferred: Array<() => void>;
    released: Promise<void>;
    release: () => void;
}

export class MatchingEngine {
    [key: string]: any;
    orderBooks: Map<string, any>;
    realBooks: Map<string, OrderBook>;
    prices: Map<string, any>;
    dayOpenPrices: Map<string, any>;
    // Phase B: 昨收价（涨跌停统一基准，market.service 每 tick 同步）
    prevCloses: Map<string, any>;
    volatilities: Map<string, any>;
    virtualFillHook: ((fill: any) => void) | null;
    private quoteSequence = 0;
    private readonly reservedSymbols = new Map<string, ExecutionReservation>();
    private readonly reservedFills = new WeakMap<object, ExecutionReservation>();
    private virtualCallbackFailures = 0;
    private readonly orderFlow = new BestQuoteOrderFlowObserver();
    constructor() {
        this.orderBooks = new Map();
        this.realBooks = new Map();
        this.prices = new Map();
        this.dayOpenPrices = new Map();
        this.prevCloses = new Map();
        this.volatilities = new Map();
        this.virtualFillHook = null;
        // P5 融券券源池：每只股票可融券数量（股）与券源年化费率（按代码哈希稳定生成）
        this.shortPool = new Map();
        // P5 A股新股首日集合：首日涨跌幅 最高+44%/最低-36%（发行价口径）替代 ±10%
        this.ipoFirstDay = new Set();
    }
    private deferBookChange(symbol: string, change: () => void): boolean {
        const reservation = this.reservedSymbols.get(symbol);
        if (!reservation) return false;
        reservation.deferred.push(change);
        return true;
    }
    async waitForExecution(symbol: string): Promise<void> {
        while (this.reservedSymbols.has(symbol)) await this.reservedSymbols.get(symbol)!.released;
    }
    private emitVirtualFill(payload: any): void {
        if (!this.virtualFillHook) return;
        try { this.virtualFillHook(payload); }
        catch { this.virtualCallbackFailures++; }
    }
    getExecutionDiagnostics() {
        return { pendingSettlements: this.reservedSymbols.size, virtualCallbackFailures: this.virtualCallbackFailures };
    }
    private observeOrderFlow(symbol: string): void { this.orderFlow.observe(symbol, this.getOrderBook(symbol)); }
    getOrderFlow(symbol: string) { return this.orderFlow.get(symbol); }
    private releaseExecution(fill: any, commit: boolean): boolean {
        const reservation = fill && this.reservedFills.get(fill);
        if (!reservation) return false;
        this.reservedFills.delete(fill);
        if (!commit) {
            if (reservation.synthetic) this.orderBooks.set(reservation.symbol, reservation.synthetic);
            else this.orderBooks.delete(reservation.symbol);
            if (reservation.resting) this.realBooks.set(reservation.symbol, reservation.resting);
            else this.realBooks.delete(reservation.symbol);
        }
        if (commit) for (const payload of reservation.hooks) this.emitVirtualFill(payload);
        this.reservedSymbols.delete(reservation.symbol);
        if (commit) this.observeOrderFlow(reservation.symbol);
        try { for (const change of reservation.deferred) change(); }
        finally { reservation.release(); }
        return true;
    }
    commitExecution(fill: any): boolean { return this.releaseExecution(fill, true); }
    rollbackExecution(fill: any): boolean { return this.releaseExecution(fill, false); }
    private planExecution(symbol: string, side: any, quantity: number, limitPrice?: number, excludeAccountId?: string, external = true): FinitePlan {
        const isBuy = side === 'buy' || side === 'cover';
        const resting = this.realBooks.get(symbol);
        const synthetic = external ? this.orderBooks.get(symbol) : null;
        return planFiniteExecution({ side, quantity, limitPrice, excludeAccountId,
            resting: resting ? (isBuy ? resting.asks : resting.bids) : [],
            external: synthetic ? (isBuy ? synthetic.asks : synthetic.bids) : [] });
    }
    private executionResult(symbol: string, side: string, plan: FinitePlan) {
        const isBuy = side === 'buy' || side === 'cover';
        // Exclude one's own resting orders from the executable touch benchmark.
        const touch = plan.slices[0]?.price || 0;
        const reference = Number(this.prices.get(symbol)) || touch;
        const sign = isBuy ? 1 : -1;
        const bps = (price: number, anchor: number) => anchor > 0 && plan.filled > 0 ? Number((sign * (price / anchor - 1) * 10000).toFixed(4)) : 0;
        return { symbol, side, requestedQuantity: plan.requested, filledQuantity: plan.filled,
            remainingQuantity: plan.remaining, avgPrice: Number(plan.averagePrice.toFixed(4)), totalCost: plan.totalCost,
            counterFills: plan.slices.filter(s => s.source === 'resting').map(s => ({
                orderId: s.order!.orderId, accountId: s.order!.accountId, side: s.order!.side,
                price: s.price, qty: s.quantity, virtual: !!s.order!.virtual,
                mmId: s.order!.mmId || null, tag: s.order!.tag ?? null })),
            execution: { model: 'finite-depth-v1', referencePrice: reference, touchPrice: touch,
                lastPrice: plan.slices.length ? plan.slices[plan.slices.length - 1].price : 0,
                priceImpactBps: bps(plan.averagePrice, touch), costBps: bps(plan.averagePrice, reference),
                levelsConsumed: new Set(plan.slices.map(s => s.price)).size, truncated: plan.truncated } };
    }
    previewMarketOrder(symbol: string, side: string, quantity: number, limitPrice?: number, excludeAccountId?: string) {
        if (this.reservedSymbols.has(symbol)) return { symbol, side, requestedQuantity: quantity,
            filledQuantity: 0, remainingQuantity: quantity, avgPrice: 0, totalCost: 0, busy: true };
        const result = this.executionResult(symbol, side, this.planExecution(symbol, side, quantity, limitPrice, excludeAccountId));
        // A public quote must not expose counterpart account or order identifiers.
        const { counterFills, ...quote } = result;
        return { ...quote, busy: false };
    }
    private executeFinite(symbol: string, side: string, quantity: number, limitPrice?: number, excludeAccountId?: string, options: ExecutionOptions = {}, external = true) {
        if (this.reservedSymbols.has(symbol)) return null;
        const plan = this.planExecution(symbol, side, quantity, limitPrice, excludeAccountId, external);
        if (!plan.filled || (options.requireFull && plan.remaining > 0)) return null;
        this.observeOrderFlow(symbol);
        const result = this.executionResult(symbol, side, plan);
        const clone = (book: any) => book ? { ...book, bids: book.bids.map((o: any) => ({ ...o })), asks: book.asks.map((o: any) => ({ ...o })) } : null;
        let reservation: ExecutionReservation | undefined;
        if (options.deferVirtualFills) {
            let release!: () => void;
            const released = new Promise<void>(resolve => { release = resolve; });
            reservation = { symbol, synthetic: clone(this.orderBooks.get(symbol)), resting: clone(this.realBooks.get(symbol)), hooks: [], deferred: [], released, release };
            this.reservedSymbols.set(symbol, reservation);
            this.reservedFills.set(result, reservation);
        }
        const isBuy = side === 'buy' || side === 'cover';
        const sideKey = isBuy ? 'asks' : 'bids';
        const resting = this.realBooks.get(symbol);
        if (resting) resting[sideKey] = plan.restingAfter;
        // Iceberg replenishment can allocate new sequence numbers inside the plan.
        // Later arrivals in the same millisecond must remain behind those slices.
        for (const entry of plan.restingAfter) this.quoteSequence = Math.max(this.quoteSequence, entry.sequence || 0);
        const synthetic = this.orderBooks.get(symbol);
        if (external && synthetic) {
            for (const slice of plan.slices) if (slice.source === 'external') synthetic[sideKey][slice.index].size -= slice.quantity;
            synthetic[sideKey] = synthetic[sideKey].filter((level: any) => level.size > 0);
        }
        for (const cf of result.counterFills) if (cf.virtual) {
            const payload = { mmId: cf.mmId, tag: cf.tag, orderId: cf.orderId, symbol, side: cf.side, qty: cf.qty, price: cf.price };
            if (reservation) reservation.hooks.push(payload);
            else this.emitVirtualFill(payload);
        }
        if (!reservation) this.observeOrderFlow(symbol);
        return result;
    }
    initShortPool(symbol) {
        if (this.shortPool.has(symbol))
            return;
        // 券源池量化：改用公共 symbolHash（原内联循环上界取自用户输入的 symbol.length，CodeQL js/loop-bound-injection）
        const h = constants_1.symbolHash(symbol);
        const available = 30000 + (h % 20) * 5000;
        this.shortPool.set(symbol, { available, initial: available, feeRate: Number((0.04 + (h % 60) / 1000).toFixed(4)) });
    }
    getShortPool(symbol) {
        this.initShortPool(symbol);
        return { ...this.shortPool.get(symbol) };
    }
    consumeShort(symbol, qty) {
        this.initShortPool(symbol);
        const p = this.shortPool.get(symbol);
        p.available = Math.max(0, p.available - Number(qty));
        return p.available;
    }
    returnShort(symbol, qty) {
        this.initShortPool(symbol);
        const p = this.shortPool.get(symbol);
        p.available = Math.min(p.initial, p.available + Number(qty));
        return p.available;
    }
    setIpoFirstDays(symbols) {
        this.ipoFirstDay = new Set(Array.isArray(symbols) ? symbols : []);
    }
    // 合成深度（5 档，按 mid 生成）
    updatePrices(prices) {
        for (const [sym, price] of Object.entries(prices)) {
            this.prices.set(sym, price);
        }
    }
    setDayOpen(prices) {
        for (const [sym, price] of Object.entries(prices)) {
            this.dayOpenPrices.set(sym, price);
        }
    }
    // Phase B: 昨收同步（涨跌停/委托价校验基准）
    setPrevCloses(prevCloses) {
        for (const [sym, price] of Object.entries(prevCloses || {})) {
            if (Number(price) > 0)
                this.prevCloses.set(sym, Number(price));
        }
    }
    // P2 波动率供滑点模型使用（由行情引擎每 tick 同步）
    setVolatilities(vols) {
        for (const [sym, v] of Object.entries(vols)) {
            this.volatilities.set(sym, v);
        }
    }
    // P2 做市商虚拟成交回调（mmId → 库存更新）
    setVirtualFillHook(fn) {
        this.virtualFillHook = fn;
    }
    refreshOrderBooks(prices) {
        for (const [sym, price] of Object.entries(prices)) {
            this.refreshOrderBook(sym, price);
        }
    }
    // P0 真实订单簿：挂单进入盘口队列（bids/asks 按价格-时间优先排序）
    // P2 冰山单：opts.displayQty 为显示量（默认=全部），opts.hiddenQty 为隐藏量（补量池）
    placeRestingOrder(symbol, orderId, accountId, side, price, qty, opts?) {
        if (this.deferBookChange(symbol, () => this.placeRestingOrder(symbol, orderId, accountId, side, price, qty, opts))) return;
        if (!Number.isFinite(Number(price)) || Number(price) <= 0 || !Number.isFinite(Number(qty)) || Number(qty) <= 0)
            return;
        let book = this.realBooks.get(symbol);
        if (!book) {
            book = { bids: [], asks: [] };
            this.realBooks.set(symbol, book);
        }
        const isBid = side === 'buy' || side === 'cover';
        const list = isBid ? book.bids : book.asks;
        const displayQty = Number(opts?.displayQty) || Number(qty);
        const hiddenQty = Number(opts?.hiddenQty) || 0;
        list.push({
            orderId, accountId, side, price: Number(price),
            qty: Math.min(displayQty, Number(qty)), displayQty, hiddenQty,
            time: Date.now(), sequence: ++this.quoteSequence,
        });
        list.sort((a, b) => isBid ? (b.price - a.price) || (a.time - b.time) : (a.price - b.price) || (a.time - b.time));
        this.observeOrderFlow(symbol);
    }
    // P0: 从盘口移除挂单（qty 缺省=整单移除；给定 qty=扣减部分数量）
    // P2: 冰山单在盘口可能有多个补量切片（同 orderId），整单移除时全部清除
    removeRestingOrder(symbol, orderId, qty?) {
        if (this.deferBookChange(symbol, () => this.removeRestingOrder(symbol, orderId, qty))) return;
        const book = this.realBooks.get(symbol);
        if (!book)
            return;
        let toRemove = qty;
        for (const sideKey of ['bids', 'asks']) {
            const arr = book[sideKey];
            for (let i = arr.length - 1; i >= 0; i--) {
                if (arr[i].orderId !== orderId)
                    continue;
                if (toRemove === undefined) {
                    arr.splice(i, 1);
                    continue;
                }
                if (toRemove <= 0)
                    break;
                const entry = arr[i];
                const visible = Number(entry.qty);
                const hidden = Number(entry.hiddenQty) || 0;
                const take = Math.min(Number(toRemove), visible + hidden);
                toRemove -= take;
                if (take < visible) entry.qty = visible - take;
                else {
                    const left = visible + hidden - take;
                    if (left > 0) {
                        const reveal = Math.min(Number(entry.displayQty) || visible, left);
                        entry.qty = reveal;
                        entry.hiddenQty = left - reveal;
                        entry.time = Date.now();
                        entry.sequence = ++this.quoteSequence;
                    } else arr.splice(i, 1);
                }
            }
            arr.sort((a, b) => (sideKey === 'bids' ? b.price - a.price : a.price - b.price) || (a.time - b.time) || ((a.sequence || 0) - (b.sequence || 0)));
        }
        this.observeOrderFlow(symbol);
    }
    // P0 真实订单簿撮合：按价格-时间优先吃对手方真实挂单；返回对手方成交明细与剩余量
    // P2 冰山单：显示量被吃尽后从隐藏量补量（同价队尾，价格-时间优先）；做市商成交回调
    matchAgainstBook(symbol, side, quantity, limitPrice, excludeAccountId) {
        const result = this.executeFinite(symbol, side, quantity, limitPrice ?? undefined, excludeAccountId, {}, false);
        return { fills: result?.counterFills || [], remaining: result?.remainingQuantity ?? quantity };
    }
    refreshOrderBook(symbol, midPrice) {
        if (this.deferBookChange(symbol, () => this.refreshOrderBook(symbol, midPrice))) return;
        const levels = 5;
        const baseSpread = 0.001;
        const baseSize = 500;
        let book = this.orderBooks.get(symbol);
        if (!book) {
            book = { bids: [], asks: [] };
            this.orderBooks.set(symbol, book);
        }
        let liquidityMul = 1.0;
        const dayOpen = this.dayOpenPrices.get(symbol);
        if (dayOpen && dayOpen > 0) {
            const dayChange = (midPrice - dayOpen) / dayOpen;
            if (dayChange < -0.05) {
                liquidityMul = 0.2;
            }
        }
        let asks = [];
        let bids = [];
        // Phase B: 涨跌停统一基准=昨收（真实涨停价=昨收×1.1 全天固定），新股首日 +44%/-36%（发行价口径）
        // prevClose 由 market.service 通过 setPrevCloses 同步（竞价前刷新）
        const isCN = market_utils_1.isCnSymbol(symbol);
        const firstDay = this.ipoFirstDay.has(symbol);
        const base = isCN ? ((this.prevCloses.get(symbol) && Number(this.prevCloses.get(symbol)) > 0) ? Number(this.prevCloses.get(symbol)) : (dayOpen && Number(dayOpen) > 0 ? Number(dayOpen) : null)) : null;
        const band = isCN && base ? market_utils_1.cnPriceLimits(base, firstDay) : null;
        const limitUp = band ? band.up : null;
        const limitDown = band ? band.down : null;
        const sealedUp = limitUp !== null && midPrice >= limitUp - 1e-6;
        const sealedDown = limitDown !== null && midPrice <= limitDown + 1e-6;
        for (let i = 0; i < levels; i++) {
            const spreadMult = (i + 1) * baseSpread;
            const askPrice = midPrice * (1 + spreadMult);
            const bidPrice = midPrice * (1 - spreadMult);
            const size = Math.floor(baseSize * liquidityMul * (1 + Math.random()) * (1 - i * 0.12));
            if (!sealedUp && (limitUp === null || askPrice <= limitUp))
                asks.push({ price: Number(askPrice.toFixed(2)), size: Math.max(1, size), time: Date.now(), sequence: ++this.quoteSequence });
            if (!sealedDown && (limitDown === null || bidPrice >= limitDown))
                bids.push({ price: Number(bidPrice.toFixed(2)), size: Math.max(1, size), time: Date.now(), sequence: ++this.quoteSequence });
        }
        // Phase B P1#6: 显示与撮合分离——orderBooks 只存纯合成深度，真实挂单在 getOrderBook 输出层动态合并，
        // 彻底消除"真实挂单先被 matchAgainstBook 吃掉、又被合成档二次撮合"的幻影流动性
        book.asks = asks;
        book.bids = bids;
        book.sealedUp = !!sealedUp;
        book.sealedDown = !!sealedDown;
        this.observeOrderFlow(symbol);
    }
    // Phase B: 输出层动态合并真实挂单（按价格聚合，同价先合成后真实，最多 10 档）
    mergeReal(symbol, synthetic, side) {
        const realBook = this.realBooks.get(symbol);
        const map = new Map();
        for (const l of synthetic)
            if (Number(l.size) > 0) map.set(l.price, (map.get(l.price) || 0) + l.size);
        if (realBook) {
            const realList = side === 'bid' ? realBook.bids : realBook.asks;
            for (const o of realList) {
                if (Number(o.qty) > 0) map.set(o.price, (map.get(o.price) || 0) + o.qty);
            }
        }
        return [...map.entries()]
            .map(([price, size]) => ({ price: Number(price), size }))
            .sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
            .slice(0, 10);
    }
    getOrderBook(symbol) {
        const book = this.orderBooks.get(symbol) || { asks: [], bids: [] };
        const asks = this.mergeReal(symbol, book.asks, 'ask');
        const bids = this.mergeReal(symbol, book.bids, 'bid');
        if (asks.length === 0 || bids.length === 0) {
            return { symbol, asks, bids, spread: 0 };
        }
        return {
            symbol,
            asks,
            bids,
            spread: Number((asks[0].price - bids[0].price).toFixed(2)),
        };
    }
    // Compatibility name: this is static queue imbalance (QI), not event OFI.
    calcBookOFI(symbol) {
        const book = this.orderBooks.get(symbol) || { asks: [], bids: [] };
        const asks = this.mergeReal(symbol, book.asks, 'ask');
        const bids = this.mergeReal(symbol, book.bids, 'bid');
        if (!asks.length || !bids.length)
            return 0;
        const bid = Number(bids[0].size);
        const ask = Number(asks[0].size);
        const total = bid + ask;
        if (!Number.isFinite(total) || total <= 0)
            return 0;
        return (bid - ask) / total;
    }
    // Kept for legacy callers/backtests; production fills do not use this approximation.
    slipStepFor(symbol, side) {
        const ofi = this.calcBookOFI(symbol);
        const vol = Number(this.volatilities.get(symbol)) || 0.02;
        return { step: slippage_1.slipStepFor(vol, ofi, side), ofi };
    }
    executeMarketOrder(symbol, side, quantity, excludeAccountId?, options: ExecutionOptions = {}) {
        return this.executeFinite(symbol, side, quantity, undefined, excludeAccountId, options);
    }
    // P2: AI 虚拟限价挂单（进入盘口排队，TTL tick 到期自动撤单，无账户不结算）
    // opts.orderId 供做市商报价撤换 / AI 挂单追踪；opts.mmId 触发做市商成交回调（库存更新）
    // P0-3: opts.tag 为任意标识（AI 侧放 agent.id）——AI 限价单成交同样触发 virtualFillHook，供账本回调定位
    placeVirtualOrder(symbol, side, price, qty, expiresAtTick, opts?) {
        if (this.deferBookChange(symbol, () => this.placeVirtualOrder(symbol, side, price, qty, expiresAtTick, opts))) return;
        if (!Number.isFinite(Number(price)) || Number(price) <= 0 || !Number.isFinite(Number(qty)) || Number(qty) <= 0)
            return;
        let book = this.realBooks.get(symbol);
        if (!book) {
            book = { bids: [], asks: [] };
            this.realBooks.set(symbol, book);
        }
        const isBid = side === 'buy' || side === 'cover';
        const list = isBid ? book.bids : book.asks;
        list.push({
            orderId: opts?.orderId ?? null, accountId: null, side, price: Number(price), qty: Number(qty),
            time: Date.now(), sequence: ++this.quoteSequence, virtual: true, expiresAtTick, mmId: opts?.mmId ?? null, tag: opts?.tag ?? null,
        });
        list.sort((a, b) => isBid ? (b.price - a.price) || (a.time - b.time) : (a.price - b.price) || (a.time - b.time));
        this.observeOrderFlow(symbol);
    }
    // P2: 清理到期的 AI 虚拟挂单（每 tick 由行情引擎调用）
    // G-3: 可选 matchSymbol 过滤——三市场共享同一个引擎、tickCount 各自独立（闭市市场不前进），
    // 用别市场的 tick 去清理会把本市场"还没到期"的挂单提前删掉（虚拟流动性凭空消失）。
    pruneExpiredVirtualOrders(currentTick, matchSymbol?: (symbol: string) => boolean) {
        for (const [symbol, book] of this.realBooks) {
            if (matchSymbol && !matchSymbol(symbol))
                continue;
            if (this.deferBookChange(symbol, () => this.pruneExpiredVirtualOrders(currentTick, s => s === symbol))) continue;
            for (const sideKey of ['bids', 'asks']) {
                const arr = book[sideKey];
                for (let i = arr.length - 1; i >= 0; i--) {
                    if (arr[i].virtual && arr[i].expiresAtTick <= currentTick) {
                        arr.splice(i, 1);
                    }
                }
            }
            this.observeOrderFlow(symbol);
        }
    }
    // P2: AI 虚拟市价单——只吃真实盘口（AI 虚拟挂单 + 用户挂单），不吃合成深度
    executeVirtualMarketOrder(symbol, side, quantity) {
        return this.executeFinite(symbol, side, quantity, undefined, undefined, {}, false);
    }
    // P1 开盘集合竞价：按最大成交量原则形成开盘价，交叉挂单以开盘价撮合（用户订单走真实结算）
    // 返回 { auctionPrice, fills }；fills 中买卖双方各一条（virtual 标记区分 AI 虚拟挂单）
    // 注：冰山单隐藏量不参与竞价（只按显示量计），与交易所简化口径一致
    runOpeningAuction(symbol, prevClose) {
        if (this.reservedSymbols.has(symbol)) throw new Error('Continuous execution must settle before the opening auction');
        const book = this.realBooks.get(symbol);
        if (!book)
            return { auctionPrice: Number(prevClose) || 0, fills: [] };
        const bids = book.bids.slice();
        const asks = book.asks.slice();
        if (bids.length === 0 || asks.length === 0)
            return { auctionPrice: Number(prevClose) || 0, fills: [] };
        const isCN = market_utils_1.isCnSymbol(symbol);
        const base = Number(prevClose) || Number(bids[0].price) || 1;
        // P5 新股首日竞价区间同样放宽到 +44%/-36%
        const firstDay = this.ipoFirstDay.has(symbol);
        const limitUp = isCN ? base * (firstDay ? 1.44 : 1.10) : Infinity;
        const limitDown = isCN ? base * (firstDay ? 0.64 : 0.90) : 0;
        const candidates = new Set<number>();
        for (const e of [...bids, ...asks]) {
            const p = Number(e.price);
            if (isCN && (p > limitUp || p < limitDown))
                continue;
            candidates.add(p);
        }
        candidates.add(Math.min(Math.max(base, limitDown), limitUp));
        const volumeAt = (p) => {
            let bidVol = 0;
            for (const e of bids)
                if (e.price >= p)
                    bidVol += e.qty;
            let askVol = 0;
            for (const e of asks)
                if (e.price <= p)
                    askVol += e.qty;
            return Math.min(bidVol, askVol);
        };
        let best = null;
        for (const p of [...candidates].sort((a, b) => a - b)) {
            const v = volumeAt(p);
            if (best === null || v > best.volume || (v === best.volume && Math.abs(p - base) < Math.abs(best.price - base))) {
                best = { price: p, volume: v };
            }
        }
        const auctionPrice = best ? best.price : base;
        const bidQueue = bids.filter((e) => e.price >= auctionPrice);
        const askQueue = asks.filter((e) => e.price <= auctionPrice);
        const fills = [];
        // R5-⑬: 竞价虚拟成交的钩子载荷（本函数是纯计算、无 DB，钩子在 return 前统一触发）。
        // fills 内容保持不变（不含 mmId/tag），故单独收集源挂单的归属信息。
        const virtualHooks = [];
        const removeEntry = (arr, entry, qty) => {
            const idx = arr.indexOf(entry);
            if (idx < 0)
                return;
            if (qty >= entry.qty)
                arr.splice(idx, 1);
            else
                arr[idx].qty -= qty;
        };
        let i = 0;
        let j = 0;
        let bidLeft = bidQueue.length > 0 ? bidQueue[0].qty : 0;
        let askLeft = askQueue.length > 0 ? askQueue[0].qty : 0;
        while (i < bidQueue.length && j < askQueue.length) {
            const b = bidQueue[i];
            const a = askQueue[j];
            const qty = Math.min(bidLeft, askLeft);
            const fillPrice = Number(Number(auctionPrice).toFixed(2));
            fills.push({ orderId: b.orderId, accountId: b.accountId, side: b.side, price: Number(Number(auctionPrice).toFixed(2)), qty, virtual: !!b.virtual });
            fills.push({ orderId: a.orderId, accountId: a.accountId, side: a.side, price: Number(Number(auctionPrice).toFixed(2)), qty, virtual: !!a.virtual });
            // R5-⑬: 与 matchAgainstBook 同一载荷形状（成交价用竞价成交价 auctionPrice）。
            // 原实现竞价只吐 fills 不触发 virtualFillHook：AI 挂单/做市商报价在竞价成交后账本不动，
            // 冻结要等 TTL 过期才释放（restingOrders 长期被占用、AI 参与率被错误压制）。
            for (const e of [b, a]) {
                if (e.virtual)
                    virtualHooks.push({ mmId: e.mmId || null, tag: e.tag ?? null, orderId: e.orderId, symbol, side: e.side, qty, price: fillPrice });
            }
            removeEntry(book.bids, b, qty);
            removeEntry(book.asks, a, qty);
            bidLeft -= qty;
            askLeft -= qty;
            if (bidLeft <= 0) {
                i++;
                if (i < bidQueue.length)
                    bidLeft = bidQueue[i].qty;
            }
            if (askLeft <= 0) {
                j++;
                if (j < askQueue.length)
                    askLeft = askQueue[j].qty;
            }
        }
        // R5-⑬: 竞价成交先触发虚拟成交钩子（做市商库存 / AI 账本与冻结同步），再返回调用方
        if (this.virtualFillHook) {
            for (const payload of virtualHooks) {
                try {
                    this.virtualFillHook(payload);
                }
                catch (e) { }
            }
        }
        this.observeOrderFlow(symbol);
        return { auctionPrice: Number(Number(auctionPrice).toFixed(2)), fills };
    }
    // SECURITY: 限价单按限价封顶撮合——买入只吃价格<=限价的档位，卖出相反；不足则部分成交
    executeMarketOrderLimited(symbol, side, quantity, limitPrice, excludeAccountId?, options: ExecutionOptions = {}) {
        return this.executeFinite(symbol, side, quantity, limitPrice, excludeAccountId, options);
    }
}
