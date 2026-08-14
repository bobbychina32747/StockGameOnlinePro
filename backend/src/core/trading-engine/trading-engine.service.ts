var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import common_1 = require("@nestjs/common");

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import order_entity_1 = require("../../infrastructure/database/entities/order.entity");

import account_entity_1 = require("../../infrastructure/database/entities/account.entity");

import position_entity_1 = require("../../infrastructure/database/entities/position.entity");

import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");

import constants_1 = require("../../common/constants");

let TradingEngineService = class TradingEngineService {
    [key: string]: any;
    constructor(orderRepo, accountRepo, positionRepo, txRepo) {
        this.orderRepo = orderRepo;
        this.accountRepo = accountRepo;
        this.positionRepo = positionRepo;
        this.txRepo = txRepo;
        this.logger = new common_1.Logger(TradingEngineService.name);
        this.orderBooks = new Map<string, any>();
        this.prices = new Map<string, any>();
        this.dayOpenPrices = new Map<string, any>();
        // F4 修复：成交结算串行队列，防止并发下单导致读-改-写竞态（超买/超卖）
        this.settlementQueue = Promise.resolve();
        this.userFillHook = null; // B1 用户成交 → 行情引擎（价格冲击/成交量纳入）
        // 盘口按股票池动态初始化（支持多股票）
        for (const cfg of constants_1.STOCK_POOL) {
            this.orderBooks.set(cfg.symbol, { bids: [], asks: [] });
        }
        // 用户限价挂单（真实盘口：进入 orderBooks 深度）
        this.userOrders = new Map<string, any[]>();
        // P0 真实订单簿：用户限价单常驻盘口队列（价格-时间优先），合成深度仅作流动性补充
        this.realBooks = new Map<string, { bids: any[], asks: any[] }>();
    }
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
    // B1 用户成交回调：成交后通知行情引擎（价格冲击 + 成交量并入当前K线）
    setUserFillHook(fn) {
        this.userFillHook = fn;
    }
    async resetBoughtToday() {
        return this.runExclusive(() => this.resetBoughtTodayInner());
    }
    async resetBoughtTodayInner() {
        // 新交易日重置所有持仓的 boughtToday（T+1 解锁）
        const allPositions = await this.positionRepo.find();
        for (const pos of allPositions) {
            if (pos.boughtToday > 0) {
                pos.boughtToday = 0;
                await this.positionRepo.save(pos);
            }
        }
    }
    refreshOrderBooks(prices) {
        for (const [sym, price] of Object.entries(prices)) {
            this.refreshOrderBook(sym, price);
        }
    }
    addUserOrder(symbol, order) {
        this.placeRestingOrder(symbol, order.orderId, order.accountId, order.side, order.price, order.quantity);
    }
    removeUserOrder(symbol, orderId) {
        this.removeRestingOrder(symbol, orderId);
    }
    // P0 真实订单簿：限价单挂入盘口队列（bids/asks 按价格-时间优先排序）
    placeRestingOrder(symbol, orderId, accountId, side, price, qty) {
        if (!Number.isFinite(Number(price)) || Number(price) <= 0 || !Number.isFinite(Number(qty)) || Number(qty) <= 0)
            return;
        let book = this.realBooks.get(symbol);
        if (!book) {
            book = { bids: [], asks: [] };
            this.realBooks.set(symbol, book);
        }
        const isBid = side === 'buy' || side === 'cover';
        const list = isBid ? book.bids : book.asks;
        list.push({ orderId, accountId, side, price: Number(price), qty: Number(qty), time: Date.now() });
        list.sort((a, b) => isBid ? (b.price - a.price) || (a.time - b.time) : (a.price - b.price) || (a.time - b.time));
    }
    // P0: 从盘口移除挂单（qty 缺省=整单移除；给定 qty=扣减部分数量）
    removeRestingOrder(symbol, orderId, qty?) {
        const book = this.realBooks.get(symbol);
        if (!book)
            return;
        for (const sideKey of ['bids', 'asks']) {
            const arr = book[sideKey];
            for (let i = 0; i < arr.length; i++) {
                if (arr[i].orderId === orderId) {
                    if (qty === undefined || qty >= arr[i].qty) {
                        arr.splice(i, 1);
                    }
                    else {
                        arr[i].qty -= qty;
                    }
                    return;
                }
            }
        }
    }
    // P0 真实订单簿撮合：按价格-时间优先吃对手方真实挂单；返回对手方成交明细与剩余量
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
            fills.push({ orderId: entry.orderId, accountId: entry.accountId, side: entry.side, price: entry.price, qty: fillQty, virtual: !!entry.virtual });
            if (fillQty >= entry.qty) {
                list.splice(i, 1);
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
        // 盘口不存在则动态创建（支持新增股票）
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
        const isCN = !/^H/.test(symbol) && !/^U/.test(symbol);
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
        // P2 滑点模型：剩余量按逐级恶化价格成交（每 500 股恶化 0.1%，上限 2%）；封板/无报价时不适用
        if (remaining > 0) {
            const knownPrice = this.prices.get(symbol);
            const sealed = book && (isBuy ? book.sealedUp : book.sealedDown);
            if (!sealed && knownPrice !== undefined && knownPrice !== null) {
                const dirMul = isBuy ? 1 : -1;
                let slip = 0;
                const anchor = levels.length > 0 ? levels[levels.length - 1].price : Number(knownPrice);
                while (remaining > 0 && slip < 0.02) {
                    slip = Math.min(0.02, slip + 0.001);
                    const tranche = Math.min(remaining, 500);
                    totalCost += tranche * anchor * (1 + dirMul * slip);
                    totalQty += tranche;
                    remaining -= tranche;
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
    placeVirtualOrder(symbol, side, price, qty, expiresAtTick) {
        if (!Number.isFinite(Number(price)) || Number(price) <= 0 || !Number.isFinite(Number(qty)) || Number(qty) <= 0)
            return;
        let book = this.realBooks.get(symbol);
        if (!book) {
            book = { bids: [], asks: [] };
            this.realBooks.set(symbol, book);
        }
        const isBid = side === 'buy' || side === 'cover';
        const list = isBid ? book.bids : book.asks;
        list.push({ orderId: null, accountId: null, side, price: Number(price), qty: Number(qty), time: Date.now(), virtual: true, expiresAtTick });
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
    runOpeningAuction(symbol, prevClose) {
        const book = this.realBooks.get(symbol);
        if (!book)
            return { auctionPrice: Number(prevClose) || 0, fills: [] };
        const bids = book.bids.slice();
        const asks = book.asks.slice();
        if (bids.length === 0 || asks.length === 0)
            return { auctionPrice: Number(prevClose) || 0, fills: [] };
        const isCN = !/^H/.test(symbol) && !/^U/.test(symbol);
        const base = Number(prevClose) || Number(bids[0].price) || 1;
        const limitUp = isCN ? base * 1.10 : Infinity;
        const limitDown = isCN ? base * 0.90 : 0;
        // 候选价：盘口所有价位 + 昨收（A 股限制在涨跌停区间内）
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
        // 用独立剩余计数器撮合（removeEntry 已同步扣减盘口数量，避免双扣减）
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
        // P0: 先撮合真实挂单（限价内），剩余量再吃合成深度
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
        // P2 滑点模型（限价约束内）：剩余量按逐级恶化价格成交；封板/无报价时不适用
        if (remaining > 0) {
            const knownPrice = this.prices.get(symbol);
            const sealed = book && (isBuy ? book.sealedUp : book.sealedDown);
            if (!sealed && knownPrice !== undefined && knownPrice !== null) {
                const dirMul = isBuy ? 1 : -1;
                let slip = 0;
                const anchor = levels.length > 0 ? levels[levels.length - 1].price : Number(knownPrice);
                while (remaining > 0 && slip < 0.02) {
                    const price = anchor * (1 + dirMul * slip);
                    if (isBuy ? price > limitPrice : price < limitPrice)
                        break; // 超出限价不再成交
                    const tranche = Math.min(remaining, 500);
                    totalCost += tranche * price;
                    totalQty += tranche;
                    remaining -= tranche;
                    slip = Math.min(0.02, slip + 0.001);
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
    // P0: 结算对手方真实挂单成交（对方账户走统一结算队列，并同步订单实体的 filledQty/status）
    async settleCounterFills(symbol, mode, counterFills) {
        for (const cf of counterFills) {
            // P2: AI 虚拟挂单（virtual 标记或 orderId=null）无账户，跳过结算
            if (cf.virtual || !cf.orderId)
                continue;
            const cfFill = {
                symbol,
                side: cf.side,
                filledQuantity: cf.qty,
                avgPrice: cf.price,
                totalCost: Number((cf.qty * cf.price).toFixed(2)),
            };
            await this.settleFill(cf.accountId, symbol, cf.side, cfFill, mode);
            const cfOrder = await this.orderRepo.findOne({ where: { id: cf.orderId } });
            if (cfOrder) {
                cfOrder.filledQty = Number(cfOrder.filledQty || 0) + cf.qty;
                if (Number(cfOrder.filledQty) >= Number(cfOrder.quantity)) {
                    cfOrder.status = order_entity_1.OrderStatus.FILLED;
                    cfOrder.avgFillPrice = cf.price;
                }
                await this.orderRepo.save(cfOrder);
            }
        }
    }
    async submitOrder(orderData, account) {
        const validation = await this.validateOrder(orderData, account);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        if (orderData.type === order_entity_1.OrderType.MARKET) {
            const fill = this.executeMarketOrder(orderData.symbol, orderData.side, orderData.quantity, orderData.accountId);
            if (!fill) {
                return { success: false, error: '市场深度不足，无法成交' };
            }
            // P0: 本方结算失败则对手方订单放回盘口（防止对方已卖、本方未买的坏账）
            const settle = await this.settleFill(account.id, orderData.symbol, orderData.side, fill, account.marketMode);
            if (!settle.success) {
                if (fill.counterFills && fill.counterFills.length > 0) {
                    for (const cf of fill.counterFills) {
                        this.placeRestingOrder(orderData.symbol, cf.orderId, cf.accountId, cf.side, cf.price, cf.qty);
                    }
                }
                return { success: false, error: settle.error };
            }
            if (fill.counterFills && fill.counterFills.length > 0) {
                await this.settleCounterFills(orderData.symbol, account.marketMode, fill.counterFills);
            }
            return { success: true, fill, settle };
        }
        if (orderData.type === order_entity_1.OrderType.FOK || orderData.type === order_entity_1.OrderType.IOC) {
            // P2 FOK（全部成交否则取消）/ IOC（立即成交否则取消剩余）：按限价立即撮合，不进入盘口排队
            const limitPrice = Number(orderData.price);
            const fill = this.executeMarketOrderLimited(orderData.symbol, orderData.side, orderData.quantity, limitPrice, orderData.accountId);
            const isFok = orderData.type === order_entity_1.OrderType.FOK;
            const rollback = () => {
                if (fill && fill.counterFills) {
                    for (const cf of fill.counterFills) {
                        this.placeRestingOrder(orderData.symbol, cf.orderId, cf.accountId, cf.side, cf.price, cf.qty);
                    }
                }
            };
            if (!fill) {
                return { success: false, error: isFok ? 'FOK 无法成交，已撤销' : 'IOC 无可成交数量，已撤销' };
            }
            if (isFok && fill.filledQuantity < Number(orderData.quantity)) {
                rollback();
                return { success: false, error: 'FOK 无法全部成交，已撤销' };
            }
            const settle = await this.settleFill(account.id, orderData.symbol, orderData.side, fill, account.marketMode);
            if (!settle.success) {
                rollback();
                return { success: false, error: settle.error };
            }
            if (fill.counterFills && fill.counterFills.length > 0) {
                await this.settleCounterFills(orderData.symbol, account.marketMode, fill.counterFills);
            }
            // 记录成交订单实体（不排队）
            const order = this.orderRepo.create({
                userId: orderData.userId,
                accountId: orderData.accountId,
                symbol: orderData.symbol,
                type: orderData.type,
                side: orderData.side,
                price: orderData.price,
                triggerPrice: orderData.triggerPrice,
                quantity: orderData.quantity,
                status: order_entity_1.OrderStatus.FILLED,
                filledQty: fill.filledQuantity,
                avgFillPrice: fill.avgPrice,
            });
            await this.orderRepo.save(order);
            return { success: true, fill, settle };
        }
        const order = this.orderRepo.create({
            userId: orderData.userId,
            accountId: orderData.accountId,
            symbol: orderData.symbol,
            type: orderData.type,
            side: orderData.side,
            price: orderData.price,
            triggerPrice: orderData.triggerPrice,
            quantity: orderData.quantity,
            status: order_entity_1.OrderStatus.PENDING,
        });
        const saved = await this.orderRepo.save(order);
        // P0 真实盘口：限价单挂入盘口队列（价格-时间优先）
        if (orderData.price) {
            this.placeRestingOrder(orderData.symbol, saved.id, orderData.accountId, orderData.side, orderData.price, orderData.quantity);
            // 立即尝试撮合：挂单价与对手方真实挂单交叉时按对手价成交（价格改善）
            const crossed = this.matchAgainstBook(orderData.symbol, orderData.side, orderData.quantity, Number(orderData.price), orderData.accountId);
            if (crossed.fills.length > 0) {
                const filledQty = Number(orderData.quantity) - crossed.remaining;
                this.removeRestingOrder(orderData.symbol, saved.id, filledQty);
                let totalCost = 0;
                for (const f of crossed.fills)
                    totalCost += f.qty * f.price;
                const avgPrice = filledQty > 0 ? totalCost / filledQty : Number(orderData.price);
                saved.filledQty = filledQty;
                saved.avgFillPrice = Number(avgPrice.toFixed(4));
                if (filledQty >= Number(orderData.quantity)) {
                    saved.status = order_entity_1.OrderStatus.FILLED;
                }
                await this.orderRepo.save(saved);
                const ownFill = {
                    symbol: orderData.symbol,
                    side: orderData.side,
                    filledQuantity: filledQty,
                    avgPrice: Number(avgPrice.toFixed(4)),
                    totalCost: Number(totalCost.toFixed(2)),
                };
                // P0: 先结算本方；失败则对手方订单放回盘口、本方订单取消（避免单边坏账）
                const settle = await this.settleFill(account.id, orderData.symbol, orderData.side, ownFill, account.marketMode);
                if (!settle.success) {
                    for (const f of crossed.fills) {
                        this.placeRestingOrder(orderData.symbol, f.orderId, f.accountId, f.side, f.price, f.qty);
                    }
                    saved.status = order_entity_1.OrderStatus.CANCELLED;
                    saved.rejectReason = settle.error;
                    await this.orderRepo.save(saved);
                    this.removeRestingOrder(orderData.symbol, saved.id);
                    return { success: false, error: settle.error };
                }
                await this.settleCounterFills(orderData.symbol, account.marketMode, crossed.fills);
            }
        }
        return { success: true, order: saved };
    }
    async validateOrder(order, account) {
        // P0: 部分成交的挂单按剩余数量校验（真实订单簿支持部分成交后继续排队）
        const remainingQty = Number(order.quantity) - Number(order.filledQty || 0);
        if (!Number.isFinite(remainingQty) || remainingQty <= 0) {
            return { valid: false, error: '订单已无剩余数量' };
        }
        // SECURITY: 数量/价格必须为有限数字并设上限，防止 Infinity/NaN/超大数量
        if (!Number.isFinite(Number(order.quantity)) || !Number.isInteger(Number(order.quantity)) || Number(order.quantity) <= 0 || Number(order.quantity) > 1000000) {
            return { valid: false, error: '数量必须为 1~1000000 的整数' };
        }
        // SECURITY: 拒绝不存在的股票（订单簿/报价中均无此 symbol），防止垃圾挂单无限累积
        if (!this.prices.has(order.symbol) && !this.orderBooks.has(order.symbol)) {
            return { valid: false, error: '股票不存在，请检查代码' };
        }
        const needsPrice = order.type === order_entity_1.OrderType.LIMIT || order.type === order_entity_1.OrderType.FOK || order.type === order_entity_1.OrderType.IOC;
        if (needsPrice && (!Number.isFinite(Number(order.price)) || Number(order.price) <= 0 || Number(order.price) > 1000000)) {
            return { valid: false, error: '限价/FOK/IOC 指令需要有效价格（0~1000000）' };
        }
        if (order.type === order_entity_1.OrderType.STOP && (!Number.isFinite(Number(order.triggerPrice)) || Number(order.triggerPrice) <= 0 || Number(order.triggerPrice) > 1000000)) {
            return { valid: false, error: '止损单需要有效触发价（0~1000000）' };
        }
        if (order.type === order_entity_1.OrderType.STOP_LIMIT) {
            if (!Number.isFinite(Number(order.triggerPrice)) || Number(order.triggerPrice) <= 0 || Number(order.triggerPrice) > 1000000) {
                return { valid: false, error: '止损限价单需要有效触发价（0~1000000）' };
            }
            if (!Number.isFinite(Number(order.price)) || Number(order.price) <= 0 || Number(order.price) > 1000000) {
                return { valid: false, error: '止损限价单需要有效限价（0~1000000）' };
            }
        }
        // 价格规范到2位小数，避免无限小数进入盘口
        if (order.price)
            order.price = Math.round(Number(order.price) * 100) / 100;
        if (order.triggerPrice)
            order.triggerPrice = Math.round(Number(order.triggerPrice) * 100) / 100;
        const currentPrice = this.prices.get(order.symbol) ?? 0;
        if (order.side === order_entity_1.OrderSide.BUY) {
            const estimatedCost = remainingQty * (order.price || currentPrice);
            if (account.cash < estimatedCost) {
                return { valid: false, error: `资金不足，需要 ${estimatedCost.toFixed(2)}` };
            }
        }
        if (order.side === order_entity_1.OrderSide.SHORT) {
            const margin = remainingQty * (order.price || currentPrice) * constants_1.RISK.marginShortRate;
            if (account.cash < margin) {
                return { valid: false, error: `保证金不足，需要 ${margin.toFixed(2)}` };
            }
        }
        if (order.side === order_entity_1.OrderSide.SELL || order.side === order_entity_1.OrderSide.COVER) {
            const pos = await this.positionRepo.findOne({
                where: { accountId: account.id, symbol: order.symbol },
            });
            const qty = order.side === order_entity_1.OrderSide.SELL ? pos?.longQty ?? 0 : pos?.shortQty ?? 0;
            if (qty < remainingQty) {
                return { valid: false, error: `持仓不足，当前可平 ${qty} 股` };
            }
            // T+1 规则：A 股当日买入的股票次日才能卖出
            if (account.marketMode === 'CN' && order.side === order_entity_1.OrderSide.SELL && pos) {
                const boughtToday = pos.boughtToday || 0;
                const sellable = qty - boughtToday;
                if (remainingQty > sellable) {
                    return { valid: false, error: `A股T+1规则：当日买入的 ${boughtToday} 股需次日方可卖出，当前可卖 ${sellable} 股` };
                }
            }
        }
        return { valid: true };
    }
    // ─── 费用计算（市价单与挂单触发共用） ───
    calcFees(side, turnover, qty = 0, mode = 'US') {
        const fees = mode === 'CN' ? constants_1.CN_FEES : mode === 'HK' ? constants_1.HK_FEES : constants_1.US_FEES;
        const commission = Math.max(turnover * fees.commissionRate, fees.minCommission);
        const stampDuty = (side === order_entity_1.OrderSide.SELL || side === order_entity_1.OrderSide.COVER) ? turnover * fees.stampDutyRate : 0;
        const transferFee = turnover * fees.transferFeeRate;
        const secFee = (side === order_entity_1.OrderSide.SELL || side === order_entity_1.OrderSide.COVER) ? turnover * fees.secFeeRate : 0;
        const tafFee = (side === order_entity_1.OrderSide.SELL || side === order_entity_1.OrderSide.COVER) ? qty * fees.tafFeePerShare : 0;
        const totalFees = commission + stampDuty + transferFee + secFee + tafFee;
        return {
            commission: Number(commission.toFixed(4)),
            stampDuty: Number(stampDuty.toFixed(4)),
            transferFee: Number(transferFee.toFixed(4)),
            secFee: Number(secFee.toFixed(4)),
            tafFee: Number(tafFee.toFixed(4)),
            totalFees: Number(totalFees.toFixed(4)),
        };
    }
    // ─── 更新持仓（根据买卖方向） ───
    updatePosition(pos, side, fill) {
        if (side === order_entity_1.OrderSide.BUY) {
            const newCost = ((pos.longCost * pos.longQty) + (fill.avgPrice * fill.filledQuantity)) / (pos.longQty + fill.filledQuantity);
            pos.longQty += fill.filledQuantity;
            pos.longCost = newCost;
            pos.boughtToday += fill.filledQuantity;
        } else if (side === order_entity_1.OrderSide.SELL) {
            pos.longQty -= fill.filledQuantity;
            if (pos.longQty <= 0) { pos.longQty = 0; pos.longCost = 0; }
        } else if (side === order_entity_1.OrderSide.SHORT) {
            const newCost = ((pos.shortCost * pos.shortQty) + (fill.avgPrice * fill.filledQuantity)) / (pos.shortQty + fill.filledQuantity);
            pos.shortQty += fill.filledQuantity;
            pos.shortCost = newCost;
        } else if (side === order_entity_1.OrderSide.COVER) {
            pos.shortQty -= fill.filledQuantity;
            if (pos.shortQty <= 0) { pos.shortQty = 0; pos.shortCost = 0; }
        }
        return pos;
    }
    // ─── 统一成交结算：扣款/持仓/交易记录（市价单与挂单触发共用） ───
    // 修复：做空卖出得现金并冻结保证金，平空时按比例释放冻结，亏损/盈利正确计入现金
    // F4 修复：结算串行化，防止并发下单读-改-写竞态；结算时二次校验资金/保证金
    settleFill(accountId, symbol, side, fill, mode) {
        const run = this.settlementQueue.then(() => this.settleFillInner(accountId, symbol, side, fill, mode));
        this.settlementQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    // F4 扩展：通用互斥队列——分红/日初重置/强平等资金操作与成交结算串行化，避免读-改-写竞态
    runExclusive(fn) {
        const run = this.settlementQueue.then(() => fn());
        this.settlementQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    async settleFillInner(accountId, symbol, side, fill, mode) {
        const account = await this.accountRepo.findOne({ where: { id: accountId } });
        if (!account) {
            return { success: false, error: '账户不存在' };
        }
        let pos = await this.positionRepo.findOne({ where: { accountId: account.id, symbol } });
        const totalCost = fill.filledQuantity * fill.avgPrice;
        const fees = this.calcFees(side, fill.totalCost, fill.filledQuantity, mode);
        // SECURITY: 结算队列内复核持仓与T+1（validateOrder 在队列外执行，并发下会双卖/双平空刷钱）
        if (side === order_entity_1.OrderSide.SELL) {
            const longQty = pos ? Number(pos.longQty) : 0;
            if (longQty < fill.filledQuantity) {
                return { success: false, error: `持仓不足，当前可卖 ${longQty} 股` };
            }
            if (mode === 'CN' && pos && fill.filledQuantity > longQty - (pos.boughtToday || 0)) {
                return { success: false, error: `A股T+1规则：当日买入 ${pos.boughtToday || 0} 股需次日方可卖出` };
            }
        }
        if (side === order_entity_1.OrderSide.COVER) {
            const shortQty = pos ? Number(pos.shortQty) : 0;
            if (shortQty < fill.filledQuantity) {
                return { success: false, error: `空头持仓不足，当前可平 ${shortQty} 股` };
            }
        }
        // 结算时二次校验（防并发下单超买）
        if (side === order_entity_1.OrderSide.BUY) {
            if (Number(account.cash) < totalCost + fees.totalFees) {
                return { success: false, error: `资金不足，需要 ${(totalCost + fees.totalFees).toFixed(2)}` };
            }
        }
        if (side === order_entity_1.OrderSide.SHORT) {
            const margin = totalCost * constants_1.RISK.marginShortRate;
            if (Number(account.cash) < margin) {
                return { success: false, error: `保证金不足，需要 ${margin.toFixed(2)}` };
            }
        }
        if (side === order_entity_1.OrderSide.SHORT) {
            // 卖出得现金，冻结 50% 保证金
            const collateral = totalCost * constants_1.RISK.marginShortRate;
            account.cash = Number(account.cash) + totalCost - fees.totalFees - collateral;
            account.shortCollateral = Number(account.shortCollateral || 0) + collateral;
        } else if (side === order_entity_1.OrderSide.COVER) {
            // 买回平仓，按平仓比例释放冻结保证金（pos.shortQty 为平仓前的空仓量）
            const collateralBefore = Number(account.shortCollateral || 0);
            const totalShortQty = pos ? Number(pos.shortQty) : 0;
            const released = totalShortQty > 0 ? collateralBefore * (fill.filledQuantity / totalShortQty) : 0;
            // SECURITY: 平空资金校验，防止亏损平空导致现金为负
            if (Number(account.cash) + released < totalCost + fees.totalFees) {
                return { success: false, error: `平空资金不足：需 ${(totalCost + fees.totalFees).toFixed(2)} 元，现金+可释放保证金仅 ${(Number(account.cash) + released).toFixed(2)} 元` };
            }
            account.cash = Number(account.cash) - totalCost - fees.totalFees + released;
            account.shortCollateral = collateralBefore - released;
        } else if (side === order_entity_1.OrderSide.BUY) {
            account.cash = Number(account.cash) - totalCost - fees.totalFees;
        } else {
            // SELL
            account.cash = Number(account.cash) + totalCost - fees.totalFees;
        }
        // FIX(H4): 现金规范化到分，减少浮点累积误差
        account.cash = Math.round(account.cash * 100) / 100;
        account.totalTrades = (Number(account.totalTrades) || 0) + 1;
        await this.accountRepo.save(account);
        if (!pos) {
            pos = this.positionRepo.create({ accountId: account.id, symbol, longQty: 0, shortQty: 0, longCost: 0, shortCost: 0, boughtToday: 0, lockDay: 0 });
        }
        this.updatePosition(pos, side, fill);
        await this.positionRepo.save(pos);
        const tx = this.txRepo.create({ accountId: account.id, symbol, side, quantity: fill.filledQuantity, price: fill.avgPrice, turnover: totalCost, ...fees });
        await this.txRepo.save(tx);
        // B1 用户成交计入行情：价格冲击 + 成交量并入当前 tick 的 K 线
        if (this.userFillHook) {
            try {
                this.userFillHook({ symbol, side, filledQuantity: fill.filledQuantity, avgPrice: fill.avgPrice });
            }
            catch (e) { }
        }
        this.logger.log(`成交: ${symbol} ${side} ${fill.filledQuantity}股 @ ${fill.avgPrice}`);
        return {
            success: true,
            fill: { symbol: fill.symbol, side, quantity: fill.filledQuantity, price: fill.avgPrice, totalCost, fees },
            fees,
        };
    }
    async checkPendingOrders() {
        const pending = await this.orderRepo.find({
            where: [
                { status: order_entity_1.OrderStatus.PENDING, type: order_entity_1.OrderType.LIMIT },
                { status: order_entity_1.OrderStatus.PENDING, type: order_entity_1.OrderType.STOP },
                { status: order_entity_1.OrderStatus.PENDING, type: order_entity_1.OrderType.STOP_LIMIT },
            ],
        });
        const fills = [];
        for (const order of pending) {
            // SECURITY: 无报价的 symbol 跳过（缺失价格不能当 0 处理，否则误触发成交）
            const currentPrice = this.prices.get(order.symbol);
            if (currentPrice === undefined || currentPrice === null)
                continue;
            let shouldFill = false;
            if (order.type === order_entity_1.OrderType.LIMIT) {
                if (order.side === order_entity_1.OrderSide.BUY && currentPrice <= order.price)
                    shouldFill = true;
                if (order.side === order_entity_1.OrderSide.SELL && currentPrice >= order.price)
                    shouldFill = true;
            }
            else if (order.type === order_entity_1.OrderType.STOP) {
                if (order.side === order_entity_1.OrderSide.BUY && currentPrice >= order.triggerPrice)
                    shouldFill = true;
                if (order.side === order_entity_1.OrderSide.SELL && currentPrice <= order.triggerPrice)
                    shouldFill = true;
            }
            else if (order.type === order_entity_1.OrderType.STOP_LIMIT) {
                const triggered = (order.side === order_entity_1.OrderSide.BUY && currentPrice >= order.triggerPrice) ||
                    (order.side === order_entity_1.OrderSide.SELL && currentPrice <= order.triggerPrice);
                if (triggered) {
                    shouldFill = (order.side === order_entity_1.OrderSide.BUY && currentPrice <= order.price) ||
                        (order.side === order_entity_1.OrderSide.SELL && currentPrice >= order.price);
                }
            }
            if (shouldFill) {
                // P0: 部分成交的挂单按剩余数量继续撮合（真实订单簿支持排队部分成交）
                const remainingQty = Number(order.quantity) - Number(order.filledQty || 0);
                if (remainingQty <= 0)
                    continue;
                // SECURITY: 限价/止损限价按限价封顶撮合，避免成交价突破限价；自成交排除
                const isPriced = order.type === order_entity_1.OrderType.LIMIT || order.type === order_entity_1.OrderType.STOP_LIMIT;
                const fill = isPriced
                    ? this.executeMarketOrderLimited(order.symbol, order.side, remainingQty, Number(order.price), order.accountId)
                    : this.executeMarketOrder(order.symbol, order.side, remainingQty, order.accountId);
                if (!fill) {
                    continue;
                }
                // 重新加载账户：资金/持仓可能在挂单期间已变化
                const account = await this.accountRepo.findOne({ where: { id: order.accountId } });
                if (!account) {
                    continue;
                }
                // 成交前重新校验（资金/持仓/T+1），失败则取消订单，防止超买/超卖
                const recheck = await this.validateOrder(order, account);
                if (!recheck.valid) {
                    order.status = order_entity_1.OrderStatus.CANCELLED;
                    order.rejectReason = recheck.error;
                    await this.orderRepo.save(order);
                    this.removeUserOrder(order.symbol, order.id);
                    this.logger.warn(`挂单 ${order.id} 触发但校验失败已取消: ${recheck.error}`);
                    continue;
                }
                const settle = await this.settleFill(order.accountId, order.symbol, order.side, fill, account.marketMode);
                if (settle.success) {
                    // P0: 先结算本方，成功后结算对手方真实挂单并同步其订单实体
                    if (fill.counterFills && fill.counterFills.length > 0) {
                        await this.settleCounterFills(order.symbol, account.marketMode, fill.counterFills);
                    }
                    order.filledQty = Number(order.filledQty || 0) + fill.filledQuantity;
                    order.avgFillPrice = fill.avgPrice;
                    if (Number(order.filledQty) >= Number(order.quantity)) {
                        order.status = order_entity_1.OrderStatus.FILLED;
                        this.removeUserOrder(order.symbol, order.id);
                    }
                    else {
                        // 部分成交：剩余数量继续在真实盘口排队
                        this.removeRestingOrder(order.symbol, order.id, fill.filledQuantity);
                    }
                    await this.orderRepo.save(order);
                    fills.push({ ...fill, side: order.side, fees: settle.fees });
                    this.logger.log(`挂单成交: ${order.symbol} ${order.side} ${fill.filledQuantity}股 @ ${fill.avgPrice}`);
                } else {
                    // 结算失败 → 对手方订单放回盘口、本方订单取消，避免每 tick 重复尝试
                    if (fill.counterFills && fill.counterFills.length > 0) {
                        for (const cf of fill.counterFills) {
                            this.placeRestingOrder(order.symbol, cf.orderId, cf.accountId, cf.side, cf.price, cf.qty);
                        }
                    }
                    order.status = order_entity_1.OrderStatus.CANCELLED;
                    order.rejectReason = settle.error;
                    await this.orderRepo.save(order);
                    this.removeUserOrder(order.symbol, order.id);
                    this.logger.warn(`挂单 ${order.id} 结算失败已取消: ${settle.error}`);
                }
            }
        }
        return fills;
    }
    async cancelOrder(orderId, accountId) {
        const order = await this.orderRepo.findOne({
            where: { id: orderId, accountId, status: order_entity_1.OrderStatus.PENDING },
        });
        if (!order)
            return false;
        order.status = order_entity_1.OrderStatus.CANCELLED;
        await this.orderRepo.save(order);
        this.removeUserOrder(order.symbol, order.id);
        return true;
    }
    // 玩法：分红现金到账（日终结算，按持仓数量发放）
    async payDividends(dividends) {
        return this.runExclusive(() => this.payDividendsInner(dividends));
    }
    async payDividendsInner(dividends) {
        if (!dividends || dividends.length === 0)
            return 0;
        const allPositions = await this.positionRepo.find({ relations: ['account'] });
        let paid = 0;
        for (const pos of allPositions) {
            const div = dividends.find((d) => d.symbol === pos.symbol);
            if (!div)
                continue;
            const qty = (pos.longQty || 0) - (pos.shortQty || 0);
            if (qty <= 0)
                continue;
            const amount = Number((qty * Number(div.perShare)).toFixed(2));
            pos.account.cash = Number(pos.account.cash) + amount;
            await this.accountRepo.save(pos.account);
            // C3 分红进交易流水
            try {
                await this.txRepo.save(this.txRepo.create({
                    accountId: pos.account.id,
                    symbol: pos.symbol,
                    side: 'DIVIDEND',
                    quantity: qty,
                    price: Number(div.perShare),
                    turnover: amount,
                    commission: 0, stampDuty: 0, transferFee: 0, totalFees: 0,
                }));
            }
            catch (e) { }
            paid += amount;
            this.logger.log(`💰 分红到账: ${pos.symbol} ${qty}股 × ${div.perShare}元 = ${amount}元`);
        }
        return paid;
    }
    async getPendingOrders(accountId) {
        return this.orderRepo.find({
            where: { accountId, status: order_entity_1.OrderStatus.PENDING },
            order: { createdAt: 'DESC' },
        });
    }
    async checkMarginLevel(account, prices) {
        const positions = await this.positionRepo.find({ where: { accountId: account.id } });
        // SECURITY: 冻结保证金属于用户资产，计入权益（避免误判过早强平）
        let totalEquity = Number(account.cash) + Number(account.shortCollateral || 0);
        let totalBorrowed = 0; // 借入资金总额
        for (const pos of positions) {
            const price = prices[pos.symbol];
            if (price === undefined || price === null)
                continue; // 无报价持仓跳过估值，避免按 0 计
            totalEquity += pos.longQty * price - pos.shortQty * price;
            // 多仓借入资金 = 持仓市值 × (1 - 1/杠杆倍数)
            totalBorrowed += pos.longQty * price * (1 - 1 / Number(account.leverage || 1));
            // 做空保证金要求 = 做空市值 × 保证金率
            totalBorrowed += pos.shortQty * price * constants_1.RISK.marginShortRate;
        }
        // 无借入资金 = 安全
        if (totalBorrowed <= 0) {
            return { safe: true, action: 'ok', marginLevel: 999 };
        }
        // 保证金率 = 总权益 / 借入资金
        const marginLevel = totalEquity / totalBorrowed;
        if (marginLevel < constants_1.RISK.forceLiquidationLevel) {
            return { safe: false, action: 'liquidate', marginLevel };
        }
        if (marginLevel < constants_1.RISK.maintenanceMargin) {
            return { safe: false, action: 'margin_call', marginLevel };
        }
        return { safe: true, action: 'ok', marginLevel };
    }
    async forceLiquidate(account) {
        const positions = await this.positionRepo.find({ where: { accountId: account.id } });
        let recovered = 0;
        let totalFees = 0;
        for (const pos of positions) {
            if (pos.longQty > 0) {
                const fill = this.executeMarketOrder(pos.symbol, order_entity_1.OrderSide.SELL, pos.longQty);
                if (fill) {
                    recovered += fill.totalCost;
                    totalFees += this.calcFees(order_entity_1.OrderSide.SELL, fill.totalCost, fill.filledQuantity, account.marketMode).totalFees;
                    pos.longQty = 0;
                    pos.longCost = 0;
                }
            }
            if (pos.shortQty > 0) {
                const fill = this.executeMarketOrder(pos.symbol, order_entity_1.OrderSide.COVER, pos.shortQty);
                if (fill) {
                    recovered -= fill.totalCost;
                    totalFees += this.calcFees(order_entity_1.OrderSide.COVER, fill.totalCost, fill.filledQuantity, account.marketMode).totalFees;
                    pos.shortQty = 0;
                    pos.shortCost = 0;
                }
            }
            await this.positionRepo.save(pos);
        }
        // SECURITY: 强平归还冻结保证金并按标准计费（原实现清零保证金不归还、不计费，等于吞用户资产）
        const releasedCollateral = Number(account.shortCollateral || 0);
        account.cash = Math.round((Number(account.cash) + recovered - totalFees + releasedCollateral) * 100) / 100;
        account.marginUsed = 0;
        account.shortCollateral = 0;
        await this.accountRepo.save(account);
        this.logger.warn(`账户 ${account.id} 已被强制平仓，净回收 ${recovered.toFixed(2)}，费用 ${totalFees.toFixed(2)}，归还保证金 ${releasedCollateral.toFixed(2)}`);
        return recovered;
    }
    // F7 修复：日终检查所有账户保证金，爆仓（liquidate）则强制平仓
    async getAccountById(accountId) {
        try {
            return await this.accountRepo.findOne({ where: { id: accountId } });
        }
        catch (e) {
            return null;
        }
    }
    async forceLiquidateMarginalAccounts() {
        const accounts = await this.accountRepo.find();
        const priceObj = {};
        for (const [sym, price] of this.prices) {
            priceObj[sym] = price;
        }
        const liquidated = [];
        for (const account of accounts) {
            try {
                const margin = await this.checkMarginLevel(account, priceObj);
                if (margin.action === 'liquidate') {
                    await this.forceLiquidate(account);
                    liquidated.push({ accountId: account.id, marginLevel: Number(margin.marginLevel.toFixed(4)) });
                    this.logger.warn(`账户 ${account.id} 爆仓强平，保证金率 ${margin.marginLevel.toFixed(4)}`);
                }
            }
            catch (e) {
                this.logger.error(`强平检查失败 account=${account.id}: ${e.message}`);
            }
        }
        return liquidated;
    }
};

export { TradingEngineService };

TradingEngineService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(order_entity_1.Order)),
    __param(1, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(2, (0, typeorm_1.InjectRepository)(position_entity_1.Position)),
    __param(3, (0, typeorm_1.InjectRepository)(transaction_entity_1.Transaction)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
],
TradingEngineService
);

