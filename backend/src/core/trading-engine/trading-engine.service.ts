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
        // 盘口按股票池动态初始化（支持多股票）
        for (const cfg of constants_1.STOCK_POOL) {
            this.orderBooks.set(cfg.symbol, { bids: [], asks: [] });
        }
        // 用户限价挂单（真实盘口：进入 orderBooks 深度）
        this.userOrders = new Map<string, any[]>();
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
    async resetBoughtToday() {
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
        const arr = this.userOrders.get(symbol) || [];
        arr.push(order);
        this.userOrders.set(symbol, arr);
    }
    removeUserOrder(symbol, orderId) {
        const arr = this.userOrders.get(symbol);
        if (arr) {
            this.userOrders.set(symbol, arr.filter((o) => o.orderId !== orderId));
        }
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
        const asks = [];
        const bids = [];
        for (let i = 0; i < levels; i++) {
            const spreadMult = (i + 1) * baseSpread;
            const askPrice = midPrice * (1 + spreadMult);
            const bidPrice = midPrice * (1 - spreadMult);
            const size = Math.floor(baseSize * liquidityMul * (1 + Math.random()) * (1 - i * 0.12));
            asks.push({ price: Number(askPrice.toFixed(2)), size: Math.max(1, size) });
            bids.push({ price: Number(bidPrice.toFixed(2)), size: Math.max(1, size) });
        }
        book.asks = asks;
        book.bids = bids;
        // 真实盘口：合并用户限价挂单（按价格插入，去重，最多 8 档）
        const userOrders = this.userOrders.get(symbol) || [];
        if (userOrders.length > 0) {
            const merge = (levels, side) => {
                const map = new Map();
                for (const l of levels)
                    map.set(l.price, l.size);
                for (const o of userOrders) {
                    const p = Number(o.price);
                    if (p <= 0)
                        continue;
                    const isBid = o.side === 'buy' || o.side === 'cover';
                    if ((side === 'bid') !== isBid)
                        continue;
                    map.set(p, (map.get(p) || 0) + o.quantity);
                }
                return [...map.entries()]
                    .map(([price, size]) => ({ price: Number(price), size }))
                    .sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
                    .slice(0, 8);
            };
            book.bids = merge(book.bids, 'bid');
            book.asks = merge(book.asks, 'ask');
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
    executeMarketOrder(symbol, side, quantity) {
        const book = this.orderBooks.get(symbol);
        if (!book)
            return null;
        const levels = side === order_entity_1.OrderSide.BUY || side === order_entity_1.OrderSide.COVER
            ? book.asks
            : book.bids;
        if (levels.length === 0)
            return null;
        let remaining = quantity;
        let totalCost = 0;
        let totalQty = 0;
        for (const level of levels) {
            if (remaining <= 0)
                break;
            const fill = Math.min(remaining, level.size);
            totalCost += fill * level.price;
            totalQty += fill;
            remaining -= fill;
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
        };
    }
    async submitOrder(orderData, account) {
        const validation = await this.validateOrder(orderData, account);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        if (orderData.type === order_entity_1.OrderType.MARKET) {
            const fill = this.executeMarketOrder(orderData.symbol, orderData.side, orderData.quantity);
            if (!fill) {
                return { success: false, error: '市场深度不足，无法成交' };
            }
            return { success: true, fill };
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
        // 真实盘口：用户限价挂单进入深度
        if (orderData.price) {
            this.addUserOrder(orderData.symbol, { price: Number(orderData.price), side: orderData.side, quantity: orderData.quantity, orderId: saved.id });
        }
        return { success: true, order: saved };
    }
    async validateOrder(order, account) {
        if (!order.quantity || order.quantity <= 0) {
            return { valid: false, error: '数量必须大于0' };
        }
        if (order.type === order_entity_1.OrderType.LIMIT && (!order.price || order.price <= 0)) {
            return { valid: false, error: '限价单需要有效价格' };
        }
        if (order.type === order_entity_1.OrderType.STOP && (!order.triggerPrice || order.triggerPrice <= 0)) {
            return { valid: false, error: '止损单需要有效触发价' };
        }
        if (order.type === order_entity_1.OrderType.STOP_LIMIT) {
            if (!order.triggerPrice || order.triggerPrice <= 0) {
                return { valid: false, error: '止损限价单需要有效触发价' };
            }
            if (!order.price || order.price <= 0) {
                return { valid: false, error: '止损限价单需要有效限价' };
            }
        }
        const currentPrice = this.prices.get(order.symbol) ?? 0;
        if (order.side === order_entity_1.OrderSide.BUY) {
            const estimatedCost = order.quantity * (order.price || currentPrice);
            if (account.cash < estimatedCost) {
                return { valid: false, error: `资金不足，需要 ${estimatedCost.toFixed(2)}` };
            }
        }
        if (order.side === order_entity_1.OrderSide.SHORT) {
            const margin = order.quantity * (order.price || currentPrice) * constants_1.RISK.marginShortRate;
            if (account.cash < margin) {
                return { valid: false, error: `保证金不足，需要 ${margin.toFixed(2)}` };
            }
        }
        if (order.side === order_entity_1.OrderSide.SELL || order.side === order_entity_1.OrderSide.COVER) {
            const pos = await this.positionRepo.findOne({
                where: { accountId: account.id, symbol: order.symbol },
            });
            const qty = order.side === order_entity_1.OrderSide.SELL ? pos?.longQty ?? 0 : pos?.shortQty ?? 0;
            if (qty < order.quantity) {
                return { valid: false, error: `持仓不足，当前可平 ${qty} 股` };
            }
            // T+1 规则：A 股当日买入的股票次日才能卖出
            if (account.marketMode === 'CN' && order.side === order_entity_1.OrderSide.SELL && pos) {
                const boughtToday = pos.boughtToday || 0;
                const sellable = qty - boughtToday;
                if (order.quantity > sellable) {
                    return { valid: false, error: `A股T+1规则：当日买入的 ${boughtToday} 股需次日方可卖出，当前可卖 ${sellable} 股` };
                }
            }
        }
        return { valid: true };
    }
    // ─── 费用计算（市价单与挂单触发共用） ───
    calcFees(side, turnover, qty = 0, mode = 'US') {
        const fees = mode === 'CN' ? constants_1.CN_FEES : constants_1.US_FEES;
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
    async settleFillInner(accountId, symbol, side, fill, mode) {
        const account = await this.accountRepo.findOne({ where: { id: accountId } });
        if (!account) {
            return { success: false, error: '账户不存在' };
        }
        let pos = await this.positionRepo.findOne({ where: { accountId: account.id, symbol } });
        const totalCost = fill.filledQuantity * fill.avgPrice;
        const fees = this.calcFees(side, fill.totalCost, fill.filledQuantity, mode);
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
            account.cash = Number(account.cash) - totalCost - fees.totalFees + released;
            account.shortCollateral = collateralBefore - released;
        } else if (side === order_entity_1.OrderSide.BUY) {
            account.cash = Number(account.cash) - totalCost - fees.totalFees;
        } else {
            // SELL
            account.cash = Number(account.cash) + totalCost - fees.totalFees;
        }
        await this.accountRepo.save(account);
        if (!pos) {
            pos = this.positionRepo.create({ accountId: account.id, symbol, longQty: 0, shortQty: 0, longCost: 0, shortCost: 0, boughtToday: 0, lockDay: 0 });
        }
        this.updatePosition(pos, side, fill);
        await this.positionRepo.save(pos);
        const tx = this.txRepo.create({ accountId: account.id, symbol, side, quantity: fill.filledQuantity, price: fill.avgPrice, turnover: totalCost, ...fees });
        await this.txRepo.save(tx);
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
            const currentPrice = this.prices.get(order.symbol) ?? 0;
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
                const fill = this.executeMarketOrder(order.symbol, order.side, order.quantity);
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
                    order.status = order_entity_1.OrderStatus.FILLED;
                    order.filledQty = fill.filledQuantity;
                    order.avgFillPrice = fill.avgPrice;
                    await this.orderRepo.save(order);
                    this.removeUserOrder(order.symbol, order.id);
                    fills.push({ ...fill, side: order.side, fees: settle.fees });
                    this.logger.log(`挂单成交: ${order.symbol} ${order.side} ${fill.filledQuantity}股 @ ${fill.avgPrice}`);
                } else {
                    // 结算失败（如资金不足）→ 取消订单，避免每 tick 重复尝试
                    order.status = order_entity_1.OrderStatus.CANCELLED;
                    order.rejectReason = settle.error;
                    await this.orderRepo.save(order);
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
        let totalEquity = Number(account.cash);
        let totalBorrowed = 0; // 借入资金总额
        for (const pos of positions) {
            const price = prices[pos.symbol] ?? 0;
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
        for (const pos of positions) {
            if (pos.longQty > 0) {
                const fill = this.executeMarketOrder(pos.symbol, order_entity_1.OrderSide.SELL, pos.longQty);
                if (fill) {
                    recovered += fill.totalCost;
                    pos.longQty = 0;
                    pos.longCost = 0;
                }
            }
            if (pos.shortQty > 0) {
                const fill = this.executeMarketOrder(pos.symbol, order_entity_1.OrderSide.COVER, pos.shortQty);
                if (fill) {
                    recovered -= fill.totalCost;
                    pos.shortQty = 0;
                    pos.shortCost = 0;
                }
            }
            await this.positionRepo.save(pos);
        }
        account.cash = Number(account.cash) + recovered;
        account.marginUsed = 0;
        account.shortCollateral = 0;
        await this.accountRepo.save(account);
        this.logger.warn(`账户 ${account.id} 已被强制平仓，净回收 ${recovered.toFixed(2)}`);
        return recovered;
    }
    // F7 修复：日终检查所有账户保证金，爆仓（liquidate）则强制平仓
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

