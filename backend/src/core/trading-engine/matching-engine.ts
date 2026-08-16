// P2 撮合引擎（独立纯类，无 Nest/TypeORM 依赖，可直接单测）：
// 真实盘口（价格-时间优先）与合成深度的全部撮合逻辑、冰山单逐档补量、
// OFI+波动率动态滑点、开盘集合竞价、AI 虚拟挂单、做市商成交回调。
// TradingEngineService 持有本类实例并全部委托（maps 以别名共享，旧代码/测试无需改动）。
import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

import market_utils_1 = require("../../common/market-utils");

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
    virtual?: boolean;
    expiresAtTick?: number;
    mmId?: string | null;
}
export interface Fill {
    orderId: string | null;
    accountId: string | null;
    side: string;
    price: number;
    qty: number;
    virtual: boolean;
    mmId?: string | null;
}
export interface OrderBook {
    bids: BookEntry[];
    asks: BookEntry[];
    sealedUp?: boolean;
    sealedDown?: boolean;
}

export class MatchingEngine {
    [key: string]: any;
    orderBooks: Map<string, any>;
    realBooks: Map<string, OrderBook>;
    prices: Map<string, any>;
    dayOpenPrices: Map<string, any>;
    volatilities: Map<string, any>;
    virtualFillHook: ((fill: any) => void) | null;
    constructor() {
        this.orderBooks = new Map();
        this.realBooks = new Map();
        this.prices = new Map();
        this.dayOpenPrices = new Map();
        this.volatilities = new Map();
        this.virtualFillHook = null;
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
            time: Date.now(),
        });
        list.sort((a, b) => isBid ? (b.price - a.price) || (a.time - b.time) : (a.price - b.price) || (a.time - b.time));
    }
    // P0: 从盘口移除挂单（qty 缺省=整单移除；给定 qty=扣减部分数量）
    // P2: 冰山单在盘口可能有多个补量切片（同 orderId），整单移除时全部清除
    removeRestingOrder(symbol, orderId, qty?) {
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
                const take = Math.min(Number(toRemove), Number(arr[i].qty));
                arr[i].qty = Number(arr[i].qty) - take;
                toRemove -= take;
                if (arr[i].qty <= 0)
                    arr.splice(i, 1);
            }
        }
    }
    // P0 真实订单簿撮合：按价格-时间优先吃对手方真实挂单；返回对手方成交明细与剩余量
    // P2 冰山单：显示量被吃尽后从隐藏量补量（同价队尾，价格-时间优先）；做市商成交回调
    matchAgainstBook(symbol, side, quantity, limitPrice, excludeAccountId) {
        const book = this.realBooks.get(symbol);
        if (!book)
            return { fills: [], remaining: quantity };
        const isBuy = side === 'buy' || side === 'cover';
        const list = isBuy ? book.asks : book.bids;
        const fills = [];
        let remaining = quantity;
        let i = 0;
        while (remaining > 0 && i < list.length) {
            const entry = list[i];
            // 自成交防护：不与自己账户的挂单撮合（真实交易所规则）
            if (excludeAccountId !== undefined && excludeAccountId !== null && entry.accountId === excludeAccountId) {
                i++;
                continue;
            }
            const priceOk = (limitPrice === undefined || limitPrice === null)
                ? true
                : (isBuy ? entry.price <= limitPrice : entry.price >= limitPrice);
            if (!priceOk)
                break; // 按价格有序，后续档位只会更差
            const fillQty = Math.min(remaining, entry.qty);
            fills.push({ orderId: entry.orderId, accountId: entry.accountId, side: entry.side, price: entry.price, qty: fillQty, virtual: !!entry.virtual, mmId: entry.mmId || null });
            // P2 做市商成交回调（库存更新），失败不影响撮合
            if (entry.virtual && entry.mmId && this.virtualFillHook) {
                try {
                    this.virtualFillHook({ mmId: entry.mmId, symbol, side: entry.side, qty: fillQty, price: entry.price });
                }
                catch (e) { }
            }
            if (fillQty >= entry.qty) {
                list.splice(i, 1);
                // P2 冰山补量：显示量吃尽 → 从隐藏量补一档到同价队尾（新 time 保证排后）
                const hidden = Number(entry.hiddenQty) || 0;
                if (hidden > 0) {
                    const display = Number(entry.displayQty) || entry.qty || fillQty;
                    const reveal = Math.min(display, hidden);
                    if (reveal > 0) {
                        list.push({
                            orderId: entry.orderId, accountId: entry.accountId, side: entry.side,
                            price: entry.price, qty: reveal, displayQty: display,
                            hiddenQty: hidden - reveal, time: Date.now() + 1,
                        });
                        list.sort((a, b) => isBuy ? (b.price - a.price) || (a.time - b.time) : (a.price - b.price) || (a.time - b.time));
                    }
                }
            }
            else {
                entry.qty -= fillQty;
                i++;
            }
            remaining -= fillQty;
        }
        return { fills, remaining };
    }
    refreshOrderBook(symbol, midPrice) {
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
        // P0 涨跌停封板（仅 A 股，以今开为基准 ±10%）：涨停时合成卖盘清空（只能排队买入）、跌停时合成买盘清空
        const isCN = market_utils_1.isCnSymbol(symbol);
        const limitUp = isCN && dayOpen && dayOpen > 0 ? Number(dayOpen) * 1.10 : null;
        const limitDown = isCN && dayOpen && dayOpen > 0 ? Number(dayOpen) * 0.90 : null;
        const sealedUp = limitUp !== null && midPrice >= limitUp - 1e-6;
        const sealedDown = limitDown !== null && midPrice <= limitDown + 1e-6;
        for (let i = 0; i < levels; i++) {
            const spreadMult = (i + 1) * baseSpread;
            const askPrice = midPrice * (1 + spreadMult);
            const bidPrice = midPrice * (1 - spreadMult);
            const size = Math.floor(baseSize * liquidityMul * (1 + Math.random()) * (1 - i * 0.12));
            if (!sealedUp && (limitUp === null || askPrice <= limitUp))
                asks.push({ price: Number(askPrice.toFixed(2)), size: Math.max(1, size) });
            if (!sealedDown && (limitDown === null || bidPrice >= limitDown))
                bids.push({ price: Number(bidPrice.toFixed(2)), size: Math.max(1, size) });
        }
        book.asks = asks;
        book.bids = bids;
        book.sealedUp = !!sealedUp;
        book.sealedDown = !!sealedDown;
        // P0 真实盘口：合并真实挂单队列（用户限价单常驻盘口，按价格聚合，最多 10 档）
        const realBook = this.realBooks.get(symbol);
        if (realBook) {
            const mergeAll = (levels, realList, side) => {
                const map = new Map();
                for (const l of levels)
                    map.set(l.price, l.size);
                for (const o of realList) {
                    map.set(o.price, (map.get(o.price) || 0) + o.qty);
                }
                return [...map.entries()]
                    .map(([price, size]) => ({ price: Number(price), size }))
                    .sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
                    .slice(0, 10);
            };
            book.bids = mergeAll(book.bids, realBook.bids, 'bid');
            book.asks = mergeAll(book.asks, realBook.asks, 'ask');
        }
    }
    getOrderBook(symbol) {
        const book = this.orderBooks.get(symbol);
        const price = this.prices.get(symbol) ?? 100;
        if (!book || book.asks.length === 0 || book.bids.length === 0) {
            return { symbol, asks: [], bids: [], spread: 0 };
        }
        return {
            symbol,
            asks: book.asks,
            bids: book.bids,
            spread: Number((book.asks[0].price - book.bids[0].price).toFixed(2)),
        };
    }
    // P2 订单流不平衡：OFI = (买一量 - 卖一量) / (买一量 + 卖一量)，∈ [-1, 1]
    calcBookOFI(book) {
        if (!book || !book.asks.length || !book.bids.length)
            return 0;
        const bid = Number(book.bids[0].size);
        const ask = Number(book.asks[0].size);
        const total = bid + ask;
        if (!Number.isFinite(total) || total <= 0)
            return 0;
        return (bid - ask) / total;
    }
    // P2 动态冲击成本：每 500 股一档的恶化步长 = 基准 × 波动率压力 × 订单流不平衡
    // 逆风（买方遇到买压/卖方遇到卖压）冲击放大；顺风收窄；步长与总滑点均设上下界
    slipStepFor(symbol, side) {
        const book = this.orderBooks.get(symbol);
        const ofi = this.calcBookOFI(book);
        const vol = Number(this.volatilities.get(symbol)) || 0.02;
        const volMul = 1 + Math.min(2, Math.max(0, (vol - 0.02) * 25));
        const dir = (side === order_entity_1.OrderSide.BUY || side === order_entity_1.OrderSide.COVER) ? 1 : -1;
        const adverse = Math.max(0, dir * ofi);
        const favorable = Math.max(0, -dir * ofi);
        const step = 0.0008 * volMul * (1 + 2.2 * adverse) * (1 - 0.5 * favorable);
        return { step: Math.min(0.004, Math.max(0.0002, step)), ofi };
    }
    executeMarketOrder(symbol, side, quantity, excludeAccountId?) {
        // P0: 先撮合真实挂单（价格-时间优先），剩余量再吃合成深度
        const real = this.matchAgainstBook(symbol, side, quantity, undefined, excludeAccountId);
        const isBuy = side === order_entity_1.OrderSide.BUY || side === order_entity_1.OrderSide.COVER;
        let totalCost = 0;
        let totalQty = 0;
        for (const f of real.fills) {
            totalCost += f.qty * f.price;
            totalQty += f.qty;
        }
        let remaining = real.remaining;
        const book = this.orderBooks.get(symbol);
        const levels = book ? (isBuy ? book.asks : book.bids) : [];
        for (const level of levels) {
            if (remaining <= 0)
                break;
            const fill = Math.min(remaining, level.size);
            totalCost += fill * level.price;
            totalQty += fill;
            remaining -= fill;
        }
        // P2 动态滑点（OFI+波动率）：剩余量按逐档恶化价格成交，总滑点上限 2%；封板/无报价时不适用
        if (remaining > 0) {
            const knownPrice = this.prices.get(symbol);
            const sealed = book && (isBuy ? book.sealedUp : book.sealedDown);
            if (!sealed && knownPrice !== undefined && knownPrice !== null) {
                const dirMul = isBuy ? 1 : -1;
                let slip = 0;
                const anchor = levels.length > 0 ? levels[levels.length - 1].price : Number(knownPrice);
                const { step } = this.slipStepFor(symbol, side);
                while (remaining > 0 && slip < 0.02) {
                    const tranche = Math.min(remaining, 500);
                    totalCost += tranche * anchor * (1 + dirMul * slip);
                    totalQty += tranche;
                    remaining -= tranche;
                    slip = Math.min(0.02, slip + step);
                }
            }
        }
        if (totalQty === 0)
            return null;
        const avgPrice = totalCost / totalQty;
        return {
            symbol,
            side,
            filledQuantity: totalQty,
            avgPrice: Number(avgPrice.toFixed(4)),
            totalCost: Number(totalCost.toFixed(2)),
            counterFills: real.fills,
        };
    }
    // P2: AI 虚拟限价挂单（进入盘口排队，TTL tick 到期自动撤单，无账户不结算）
    // opts.orderId 供做市商报价撤换；opts.mmId 触发做市商成交回调（库存更新）
    placeVirtualOrder(symbol, side, price, qty, expiresAtTick, opts?) {
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
            time: Date.now(), virtual: true, expiresAtTick, mmId: opts?.mmId ?? null,
        });
        list.sort((a, b) => isBid ? (b.price - a.price) || (a.time - b.time) : (a.price - b.price) || (a.time - b.time));
    }
    // P2: 清理到期的 AI 虚拟挂单（每 tick 由行情引擎调用）
    pruneExpiredVirtualOrders(currentTick) {
        for (const book of this.realBooks.values()) {
            for (const sideKey of ['bids', 'asks']) {
                const arr = book[sideKey];
                for (let i = arr.length - 1; i >= 0; i--) {
                    if (arr[i].virtual && arr[i].expiresAtTick <= currentTick) {
                        arr.splice(i, 1);
                    }
                }
            }
        }
    }
    // P2: AI 虚拟市价单——只吃真实盘口（AI 虚拟挂单 + 用户挂单），不吃合成深度
    executeVirtualMarketOrder(symbol, side, quantity) {
        const real = this.matchAgainstBook(symbol, side, quantity, undefined, undefined);
        if (real.fills.length === 0)
            return null;
        let totalCost = 0;
        let totalQty = 0;
        for (const f of real.fills) {
            totalCost += f.qty * f.price;
            totalQty += f.qty;
        }
        const avgPrice = totalCost / totalQty;
        return {
            symbol,
            side,
            filledQuantity: totalQty,
            avgPrice: Number(avgPrice.toFixed(4)),
            totalCost: Number(totalCost.toFixed(2)),
            counterFills: real.fills,
        };
    }
    // P1 开盘集合竞价：按最大成交量原则形成开盘价，交叉挂单以开盘价撮合（用户订单走真实结算）
    // 返回 { auctionPrice, fills }；fills 中买卖双方各一条（virtual 标记区分 AI 虚拟挂单）
    // 注：冰山单隐藏量不参与竞价（只按显示量计），与交易所简化口径一致
    runOpeningAuction(symbol, prevClose) {
        const book = this.realBooks.get(symbol);
        if (!book)
            return { auctionPrice: Number(prevClose) || 0, fills: [] };
        const bids = book.bids.slice();
        const asks = book.asks.slice();
        if (bids.length === 0 || asks.length === 0)
            return { auctionPrice: Number(prevClose) || 0, fills: [] };
        const isCN = market_utils_1.isCnSymbol(symbol);
        const base = Number(prevClose) || Number(bids[0].price) || 1;
        const limitUp = isCN ? base * 1.10 : Infinity;
        const limitDown = isCN ? base * 0.90 : 0;
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
            fills.push({ orderId: b.orderId, accountId: b.accountId, side: b.side, price: Number(Number(auctionPrice).toFixed(2)), qty, virtual: !!b.virtual });
            fills.push({ orderId: a.orderId, accountId: a.accountId, side: a.side, price: Number(Number(auctionPrice).toFixed(2)), qty, virtual: !!a.virtual });
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
        return { auctionPrice: Number(Number(auctionPrice).toFixed(2)), fills };
    }
    // SECURITY: 限价单按限价封顶撮合——买入只吃价格<=限价的档位，卖出相反；不足则部分成交
    executeMarketOrderLimited(symbol, side, quantity, limitPrice, excludeAccountId?) {
        const real = this.matchAgainstBook(symbol, side, quantity, limitPrice, excludeAccountId);
        const isBuy = side === order_entity_1.OrderSide.BUY || side === order_entity_1.OrderSide.COVER;
        let totalCost = 0;
        let totalQty = 0;
        for (const f of real.fills) {
            totalCost += f.qty * f.price;
            totalQty += f.qty;
        }
        let remaining = real.remaining;
        const book = this.orderBooks.get(symbol);
        const levels = book ? (isBuy ? book.asks : book.bids) : [];
        for (const level of levels) {
            if (remaining <= 0)
                break;
            const acceptable = isBuy ? level.price <= limitPrice : level.price >= limitPrice;
            if (!acceptable)
                break;
            const fill = Math.min(remaining, level.size);
            totalCost += fill * level.price;
            totalQty += fill;
            remaining -= fill;
        }
        // P2 动态滑点（OFI+波动率，限价约束内）：剩余量按逐档恶化价格成交；封板/无报价时不适用
        if (remaining > 0) {
            const knownPrice = this.prices.get(symbol);
            const sealed = book && (isBuy ? book.sealedUp : book.sealedDown);
            if (!sealed && knownPrice !== undefined && knownPrice !== null) {
                const dirMul = isBuy ? 1 : -1;
                let slip = 0;
                const anchor = levels.length > 0 ? levels[levels.length - 1].price : Number(knownPrice);
                const { step } = this.slipStepFor(symbol, side);
                while (remaining > 0 && slip < 0.02) {
                    const price = anchor * (1 + dirMul * slip);
                    if (isBuy ? price > limitPrice : price < limitPrice)
                        break; // 超出限价不再成交
                    const tranche = Math.min(remaining, 500);
                    totalCost += tranche * price;
                    totalQty += tranche;
                    remaining -= tranche;
                    slip = Math.min(0.02, slip + step);
                }
            }
        }
        if (totalQty === 0)
            return null;
        const avgPrice = totalCost / totalQty;
        return {
            symbol,
            side,
            filledQuantity: totalQty,
            avgPrice: Number(avgPrice.toFixed(4)),
            totalCost: Number(totalCost.toFixed(2)),
            counterFills: real.fills,
        };
    }
}
