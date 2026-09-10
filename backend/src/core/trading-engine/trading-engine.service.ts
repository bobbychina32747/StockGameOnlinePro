// 交易引擎（资金安全核心）：撮合/盘口/竞价/券源池等纯逻辑全部委托 MatchingEngine（P2，可直接单测），
// 本类负责委托校验与排队、账户-持仓-流水的统一结算（settleFill）、止损/冰山/盘后固定价格交易、
// 分红快照与发放、强平与追保。所有资金读-改-写一律走 settlementQueue 串行队列（F4：settleFill / runExclusive）。
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Order, OrderSide, OrderStatus, OrderType } from '../../infrastructure/database/entities/order.entity';
import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';
// Phase A: 分红登记日持仓快照（按快照发息封堵除权日套利）
import { DividendSnapshot } from '../../infrastructure/database/entities/dividend-snapshot.entity';
import { CN_FEES, HK_FEES, RISK, STOCK_POOL, US_FEES, dividendTaxRate, shortMarginRateFor } from '../../common/constants';
// Phase B: 跨市场校验与涨跌停统一区间
import { cnPriceLimits, symbolMarket } from '../../common/market-utils';
import { MatchingEngine } from './matching-engine';

// 成交明细入参：撮合引擎输出 / 对手方挂单成交 / 集合竞价成交共用。各调用点字段略有差异
// （对手方成交无 symbol/side 语义、竞价成交无 totalCost 兜底），故保留索引签名，均价+数量为结算必需字段
interface TradeFill {
    symbol?: string;
    side?: string;
    filledQuantity: number;
    avgPrice: number;
    totalCost?: number;
    [key: string]: any;
}

@Injectable()
export class TradingEngineService {
    private readonly logger: Logger;
    // P2 撮合引擎独立成类：盘口/撮合/竞价纯逻辑全部在 MatchingEngine（可直接单测）
    private readonly matching: MatchingEngine;
    // maps 别名共享：旧代码（行情引擎/风控/测试）直接访问 this.orderBooks/realBooks/prices 不受影响
    orderBooks: Map<string, any>;
    realBooks: Map<string, any>;
    prices: Map<string, any>;
    dayOpenPrices: Map<string, any>;
    volatilities: Map<string, any>;
    // Phase B: 昨收同步代理（涨跌停基准）
    prevCloses: Map<string, any>;
    // Phase B: 新股首日集合代理（委托价带宽）
    ipoFirstDay: Set<string>;
    // 用户限价挂单（真实盘口：进入 orderBooks 深度）
    userOrders: Map<string, any[]>;
    // Phase B: 盘后固定价格交易独立队列（不互吃连续竞价遗留挂单，15:30 未成交自动撤销）
    closingBook: Map<string, { bids: any[]; asks: any[] }>;
    // F4 修复：成交结算串行队列，防止并发下单导致读-改-写竞态（超买/超卖）
    settlementQueue: Promise<void>;
    // B1 用户成交 → 行情引擎（价格冲击/成交量纳入）
    userFillHook: ((fill: any) => void) | null;

    constructor(
        @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(Position) private readonly positionRepo: Repository<Position>,
        @InjectRepository(Transaction) private readonly txRepo: Repository<Transaction>,
        @InjectRepository(DividendSnapshot) private readonly dividendSnapshotRepo: Repository<DividendSnapshot>,
    ) {
        this.logger = new Logger(TradingEngineService.name);
        this.matching = new MatchingEngine();
        this.orderBooks = this.matching.orderBooks;
        this.realBooks = this.matching.realBooks;
        this.prices = this.matching.prices;
        this.dayOpenPrices = this.matching.dayOpenPrices;
        this.volatilities = this.matching.volatilities;
        this.settlementQueue = Promise.resolve();
        this.userFillHook = null; // B1 用户成交 → 行情引擎（价格冲击/成交量纳入）
        // 盘口按股票池动态初始化（支持多股票）
        for (const cfg of STOCK_POOL) {
            this.orderBooks.set(cfg.symbol, { bids: [], asks: [] });
        }
        // 用户限价挂单（真实盘口：进入 orderBooks 深度）
        this.userOrders = new Map<string, any[]>();
        // Phase B: 盘后固定价格交易独立队列（不互吃连续竞价遗留挂单，15:30 未成交自动撤销）
        this.closingBook = new Map<string, { bids: any[]; asks: any[] }>();
        // Phase B: 昨收同步代理（涨跌停基准）
        this.prevCloses = this.matching.prevCloses;
        // Phase B: 新股首日集合代理（委托价带宽）
        this.ipoFirstDay = this.matching.ipoFirstDay;
    }

    // ─── P2 委托 MatchingEngine 的撮合纯逻辑 ───
    updatePrices(prices: Record<string, any>) {
        this.matching.updatePrices(prices);
    }
    setDayOpen(prices: Record<string, any>) {
        this.matching.setDayOpen(prices);
    }
    // Phase B: 昨收同步（涨跌停/委托价校验基准）
    setPrevCloses(prevCloses: Record<string, any>) {
        this.matching.setPrevCloses(prevCloses);
    }
    setVolatilities(vols: Record<string, any>) {
        this.matching.setVolatilities(vols);
    }
    setVirtualFillHook(fn: (fill: any) => void) {
        this.matching.setVirtualFillHook(fn);
    }
    refreshOrderBooks(prices: Record<string, any>) {
        this.matching.refreshOrderBooks(prices);
    }
    refreshOrderBook(symbol: string, midPrice: number) {
        this.matching.refreshOrderBook(symbol, midPrice);
    }
    getOrderBook(symbol: string) {
        return this.matching.getOrderBook(symbol);
    }
    placeRestingOrder(symbol: string, orderId: string, accountId: string, side: string, price: number, qty: number, opts?: { displayQty?: number; hiddenQty?: number }) {
        this.matching.placeRestingOrder(symbol, orderId, accountId, side, price, qty, opts);
    }
    removeRestingOrder(symbol: string, orderId: string, qty?: number) {
        this.matching.removeRestingOrder(symbol, orderId, qty);
    }
    matchAgainstBook(symbol: string, side: string, quantity: number, limitPrice: number, excludeAccountId: string) {
        return this.matching.matchAgainstBook(symbol, side, quantity, limitPrice, excludeAccountId);
    }
    executeMarketOrder(symbol: string, side: string, quantity: number, excludeAccountId?: string) {
        return this.matching.executeMarketOrder(symbol, side, quantity, excludeAccountId);
    }
    executeMarketOrderLimited(symbol: string, side: string, quantity: number, limitPrice: number, excludeAccountId?: string) {
        return this.matching.executeMarketOrderLimited(symbol, side, quantity, limitPrice, excludeAccountId);
    }
    // P0-3: opts 增加 tag 透传（AI 虚拟挂单归属标识，成交回调按 tag 定位 AI 账本）
    placeVirtualOrder(symbol: string, side: string, price: number, qty: number, expiresAtTick: number, opts?: { orderId?: string; mmId?: string; tag?: string }) {
        this.matching.placeVirtualOrder(symbol, side, price, qty, expiresAtTick, opts);
    }
    pruneExpiredVirtualOrders(currentTick: number) {
        this.matching.pruneExpiredVirtualOrders(currentTick);
    }
    executeVirtualMarketOrder(symbol: string, side: string, quantity: number) {
        return this.matching.executeVirtualMarketOrder(symbol, side, quantity);
    }
    runOpeningAuction(symbol: string, prevClose: number) {
        return this.matching.runOpeningAuction(symbol, prevClose);
    }
    setIpoFirstDays(symbols: string[]) {
        this.matching.setIpoFirstDays(symbols);
    }
    getShortPool(symbol: string) {
        return this.matching.getShortPool(symbol);
    }
    consumeShort(symbol: string, qty: number) {
        return this.matching.consumeShort(symbol, qty);
    }
    returnShort(symbol: string, qty: number) {
        return this.matching.returnShort(symbol, qty);
    }
    // B1 用户成交回调：成交后通知行情引擎（价格冲击 + 成交量并入当前K线）
    setUserFillHook(fn: (fill: any) => void) {
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
    addUserOrder(symbol: string, order: any) {
        this.placeRestingOrder(symbol, order.orderId, order.accountId, order.side, order.price, order.quantity);
    }
    removeUserOrder(symbol: string, orderId: string) {
        this.removeRestingOrder(symbol, orderId);
    }
    // ─── 撮合/盘口逻辑已迁移至 MatchingEngine（见上方委托区与 matching-engine.ts） ───
    // P0: 结算对手方真实挂单成交（对方账户走统一结算队列，并同步订单实体的 filledQty/status）
    // P0-2 修复：返回结构化结算结果 { ok, settled, failed }，并把"结算失败"从静默吞掉改为"对手单放回盘口 + 告警"。
    // 修复根因：原实现丢弃 settleFill 的返回值，对手方结算失败时仍累加其 filledQty 甚至置 FILLED——
    // 制造"对手单显示已成交、其账户却没扣款/没出货"的坏账（语义现与同文件 settleCounterFillsInner 对齐）。
    async settleCounterFills(symbol: string, mode: string, counterFills: any[]) {
        const failed: Array<{ orderId: string; error: string }> = [];
        let settled = 0;
        for (const cf of counterFills || []) {
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
            const result = await this.settleFill(cf.accountId, symbol, cf.side, cfFill, mode);
            if (!result.success) {
                // 结算失败 → 对手单放回盘口，且不累加 filledQty / 不置 FILLED（订单实体保持 PENDING，等待下次撮合）
                this.placeRestingOrder(symbol, cf.orderId, cf.accountId, cf.side, cf.price, cf.qty);
                const error = String(result.error || '对手方结算失败');
                this.logger.warn(`对手单结算失败已回滚盘口: ${cf.orderId} - ${error}`);
                failed.push({ orderId: cf.orderId, error });
                continue;
            }
            settled++;
            const cfOrder = await this.orderRepo.findOne({ where: { id: cf.orderId } });
            if (cfOrder) {
                cfOrder.filledQty = Number(cfOrder.filledQty || 0) + cf.qty;
                if (Number(cfOrder.filledQty) >= Number(cfOrder.quantity)) {
                    cfOrder.status = OrderStatus.FILLED;
                    cfOrder.avgFillPrice = cf.price;
                }
                await this.orderRepo.save(cfOrder);
            }
        }
        return { ok: failed.length === 0, settled, failed };
    }
    // order 既可能是 DB 订单实体（挂单触发路径）也可能是下单 DTO（提交路径），两者字段超集不同，故用宽松类型
    async submitOrder(orderData: any, account: Account) {
        const validation = await this.validateOrder(orderData, account);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        if (orderData.type === OrderType.MARKET) {
            const fill = this.executeMarketOrder(orderData.symbol, orderData.side, orderData.quantity, orderData.accountId);
            if (!fill) {
                return { success: false, error: '市场深度不足，无法成交' };
            }
            // P0: 本方结算失败则对手方订单放回盘口（防止对方已卖、本方未买的坏账）
            const settle = await this.settleFill(account.id, orderData.symbol, orderData.side, fill, account.marketMode);
            if (!settle.success) {
                if (fill.counterFills && fill.counterFills.length > 0) {
                    for (const cf of fill.counterFills) {
                        // P1-6 修复：AI/做市商虚拟挂单（无 orderId、无账户）不得被固化成无主真实挂单，
                        // 否则盘口出现永远无人结算的幽灵单（与 settleCounterFillsInner 的过滤口径一致）
                        if (cf.virtual || !cf.orderId)
                            continue;
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
        if (orderData.type === OrderType.FOK || orderData.type === OrderType.IOC) {
            // P2 FOK（全部成交否则取消）/ IOC（立即成交否则取消剩余）：按限价立即撮合，不进入盘口排队
            const limitPrice = Number(orderData.price);
            const fill = this.executeMarketOrderLimited(orderData.symbol, orderData.side, orderData.quantity, limitPrice, orderData.accountId);
            const isFok = orderData.type === OrderType.FOK;
            const rollback = () => {
                if (fill && fill.counterFills) {
                    for (const cf of fill.counterFills) {
                        // P1-6 修复：虚拟挂单不进真实盘口（同上）
                        if (cf.virtual || !cf.orderId)
                            continue;
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
            // P2 修复：IOC 部分成交必须落 PARTIAL（原实现无条件 FILLED，把未成交的剩余量谎报为全部成交）；
            // FOK 语义不变——上方已保证 filledQuantity >= quantity 才会走到这里，仍为 FILLED（要么全成要么撤）
            const filledQty = Number(fill.filledQuantity);
            const requestedQty = Number(orderData.quantity);
            const orderStatus = filledQty >= requestedQty ? OrderStatus.FILLED : OrderStatus.PARTIAL;
            const order = this.orderRepo.create({
                userId: orderData.userId,
                accountId: orderData.accountId,
                symbol: orderData.symbol,
                type: orderData.type,
                side: orderData.side,
                price: orderData.price,
                triggerPrice: orderData.triggerPrice,
                quantity: orderData.quantity,
                status: orderStatus,
                filledQty: fill.filledQuantity,
                avgFillPrice: fill.avgPrice,
            });
            await this.orderRepo.save(order);
            return { success: true, fill, settle };
        }
        const isIceberg = orderData.type === OrderType.ICEBERG;
        const displayQty = isIceberg ? Number(orderData.displayQty) : Number(orderData.quantity);
        const hiddenQty = isIceberg ? Number(orderData.quantity) - displayQty : 0;
        const order = this.orderRepo.create({
            userId: orderData.userId,
            accountId: orderData.accountId,
            symbol: orderData.symbol,
            type: orderData.type,
            side: orderData.side,
            price: orderData.price,
            triggerPrice: orderData.triggerPrice,
            quantity: orderData.quantity,
            status: OrderStatus.PENDING,
            displayQty: isIceberg ? displayQty : null,
            hiddenQty: isIceberg ? hiddenQty : null,
            postClose: false,
        });
        const saved = await this.orderRepo.save(order);
        // P0 真实盘口：限价单挂入盘口队列（价格-时间优先）
        // Phase A P0#2: STOP_LIMIT 带 price 但不能入盘口——否则无视 triggerPrice 被对手/竞价提前成交；
        // 仅由 checkPendingOrders 在触发价满足后转限价撮合
        if (orderData.price && orderData.type !== OrderType.STOP_LIMIT) {
            // P2 冰山单：仅显示量上盘口，隐藏量在显示量成交后由撮合引擎逐档补量（同价队尾）
            this.placeRestingOrder(orderData.symbol, saved.id, orderData.accountId, orderData.side, orderData.price, orderData.quantity, isIceberg ? { displayQty, hiddenQty } : undefined);
            // 立即尝试撮合：挂单价与对手方真实挂单交叉时按对手价成交（价格改善）
            // 冰山单首轮撮合只针对显示量（隐藏量不提前暴露）
            const crossQty = isIceberg ? displayQty : Number(orderData.quantity);
            const crossed = this.matchAgainstBook(orderData.symbol, orderData.side, crossQty, Number(orderData.price), orderData.accountId);
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
                    saved.status = OrderStatus.FILLED;
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
                        // P1-6 修复：虚拟挂单不入真实盘口（同上）
                        if (f.virtual || !f.orderId)
                            continue;
                        this.placeRestingOrder(orderData.symbol, f.orderId, f.accountId, f.side, f.price, f.qty);
                    }
                    saved.status = OrderStatus.CANCELLED;
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
    // order 为订单 DTO 或订单实体（见 submitOrder 注释），字段可能缺省，故用宽松类型
    async validateOrder(order: any, account: Account) {
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
        // Phase B P1#7: 禁止跨市场交易——账户与股票必须同市场（费率/T+1/账户隔离一致性的前提）
        const symbolMode = symbolMarket(order.symbol);
        if (symbolMode !== (account.marketMode || 'CN')) {
            return { valid: false, error: `禁止跨市场交易：${account.marketMode} 账户不能交易 ${order.symbol}（${symbolMode}）` };
        }
        const needsPrice = order.type === OrderType.LIMIT || order.type === OrderType.FOK || order.type === OrderType.IOC || order.type === OrderType.ICEBERG;
        if (needsPrice && (!Number.isFinite(Number(order.price)) || Number(order.price) <= 0 || Number(order.price) > 1000000)) {
            return { valid: false, error: '限价/FOK/IOC/冰山单指令需要有效价格（0~1000000）' };
        }
        if (order.type === OrderType.ICEBERG) {
            const dq = Number(order.displayQty);
            if (!Number.isInteger(dq) || dq <= 0 || dq >= Number(order.quantity)) {
                return { valid: false, error: '冰山单显示量必须为 1~(总数量-1) 的整数' };
            }
        }
        if (order.type === OrderType.STOP && (!Number.isFinite(Number(order.triggerPrice)) || Number(order.triggerPrice) <= 0 || Number(order.triggerPrice) > 1000000)) {
            return { valid: false, error: '止损单需要有效触发价（0~1000000）' };
        }
        if (order.type === OrderType.STOP_LIMIT) {
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
        // Phase B P1#8: A股委托价涨跌停校验——基准=昨收（真实涨停价全天固定），新股首日 +44%/-36%
        if (symbolMode === 'CN' && (order.price || order.triggerPrice)) {
            const firstDay = this.ipoFirstDay.has(order.symbol);
            const prev = this.prevCloses.get(order.symbol);
            const base = prev && Number(prev) > 0 ? Number(prev)
                : (this.dayOpenPrices.get(order.symbol) && Number(this.dayOpenPrices.get(order.symbol)) > 0 ? Number(this.dayOpenPrices.get(order.symbol))
                    : (this.prices.get(order.symbol) || null));
            const band = cnPriceLimits(base, firstDay);
            if (band) {
                const outOfRange = [Number(order.price), Number(order.triggerPrice)].filter((p) => Number.isFinite(p) && p > 0);
                for (const p of outOfRange) {
                    // 1e-9 容差：10×1.44=14.3999… 浮点，边界价（如恰好涨停价）不应误拒
                    if (p < band.down - 1e-9 || p > band.up + 1e-9) {
                        return { valid: false, error: `A股涨跌停限制：委托价 ${p.toFixed(2)} 超出当日允许区间 [${band.down.toFixed(2)}, ${band.up.toFixed(2)}]${firstDay ? '（新股首日 +44%/-36%）' : ''}` };
                    }
                }
            }
        }
        const currentPrice = this.prices.get(order.symbol) ?? 0;
        if (order.side === OrderSide.BUY) {
            const estimatedCost = remainingQty * (order.price || currentPrice);
            // Phase B P1#9: 真杠杆——购买力 = 现金 × 杠杆倍数（借入部分记入账户负债，日终计息）
            const buyingPower = Number(account.cash) * (Number(account.leverage) || 1);
            if (buyingPower < estimatedCost) {
                return { valid: false, error: `资金不足，需要 ${estimatedCost.toFixed(2)}（购买力 ${buyingPower.toFixed(2)}，杠杆 ${Number(account.leverage) || 1}x）` };
            }
        }
        if (order.side === OrderSide.SHORT) {
            // P3: 做空保证金率按个股折算（0.50~0.65）；P5 波动率升高上浮（风险敏感）
            const margin = remainingQty * (order.price || currentPrice) * shortMarginRateFor(order.symbol, this.volatilities.get(order.symbol));
            if (account.cash < margin) {
                return { valid: false, error: `保证金不足，需要 ${margin.toFixed(2)}` };
            }
            // P5 券源池：可融券数量校验（耗尽则无法开空，真实市场融券收紧）
            const pool = this.getShortPool(order.symbol);
            if (pool.available < remainingQty) {
                return { valid: false, error: `券源不足：${order.symbol} 仅剩 ${pool.available} 股可融（费率 ${(pool.feeRate * 100).toFixed(2)}%/年）` };
            }
        }
        if (order.side === OrderSide.SELL || order.side === OrderSide.COVER) {
            const pos = await this.positionRepo.findOne({
                where: { accountId: account.id, symbol: order.symbol },
            });
            const qty = order.side === OrderSide.SELL ? pos?.longQty ?? 0 : pos?.shortQty ?? 0;
            if (qty < remainingQty) {
                return { valid: false, error: `持仓不足，当前可平 ${qty} 股` };
            }
            // T+1 规则：A 股当日买入的股票次日才能卖出
            if (account.marketMode === 'CN' && order.side === OrderSide.SELL && pos) {
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
    calcFees(side: OrderSide, turnover: number, qty = 0, mode = 'US') {
        const fees = mode === 'CN' ? CN_FEES : mode === 'HK' ? HK_FEES : US_FEES;
        const commission = Math.max(turnover * fees.commissionRate, fees.minCommission);
        const stampDuty = (side === OrderSide.SELL || side === OrderSide.COVER) ? turnover * fees.stampDutyRate : 0;
        const transferFee = turnover * fees.transferFeeRate;
        const secFee = (side === OrderSide.SELL || side === OrderSide.COVER) ? turnover * fees.secFeeRate : 0;
        const tafFee = (side === OrderSide.SELL || side === OrderSide.COVER) ? qty * fees.tafFeePerShare : 0;
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
    updatePosition(pos: Position, side: OrderSide, fill: TradeFill) {
        if (side === OrderSide.BUY) {
            const newCost = ((pos.longCost * pos.longQty) + (fill.avgPrice * fill.filledQuantity)) / (pos.longQty + fill.filledQuantity);
            pos.longQty += fill.filledQuantity;
            pos.longCost = newCost;
            pos.boughtToday += fill.filledQuantity;
        } else if (side === OrderSide.SELL) {
            pos.longQty -= fill.filledQuantity;
            if (pos.longQty <= 0) { pos.longQty = 0; pos.longCost = 0; }
        } else if (side === OrderSide.SHORT) {
            const newCost = ((pos.shortCost * pos.shortQty) + (fill.avgPrice * fill.filledQuantity)) / (pos.shortQty + fill.filledQuantity);
            pos.shortQty += fill.filledQuantity;
            pos.shortCost = newCost;
        } else if (side === OrderSide.COVER) {
            pos.shortQty -= fill.filledQuantity;
            if (pos.shortQty <= 0) { pos.shortQty = 0; pos.shortCost = 0; }
        }
        return pos;
    }
    // ─── 统一成交结算：扣款/持仓/交易记录（市价单与挂单触发共用） ───
    // 修复：做空卖出得现金并冻结保证金，平空时按比例释放冻结，亏损/盈利正确计入现金
    // F4 修复：结算串行化，防止并发下单读-改-写竞态；结算时二次校验资金/保证金
    settleFill(accountId: string, symbol: string, side: OrderSide, fill: TradeFill, mode: string) {
        const run = this.settlementQueue.then(() => this.settleFillInner(accountId, symbol, side, fill, mode));
        this.settlementQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    // F4 扩展：通用互斥队列——分红/日初重置/强平等资金操作与成交结算串行化，避免读-改-写竞态
    runExclusive(fn: () => any) {
        const run = this.settlementQueue.then(() => fn());
        this.settlementQueue = run.then(() => undefined, () => undefined);
        return run;
    }
    async settleFillInner(accountId: string, symbol: string, side: OrderSide, fill: TradeFill, mode?: string) {
        // Phase B P1#7: 费率按股票所属市场路由（mode 参数仅兼容保留，不信任调用方账户模式）
        const feeMode = symbolMarket(symbol);
        const account = await this.accountRepo.findOne({ where: { id: accountId } });
        if (!account) {
            return { success: false, error: '账户不存在' };
        }
        let pos = await this.positionRepo.findOne({ where: { accountId: account.id, symbol } });
        const totalCost = fill.filledQuantity * fill.avgPrice;
        const fees = this.calcFees(side, fill.totalCost, fill.filledQuantity, feeMode);
        // SECURITY: 结算队列内复核持仓与T+1（validateOrder 在队列外执行，并发下会双卖/双平空刷钱）
        if (side === OrderSide.SELL) {
            const longQty = pos ? Number(pos.longQty) : 0;
            if (longQty < fill.filledQuantity) {
                return { success: false, error: `持仓不足，当前可卖 ${longQty} 股` };
            }
            if (feeMode === 'CN' && pos && fill.filledQuantity > longQty - (pos.boughtToday || 0)) {
                return { success: false, error: `A股T+1规则：当日买入 ${pos.boughtToday || 0} 股需次日方可卖出` };
            }
        }
        if (side === OrderSide.COVER) {
            const shortQty = pos ? Number(pos.shortQty) : 0;
            if (shortQty < fill.filledQuantity) {
                return { success: false, error: `空头持仓不足，当前可平 ${shortQty} 股` };
            }
        }
        // 结算时二次校验（防并发下单超买）——Phase B P1#9: 真杠杆购买力 = 现金 × 杠杆
        if (side === OrderSide.BUY) {
            const buyingPower = Number(account.cash) * (Number(account.leverage) || 1);
            if (buyingPower < totalCost + fees.totalFees) {
                return { success: false, error: `资金不足，需要 ${(totalCost + fees.totalFees).toFixed(2)}（购买力 ${buyingPower.toFixed(2)}）` };
            }
        }
        if (side === OrderSide.SHORT) {
            const margin = totalCost * shortMarginRateFor(symbol, this.volatilities.get(symbol));
            if (Number(account.cash) < margin) {
                return { success: false, error: `保证金不足，需要 ${margin.toFixed(2)}` };
            }
        }
        if (side === OrderSide.SHORT) {
            // 卖出得现金，冻结保证金（按个股折算率）
            const collateral = totalCost * shortMarginRateFor(symbol, this.volatilities.get(symbol));
            account.cash = Number(account.cash) + totalCost - fees.totalFees - collateral;
            account.shortCollateral = Number(account.shortCollateral || 0) + collateral;
        } else if (side === OrderSide.COVER) {
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
        } else if (side === OrderSide.BUY) {
            // Phase B P1#9: 真杠杆——自有资金 = 全额/杠杆，差额记入融资负债（borrowed），日终计息、维持担保比强平
            const ownCash = totalCost / (Number(account.leverage) || 1);
            const borrow = totalCost - ownCash;
            account.cash = Number(account.cash) - ownCash - fees.totalFees;
            account.borrowed = Number(account.borrowed || 0) + borrow;
        } else {
            // SELL：卖出回笼现金，并按持仓原始负债比例偿还融资
            // P0-1 修复（资金安全核心）：偿还额必须从卖券所得中扣除。
            // 修复根因：买入口径下借入资金从未进入 cash（cash 只扣自有部分 ownCash，差额只加到 borrowed），
            // 若卖出时仅减 borrowed 而不扣现金，等于同一笔融资款被"还了债又留在手里"——杠杆 2 买卖一轮权益凭空 +50%。
            const borrowBefore = Number(account.borrowed || 0);
            let repay = 0;
            if (borrowBefore > 0) {
                repay = Math.min(borrowBefore, totalCost * (1 - 1 / (Number(account.leverage) || 1)));
                account.borrowed = borrowBefore - repay;
            }
            // leverage === 1 时 repay 恒为 0（公式天然为 0），行为与修复前完全一致
            account.cash = Number(account.cash) + totalCost - fees.totalFees - repay;
        }
        // FIX(H4): 现金规范化到分，减少浮点累积误差
        account.cash = Math.round(account.cash * 100) / 100;
        account.totalTrades = (Number(account.totalTrades) || 0) + 1;
        await this.accountRepo.save(account);
        if (!pos) {
            // Phase E: 建仓记 lockDay=建仓日（修复红利税持有期恒 0 → CN 长线玩家恒按 20% 档错收）；
            // 加仓不刷新（保留最早建仓日=建仓字面语义，快照单值锁定的简化口径）
            pos = this.positionRepo.create({ accountId: account.id, symbol, longQty: 0, shortQty: 0, longCost: 0, shortCost: 0, boughtToday: 0, lockDay: Number(account.currentDay) || 0 });
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
        // P5 券源池：做空扣券、平空还券（失败不影响结算，仅告警）
        try {
            if (side === OrderSide.SHORT)
                this.consumeShort(symbol, fill.filledQuantity);
            else if (side === OrderSide.COVER)
                this.returnShort(symbol, fill.filledQuantity);
        }
        catch (e) {
            this.logger.warn('券源池更新失败: ' + (e && e.message ? e.message : e));
        }
        return {
            success: true,
            fill: { symbol: fill.symbol, side, quantity: fill.filledQuantity, price: fill.avgPrice, totalCost, fees },
            fees,
        };
    }
    // Phase D：抽纯函数——现价是否将触发成交（预扫与执行共用同一判断，防两遍逻辑漂移）
    shouldFillNow(order: Order, currentPrice: number) {
        if (order.type === OrderType.LIMIT) {
            return (order.side === OrderSide.BUY && currentPrice <= order.price) ||
                (order.side === OrderSide.SELL && currentPrice >= order.price);
        }
        if (order.type === OrderType.STOP) {
            return (order.side === OrderSide.BUY && currentPrice >= order.triggerPrice) ||
                (order.side === OrderSide.SELL && currentPrice <= order.triggerPrice);
        }
        if (order.type === OrderType.STOP_LIMIT) {
            const triggered = (order.side === OrderSide.BUY && currentPrice >= order.triggerPrice) ||
                (order.side === OrderSide.SELL && currentPrice <= order.triggerPrice);
            if (!triggered)
                return false;
            return (order.side === OrderSide.BUY && currentPrice <= order.price) ||
                (order.side === OrderSide.SELL && currentPrice >= order.price);
        }
        return false;
    }
    async checkPendingOrders() {
        const pending = await this.orderRepo.find({
            where: [
                { status: OrderStatus.PENDING, type: OrderType.LIMIT, postClose: false },
                { status: OrderStatus.PENDING, type: OrderType.STOP, postClose: false },
                { status: OrderStatus.PENDING, type: OrderType.STOP_LIMIT, postClose: false },
            ],
        });
        // ── Phase D 批量预载：按「当前价将成交」预扫，收集 accountId 一次 In 查询（原每单 findOne 的 N+1）──
        const willFillAccountIds = new Set<string>();
        for (const order of pending) {
            const p = this.prices.get(order.symbol);
            if (p === undefined || p === null)
                continue;
            const remaining = Number(order.quantity) - Number(order.filledQty || 0);
            if (remaining > 0 && this.shouldFillNow(order, p))
                willFillAccountIds.add(order.accountId);
        }
        const accountsById = new Map<string, Account>(); // accountId -> 批量预载账户
        if (willFillAccountIds.size > 0) {
            const list = await this.accountRepo.find({ where: { id: In([...willFillAccountIds]) } });
            for (const a of list)
                accountsById.set(a.id, a);
        }
        const dirtyAccountIds = new Set<string>(); // 本轮已尝试结算的 accountId（Map 条目已过期，使用前单查刷新）
        const fills: any[] = [];
        for (const order of pending) {
            // SECURITY: 无报价的 symbol 跳过（缺失价格不能当 0 处理，否则误触发成交）
            const currentPrice = this.prices.get(order.symbol);
            if (currentPrice === undefined || currentPrice === null)
                continue;
            const shouldFill = this.shouldFillNow(order, currentPrice);
            if (shouldFill) {
                // P0: 部分成交的挂单按剩余数量继续撮合（真实订单簿支持排队部分成交）
                const remainingQty = Number(order.quantity) - Number(order.filledQty || 0);
                if (remainingQty <= 0)
                    continue;
                // SECURITY: 限价/止损限价按限价封顶撮合，避免成交价突破限价；自成交排除
                const isPriced = order.type === OrderType.LIMIT || order.type === OrderType.STOP_LIMIT;
                const isStopType = order.type === OrderType.STOP || order.type === OrderType.STOP_LIMIT;
                // P2 止损单簿记：首次触发记录审计（转换模式/触发价/现价）
                if (isStopType && !order.triggerLog) {
                    this.appendTriggerLog(order, {
                        action: 'triggered', triggerPrice: Number(order.triggerPrice), currentPrice: Number(currentPrice),
                        convertTo: isPriced ? 'limit' : 'market', limitPrice: isPriced ? Number(order.price) : null,
                    });
                }
                const fill = isPriced
                    ? this.executeMarketOrderLimited(order.symbol, order.side, remainingQty, Number(order.price), order.accountId)
                    : this.executeMarketOrder(order.symbol, order.side, remainingQty, order.accountId);
                if (!fill) {
                    // P2 止损单簿记：触发后无流动性 → 记录重试，超限取消（限价单保持排队语义，不做重试计数）
                    if (isStopType) {
                        const retries = (Number(order.triggerRetries) || 0) + 1;
                        order.triggerRetries = retries;
                        this.appendTriggerLog(order, { action: 'converted-no-liquidity', currentPrice: Number(currentPrice), retries });
                        if (retries >= 10) {
                            order.status = OrderStatus.CANCELLED;
                            order.rejectReason = '止损触发后 10 次尝试均无流动性，已取消';
                            this.appendTriggerLog(order, { action: 'cancelled', reason: order.rejectReason });
                            this.logger.warn(`止损单 ${order.id} 触发后无流动性已取消`);
                        }
                        await this.orderRepo.save(order);
                    }
                    continue;
                }
                // Phase D: 批量 Map 取值；已结算过的账户（脏）与缺失条目在 validateOrder 前单查刷新
                let account = accountsById.get(order.accountId);
                if (dirtyAccountIds.has(order.accountId) || !account) {
                    account = await this.accountRepo.findOne({ where: { id: order.accountId } });
                    if (account) {
                        accountsById.set(order.accountId, account);
                        dirtyAccountIds.delete(order.accountId);
                    }
                }
                if (!account) {
                    continue;
                }
                // 成交前重新校验（资金/持仓/T+1），失败则取消订单，防止超买/超卖
                const recheck = await this.validateOrder(order, account);
                if (!recheck.valid) {
                    order.status = OrderStatus.CANCELLED;
                    order.rejectReason = recheck.error;
                    await this.orderRepo.save(order);
                    this.removeUserOrder(order.symbol, order.id);
                    this.logger.warn(`挂单 ${order.id} 触发但校验失败已取消: ${recheck.error}`);
                    continue;
                }
                const settle = await this.settleFill(order.accountId, order.symbol, order.side, fill, account.marketMode);
                if (settle.success) {
                    // Phase D: 本方账户资金/持仓已变 → 标脏（同账户后续挂单 validateOrder 前重读）；
                    // 结算正确性不依赖 Map（settleFillInner 内部自查），脏标记只保证预校验新鲜
                    dirtyAccountIds.add(order.accountId);
                    // P0: 先结算本方，成功后结算对手方真实挂单并同步其订单实体
                    if (fill.counterFills && fill.counterFills.length > 0) {
                        await this.settleCounterFills(order.symbol, account.marketMode, fill.counterFills);
                        // 对手方账户同样作废 Map 条目（其结算走 settleFillInner 自查，此处仅为预校验新鲜度）
                        for (const cf of fill.counterFills)
                            dirtyAccountIds.add(cf.accountId);
                    }
                    order.filledQty = Number(order.filledQty || 0) + fill.filledQuantity;
                    order.avgFillPrice = fill.avgPrice;
                    // P2 止损单簿记：成交结果审计
                    if (isStopType) {
                        this.appendTriggerLog(order, { action: 'filled', qty: fill.filledQuantity, price: fill.avgPrice });
                    }
                    if (Number(order.filledQty) >= Number(order.quantity)) {
                        order.status = OrderStatus.FILLED;
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
                    // Phase D: 结算失败也标脏（teams 定稿：读路径不容忍脏数据——失败路径虽未改账户，
                    // 但保守作废 Map 条目，避免与结算队列内部状态出现任何不一致窗口）
                    dirtyAccountIds.add(order.accountId);
                    // 结算失败 → 对手方订单放回盘口
                    if (fill.counterFills && fill.counterFills.length > 0) {
                        for (const cf of fill.counterFills) {
                            // P1-6 修复：虚拟挂单（AI/做市商）无账户无订单实体，不得固化成无主真实挂单
                            if (cf.virtual || !cf.orderId)
                                continue;
                            this.placeRestingOrder(order.symbol, cf.orderId, cf.accountId, cf.side, cf.price, cf.qty);
                            dirtyAccountIds.add(cf.accountId);
                        }
                    }
                    // P2 止损单簿记：转换失败回滚保活（重试上限 10 次后取消），避免每 tick 重复尝试坏账
                    if (isStopType && (Number(order.triggerRetries) || 0) < 10) {
                        order.triggerRetries = (Number(order.triggerRetries) || 0) + 1;
                        this.appendTriggerLog(order, { action: 'settle-failed-retry', error: settle.error, retries: order.triggerRetries });
                        await this.orderRepo.save(order);
                        this.logger.warn(`止损单 ${order.id} 结算失败保留重试(${order.triggerRetries}/10): ${settle.error}`);
                    }
                    else {
                        order.status = OrderStatus.CANCELLED;
                        order.rejectReason = settle.error;
                        if (isStopType)
                            this.appendTriggerLog(order, { action: 'cancelled', reason: settle.error });
                        await this.orderRepo.save(order);
                        this.removeUserOrder(order.symbol, order.id);
                        this.logger.warn(`挂单 ${order.id} 结算失败已取消: ${settle.error}`);
                    }
                }
            }
        }
        return fills;
    }
    async cancelOrder(orderId: string, accountId: string) {
        const order = await this.orderRepo.findOne({
            where: { id: orderId, accountId, status: OrderStatus.PENDING },
        });
        if (!order)
            return false;
        order.status = OrderStatus.CANCELLED;
        await this.orderRepo.save(order);
        if (order.postClose) {
            // Phase B: 盘后申报从独立队列移除
            const book = this.closingBook.get(order.symbol);
            if (book) {
                for (const sideKey of ['bids', 'asks']) {
                    const arr = book[sideKey];
                    for (let i = arr.length - 1; i >= 0; i--) {
                        if (arr[i].orderId === orderId)
                            arr.splice(i, 1);
                    }
                }
            }
            return true;
        }
        this.removeUserOrder(order.symbol, order.id);
        return true;
    }
    // P2 止损单簿记：审计日志追加（JSON 数组，最多保留 20 条，倒序无关——append 追加）
    appendTriggerLog(order: Order, entry: Record<string, any>) {
        let log: any[] = [];
        try {
            if (order.triggerLog)
                log = JSON.parse(order.triggerLog);
            if (!Array.isArray(log))
                log = [];
        }
        catch (e) {
            log = [];
        }
        log.push({ ...entry, at: new Date().toISOString() });
        order.triggerLog = JSON.stringify(log.slice(-20));
    }
    // P0-4: 写库前资金防线——cash 一旦变成 NaN/Infinity 并入库，该账户的资金体系即彻底不可用（读出来全是 NaN）。
    // 返回 null 表示校验不通过：此时把账户内存对象恢复原值并由调用方跳过保存（宁可少发一笔息，也不写脏数据）
    applyCashDelta(account: any, delta: number): number | null {
        const cashBefore = Number(account.cash);
        const nextCash = Math.round((cashBefore + delta) * 100) / 100;
        if (!Number.isFinite(nextCash)) {
            account.cash = cashBefore;
            return null;
        }
        account.cash = nextCash;
        return nextCash;
    }
    // Phase A P0#3: 分红按"登记日（exDay-1）收盘持仓快照"发放（A股式），封堵除权日买入套利；
    // 净空头按每股扣息（真实市场做空者在除权日需支付股息）；paid 标记幂等防重复发放
    // Phase C: 红利税二档制（dividendTaxRate）——CN ≤7交易日20%/>7日0%，HK 20%，US 30%；流水记税后净额（UI 口径一致）
    async payDividends(dividends: any[], exDay: number, market: string) {
        if (!dividends || dividends.length === 0)
            return 0;
        return this.runExclusive(() => this.payDividendsInner(dividends, exDay, market));
    }
    async payDividendsInner(dividends: any[], exDay: number, market: string) {
        const symbols = dividends.map((d) => d.symbol);
        const perShareBy = new Map<string, number>(dividends.map((d) => [String(d.symbol), Number(d.perShare)] as [string, number]));
        const snaps = await this.dividendSnapshotRepo.find({ where: { exDay: Number(exDay), paid: false } });
        let paid = 0;
        for (const snap of snaps) {
            if (!symbols.includes(snap.symbol))
                continue;
            const perShare = perShareBy.get(snap.symbol);
            if (perShare === undefined)
                continue;
            // P0-4 修复：每股分红金额非有限数（NaN/Infinity）会让 cash 变成 NaN 并入库，
            // 该账户资金体系随即彻底失效 → 记错误日志并整条事件跳过（不扣现金、不记账、继续下一条）
            if (!Number.isFinite(perShare)) {
                this.logger.error(`分红事件金额非法，已跳过该条（symbol=${snap.symbol}, perShare=${perShare}, account=${snap.accountId}）`);
                continue;
            }
            const account = await this.accountRepo.findOne({ where: { id: snap.accountId } });
            if (!account)
                continue;
            const netQty = Number(snap.longQty || 0) - Number(snap.shortQty || 0);
            // Phase C: 持有期 = 登记日（exDay-1） - 快照时点建仓日（lockDay=0 视为当日建仓）
            const holdDays = Number(snap.lockDay || 0) > 0 ? Math.max(0, Number(exDay) - 1 - Number(snap.lockDay)) : 0;
            const taxRate = dividendTaxRate(market || 'CN', holdDays);
            // 幂等：paid 标记在资金变动后落库；异常中断后重跑靠 paid=false 过滤 + 下方 save 兜底
            if (netQty > 0) {
                const gross = Number((netQty * perShare).toFixed(2));
                const amount = Number((gross * (1 - taxRate)).toFixed(2));
                // P0-4: 金额非有限（快照净额/税率脏数据）同样整条跳过，绝不把 NaN 写进 cash
                if (!Number.isFinite(gross) || !Number.isFinite(amount)) {
                    this.logger.error(`分红金额非有限数，已跳过该条（symbol=${snap.symbol}, gross=${gross}, amount=${amount}, account=${snap.accountId}）`);
                    continue;
                }
                // P0-4 防线：写库前校验算出的现金为有限数，非有限则保持原值、不保存该账户（返回失败而非写脏数据）
                if (this.applyCashDelta(account, amount) === null) {
                    this.logger.error(`分红到账后现金非有限数，已跳过保存（account=${snap.accountId}, 到账=${amount}）`);
                    continue;
                }
                await this.accountRepo.save(account);
                try {
                    await this.txRepo.save(this.txRepo.create({
                        accountId: snap.accountId,
                        symbol: snap.symbol,
                        side: 'DIVIDEND',
                        quantity: netQty,
                        price: perShare,
                        turnover: amount,
                        // 红利税计入印花税/总费用字段便于对账（UI 展示 turnover 即税后到账额）
                        commission: 0, stampDuty: Number((gross - amount).toFixed(2)), transferFee: 0, totalFees: Number((gross - amount).toFixed(2)),
                    }));
                }
                catch (e) { }
                paid += amount;
                this.logger.log(`💰 分红到账: ${snap.symbol} ${netQty}股 × ${perShare}元 = 税前${gross}，税后${amount}元（税率${(taxRate * 100).toFixed(0)}%，快照口径）`);
            }
            else if (netQty < 0) {
                // 做空者除权日付息（真实市场规则），负数流水
                const amount = Number((Math.abs(netQty) * perShare).toFixed(2));
                // P0-4: 扣息金额非有限 → 整条事件跳过（不扣现金、不记账、继续下一条）
                if (!Number.isFinite(amount)) {
                    this.logger.error(`空头付息金额非有限数，已跳过该条（symbol=${snap.symbol}, amount=${amount}, account=${snap.accountId}）`);
                    continue;
                }
                // P0-4 防线：写库前校验算出的现金为有限数（同上，非有限保持原值不保存）
                if (this.applyCashDelta(account, -amount) === null) {
                    this.logger.error(`空头付息后现金非有限数，已跳过保存（account=${snap.accountId}, 扣息=${amount}）`);
                    continue;
                }
                await this.accountRepo.save(account);
                try {
                    await this.txRepo.save(this.txRepo.create({
                        accountId: snap.accountId,
                        symbol: snap.symbol,
                        side: 'DIVIDEND',
                        quantity: netQty,
                        price: perShare,
                        turnover: -amount,
                        commission: 0, stampDuty: 0, transferFee: 0, totalFees: 0,
                    }));
                }
                catch (e) { }
                this.logger.log(`💸 空头付息: ${snap.symbol} 净空 ${Math.abs(netQty)}股 × ${perShare}元 = ${amount}元（快照口径）`);
            }
            snap.paid = true;
            await this.dividendSnapshotRepo.save(snap);
        }
        return paid;
    }
    // Phase A: 登记日（exDay-1）收盘为次日除权的股票拍持仓快照（本市场 mode 的账户）
    async snapshotDividendHolders(dividends: any[], exDay: number, mode: string) {
        if (!dividends || dividends.length === 0)
            return 0;
        const symbols = dividends.map((d) => d.symbol);
        return this.runExclusive(async () => {
            const positions = await this.positionRepo.find({ relations: ['account'] });
            let created = 0;
            for (const pos of positions) {
                if (!pos.account || pos.account.marketMode !== mode)
                    continue;
                if (!symbols.includes(pos.symbol))
                    continue;
                const existing = await this.dividendSnapshotRepo.findOne({ where: { accountId: pos.accountId, symbol: pos.symbol, exDay: Number(exDay) } });
                if (existing) {
                    // 幂等：已存在则更新为最新收盘持仓（重复日终不会拍错）
                    existing.longQty = Number(pos.longQty || 0);
                    existing.shortQty = Number(pos.shortQty || 0);
                    existing.lockDay = Number(pos.lockDay || 0);
                    await this.dividendSnapshotRepo.save(existing);
                    continue;
                }
                if (Number(pos.longQty || 0) <= 0 && Number(pos.shortQty || 0) <= 0)
                    continue; // 无持仓不拍快照
                await this.dividendSnapshotRepo.save(this.dividendSnapshotRepo.create({
                    accountId: pos.accountId,
                    symbol: pos.symbol,
                    exDay: Number(exDay),
                    longQty: Number(pos.longQty || 0),
                    shortQty: Number(pos.shortQty || 0),
                    lockDay: Number(pos.lockDay || 0),
                    paid: false,
                }));
                created++;
            }
            if (created > 0)
                this.logger.log(`📸 分红快照: ${created} 条（${mode}，除权日 ${exDay}）`);
            return created;
        });
    }
    // ─── Phase B P1#11: 集合竞价两阶段结算 ───
    // 修复根因：原 market.service 以 settleCounterFills(market, realFills) 调用，参数错位（mode=数组、counterFills=undefined）
    // → 竞价成交从未结算（挂单从盘口消失而 DB 仍 PENDING）。现改为按 symbol 分组两阶段提交：
    // 阶段1 全量预校验（资金/持仓/T+1/保证金），任一失败 → 全部挂单放回盘口恢复 PENDING（不产生半套结算）；
    // 阶段2 通过后进结算队列逐条结算（settleFillInner 确定性执行），订单实体同步 FILLED。
    async precheckFill(accountId: string, symbol: string, side: OrderSide, fill: TradeFill) {
        const account = await this.accountRepo.findOne({ where: { id: accountId } });
        if (!account)
            return { success: false, error: '账户不存在' };
        const pos = await this.positionRepo.findOne({ where: { accountId, symbol } });
        const totalCost = fill.filledQuantity * fill.avgPrice;
        const feeMode = symbolMarket(symbol);
        const fees = this.calcFees(side, fill.totalCost, fill.filledQuantity, feeMode);
        if (side === OrderSide.SELL) {
            const longQty = pos ? Number(pos.longQty) : 0;
            if (longQty < fill.filledQuantity)
                return { success: false, error: `持仓不足，当前可卖 ${longQty} 股` };
            if (feeMode === 'CN' && pos && fill.filledQuantity > longQty - (pos.boughtToday || 0))
                return { success: false, error: `A股T+1规则：当日买入 ${pos.boughtToday || 0} 股需次日方可卖出` };
        }
        if (side === OrderSide.COVER) {
            const shortQty = pos ? Number(pos.shortQty) : 0;
            if (shortQty < fill.filledQuantity)
                return { success: false, error: `空头持仓不足，当前可平 ${shortQty} 股` };
        }
        if (side === OrderSide.BUY) {
            const buyingPower = Number(account.cash) * (Number(account.leverage) || 1);
            if (buyingPower < totalCost + fees.totalFees)
                return { success: false, error: `资金不足，需要 ${(totalCost + fees.totalFees).toFixed(2)}` };
        }
        if (side === OrderSide.SHORT) {
            const margin = totalCost * shortMarginRateFor(symbol, this.volatilities.get(symbol));
            if (Number(account.cash) < margin)
                return { success: false, error: `保证金不足，需要 ${margin.toFixed(2)}` };
        }
        return { success: true };
    }
    async rollbackAuctionFills(symbol: string, fills?: any[]) {
        for (const f of fills || []) {
            if (f.virtual || !f.orderId)
                continue;
            this.placeRestingOrder(symbol, f.orderId, f.accountId, f.side, f.price, f.qty);
        }
        this.logger.warn(`集合竞价结算失败，${(fills || []).filter((f) => !f.virtual).length} 条挂单已放回盘口恢复 PENDING`);
        return { success: false, error: '集合竞价结算失败（挂单已回滚盘口）' };
    }
    async settleAuctionFills(symbol: string, fills: any[]) {
        if (!fills || fills.length === 0)
            return { success: true, settled: 0 };
        // P1-7 修复：预校验与结算必须同处本互斥队列内。
        // 修复根因：原预校验在 runExclusive 之外执行，读的是队列外快照——与并发成交/强平/分红交错时会
        // 用过期资金持仓放行，队列内 settleFillInner 再失败，产生"部分结算 + 部分挂单凭空消失"的半个竞价。
        return this.runExclusive(async () => {
            // 阶段1：全量预校验（队列内重读账户/持仓后再校验）
            for (const f of fills) {
                if (f.virtual || !f.orderId)
                    continue;
                const preFill = {
                    symbol,
                    side: f.side,
                    filledQuantity: f.qty,
                    avgPrice: f.price,
                    totalCost: Number((f.qty * f.price).toFixed(2)),
                };
                const ok = await this.precheckFill(f.accountId, symbol, f.side, preFill);
                if (!ok.success) {
                    const rollback = await this.rollbackAuctionFills(symbol, fills);
                    // P1-7: 预校验失败同样以 success:false 上报（一条未结算）
                    return { success: false, settled: 0, error: rollback.error };
                }
            }
            let settled = 0;
            let idx = 0;
            try {
                for (const f of fills) {
                    idx++;
                    if (f.virtual || !f.orderId)
                        continue;
                    const cfFill = {
                        symbol,
                        side: f.side,
                        filledQuantity: f.qty,
                        avgPrice: f.price,
                        totalCost: Number((f.qty * f.price).toFixed(2)),
                    };
                    const r = await this.settleFillInner(f.accountId, symbol, f.side, cfFill, undefined);
                    if (!r.success)
                        throw new Error(r.error);
                    const cfOrder = await this.orderRepo.findOne({ where: { id: f.orderId } });
                    if (cfOrder) {
                        cfOrder.filledQty = Number(cfOrder.filledQty || 0) + f.qty;
                        if (Number(cfOrder.filledQty) >= Number(cfOrder.quantity)) {
                            cfOrder.status = OrderStatus.FILLED;
                            cfOrder.avgFillPrice = f.price;
                        }
                        await this.orderRepo.save(cfOrder);
                    }
                    settled++;
                }
            }
            catch (e) {
                // 已结算部分保留（流水可对账），未结算部分放回盘口（显式降级：日志含完整凭据）
                const message = e && e.message ? e.message : String(e);
                this.logger.error(`集合竞价结算中断（已结算 ${settled} 条）: ${message}`);
                for (const f of fills.slice(idx - 1)) {
                    if (!f.virtual && f.orderId)
                        this.placeRestingOrder(symbol, f.orderId, f.accountId, f.side, f.price, f.qty);
                }
                // P1-7 修复：异常必须上报为失败（原实现 catch 后仍返回 success:true，调用方以为竞价已完整结算）；
                // 已结算条目数随 settled 一起返回，供调用方对账
                return { success: false, settled, error: message };
            }
            return { success: true, settled };
        });
    }
    // ─── Phase B P1: 盘后固定价格交易（A股 15:00-15:30，收盘价申报，独立队列不互吃连续竞价遗留单） ───
    getClosingBook(symbol: string) {
        let b = this.closingBook.get(symbol);
        if (!b) {
            b = { bids: [], asks: [] };
            this.closingBook.set(symbol, b);
        }
        return b;
    }
    async submitClosingOrder(orderData: any, account: Account, closePrice: number) {
        const validation = await this.validateOrder(orderData, account);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        const close = Number(Number(closePrice).toFixed(2));
        const price = Number(Number(orderData.price).toFixed(2));
        if (price !== close) {
            return { success: false, error: `盘后固定价格交易限以收盘价 ${close} 申报` };
        }
        const qty = Number(orderData.quantity);
        const isBid = orderData.side === OrderSide.BUY;
        const book = this.getClosingBook(orderData.symbol);
        const counterparty = isBid ? book.asks : book.bids;
        let remaining = qty;
        const fills: any[] = [];
        let i = 0;
        // 同价时间优先撮合 + 自成交防护（CN 无 short/cover，仅 buy/sell）
        while (remaining > 0 && i < counterparty.length) {
            const e = counterparty[i];
            if (e.accountId === orderData.accountId) {
                i++;
                continue;
            }
            const fq = Math.min(remaining, Number(e.qty));
            fills.push({ orderId: e.orderId, accountId: e.accountId, side: e.side, price: close, qty: fq, virtual: false });
            e.qty = Number(e.qty) - fq;
            if (Number(e.qty) <= 0)
                counterparty.splice(i, 1);
            else
                i++;
            remaining -= fq;
        }
        const saved = await this.orderRepo.save(this.orderRepo.create({
            userId: orderData.userId,
            accountId: orderData.accountId,
            symbol: orderData.symbol,
            type: OrderType.LIMIT,
            side: orderData.side,
            price: close,
            quantity: qty,
            status: OrderStatus.PENDING,
            postClose: true,
        }));
        if (remaining > 0) {
            const list = isBid ? book.bids : book.asks;
            list.push({ orderId: saved.id, accountId: orderData.accountId, side: orderData.side, price: close, qty: remaining, time: Date.now() });
            list.sort((a, b) => a.time - b.time); // 时间优先
        }
        const filledQty = qty - remaining;
        if (filledQty <= 0)
            return { success: true, order: saved, fill: null };
        const ownFill = {
            symbol: orderData.symbol,
            side: orderData.side,
            filledQuantity: filledQty,
            avgPrice: close,
            totalCost: Number((filledQty * close).toFixed(2)),
            counterFills: fills,
        };
        const settle = await this.settleFill(orderData.accountId, orderData.symbol, orderData.side, ownFill, account.marketMode);
        if (!settle.success) {
            // 结算失败：对手方挂单放回 + 本方撤单
            for (const f of fills) {
                const list2 = f.side === OrderSide.BUY ? book.bids : book.asks;
                list2.push({ orderId: f.orderId, accountId: f.accountId, side: f.side, price: close, qty: f.qty, time: Date.now() });
            }
            saved.status = OrderStatus.CANCELLED;
            saved.rejectReason = settle.error;
            await this.orderRepo.save(saved);
            return { success: false, error: settle.error };
        }
        await this.settleCounterFills(orderData.symbol, account.marketMode, fills);
        saved.filledQty = filledQty;
        saved.avgFillPrice = close;
        if (remaining <= 0) {
            saved.status = OrderStatus.FILLED;
        }
        await this.orderRepo.save(saved);
        return { success: true, order: saved, fill: ownFill };
    }
    async cancelAfterHoursOrders() {
        const pending = await this.orderRepo.find({ where: { status: OrderStatus.PENDING, postClose: true } });
        for (const o of pending) {
            o.status = OrderStatus.CANCELLED;
            o.rejectReason = '盘后固定价格交易时段结束未成交';
            await this.orderRepo.save(o);
        }
        this.closingBook.clear();
        if (pending.length > 0)
            this.logger.log(`🌆 盘后固定价格交易结束：${pending.length} 笔未成交申报已撤销`);
        return pending.length;
    }
    async getPendingOrders(accountId: string) {
        return this.orderRepo.find({
            where: { accountId, status: OrderStatus.PENDING },
            order: { createdAt: 'DESC' },
        });
    }
    async checkMarginLevel(account: Account, prices: Record<string, any>, preloadedPositions?: Position[]) {
        // Phase F: 支持调用方批量预载持仓（In 查询），避免逐账户 find 的 N+1；
        // 缺省（undefined）时保持原逐账户查询语义，存量调用/测试零改动
        const positions = preloadedPositions || await this.positionRepo.find({ where: { accountId: account.id } });
        // SECURITY: 冻结保证金属于用户资产，计入权益（避免误判过早强平）
        let totalEquity = Number(account.cash) + Number(account.shortCollateral || 0);
        // Phase B P1#9: 多仓负债按记账口径（account.borrowed，买入时按杠杆借入、卖出时偿还），不再由持仓市值推导
        let totalBorrowed = Number(account.borrowed || 0);
        for (const pos of positions) {
            const price = prices[pos.symbol];
            if (price === undefined || price === null)
                continue; // 无报价持仓跳过估值，避免按 0 计
            totalEquity += pos.longQty * price - pos.shortQty * price;
            // 做空保证金要求 = 做空市值 × 个股保证金率
            totalBorrowed += pos.shortQty * price * shortMarginRateFor(pos.symbol, this.volatilities.get(pos.symbol));
        }
        // 无借入资金 = 安全
        if (totalBorrowed <= 0) {
            return { safe: true, action: 'ok', marginLevel: 999 };
        }
        // 保证金率 = 总权益 / 借入资金；P3 三级阈值：<120% 强平全仓 / <130% 追保(部分平仓) / <140% 预警
        const marginLevel = totalEquity / totalBorrowed;
        if (marginLevel < RISK.marginLiquidateLevel) {
            return { safe: false, action: 'liquidate', marginLevel };
        }
        if (marginLevel < RISK.marginCallLevel) {
            return { safe: false, action: 'margin_call', marginLevel };
        }
        if (marginLevel < RISK.marginWarningLevel) {
            return { safe: true, action: 'warning', marginLevel };
        }
        return { safe: true, action: 'ok', marginLevel };
    }
    // Phase A P0#4: 强平结算对手方挂单（队列内直调 settleFillInner，避免 settleFill 再入队死锁）；
    // 对手方结算失败时把其挂单放回盘口，杜绝"被吃掉但无结算"的幽灵单
    async settleCounterFillsInner(symbol: string, mode: string, counterFills?: any[]) {
        for (const cf of counterFills || []) {
            if (cf.virtual || !cf.orderId)
                continue;
            const cfFill = {
                symbol,
                side: cf.side,
                filledQuantity: cf.qty,
                avgPrice: cf.price,
                totalCost: Number((cf.qty * cf.price).toFixed(2)),
            };
            const r = await this.settleFillInner(cf.accountId, symbol, cf.side, cfFill, mode);
            if (r.success) {
                const cfOrder = await this.orderRepo.findOne({ where: { id: cf.orderId } });
                if (cfOrder) {
                    cfOrder.filledQty = Number(cfOrder.filledQty || 0) + cf.qty;
                    if (Number(cfOrder.filledQty) >= Number(cfOrder.quantity)) {
                        cfOrder.status = OrderStatus.FILLED;
                        cfOrder.avgFillPrice = cf.price;
                    }
                    await this.orderRepo.save(cfOrder);
                }
            }
            else {
                // 结算失败回滚盘口（与 submitOrder 的失败回滚语义一致）
                this.placeRestingOrder(symbol, cf.orderId, cf.accountId, cf.side, cf.price, cf.qty);
                this.logger.warn(`强平对手单结算失败已回滚: ${cf.orderId} - ${r.error}`);
            }
        }
    }
    async forceLiquidate(account: Account) {
        // Phase A P0#4: 强平进入结算互斥队列，与用户成交串行，防止 read-modify-write 互相覆盖
        return this.runExclusive(() => this.forceLiquidateInner(account));
    }
    // P1-8 修复：强平/追保的每笔实际成交都要落交易流水。
    // 修复根因：原实现直接改 acc.cash / pos.* 后 save，被强平者"钱变了却没有任何成交记录"，
    // 对账（账户流水页 / FIFO 绩效 / 风控复盘）全部缺这一笔，玩家看到资金凭空消失且无从解释。
    // 字段口径与 settleFillInner 的 txRepo.create 完全一致（费用用该笔的 calcFees 结果）。
    async recordLiquidationTx(accountId: string, symbol: string, side: OrderSide, fill: any, fees: any) {
        try {
            await this.txRepo.save(this.txRepo.create({
                accountId,
                symbol,
                side,
                quantity: fill.filledQuantity,
                price: fill.avgPrice,
                turnover: fill.totalCost,
                ...fees,
            }));
        }
        catch (e) {
            // 流水写入失败不影响强平本身（资金已按真实成交变更，流水属审计补记，失败仅告警）
            this.logger.error(`强平流水写入失败 ${accountId} ${symbol} ${side}: ${e && e.message ? e.message : e}`);
        }
    }
    async forceLiquidateInner(account: Account) {
        // 队列内重读账户与持仓（入队前读到的可能是过期数据）
        const acc = await this.accountRepo.findOne({ where: { id: account.id } });
        if (!acc)
            return 0;
        const positions = await this.positionRepo.find({ where: { accountId: acc.id } });
        let recovered = 0;
        let totalFees = 0;
        for (const pos of positions) {
            // 自成交防护：强平市价单不与本人挂单撮合
            if (pos.longQty > 0) {
                const fill = this.executeMarketOrder(pos.symbol, OrderSide.SELL, pos.longQty, acc.id);
                if (fill) {
                    const fees = this.calcFees(OrderSide.SELL, fill.totalCost, fill.filledQuantity, symbolMarket(pos.symbol));
                    // Phase B: 卖出回笼现金同时按比例偿还融资负债
                    const repay = Math.min(Number(acc.borrowed || 0), fill.totalCost * (1 - 1 / (Number(acc.leverage) || 1)));
                    acc.borrowed = Number(acc.borrowed || 0) - repay;
                    // P0-1 修复：偿还额必须从回收额里扣掉（recovered 最终整体加到 cash）。
                    // 与 settleFillInner SELL 同口径——卖券所得先还债，只有净额才算现金回收，否则强平反而凭空造钱
                    recovered += fill.totalCost - repay;
                    totalFees += fees.totalFees;
                    await this.recordLiquidationTx(acc.id, pos.symbol, OrderSide.SELL, fill, fees);
                    // Phase A P0#4: 按实际成交量扣减，剩余持仓保留（跌停/无流动性时不得凭空蒸发）
                    pos.longQty = Number(pos.longQty) - fill.filledQuantity;
                    if (pos.longQty <= 0) {
                        pos.longQty = 0;
                        pos.longCost = 0;
                    }
                    await this.settleCounterFillsInner(pos.symbol, acc.marketMode, fill.counterFills);
                }
            }
            if (pos.shortQty > 0) {
                const before = Number(pos.shortQty);
                const fill = this.executeMarketOrder(pos.symbol, OrderSide.COVER, pos.shortQty, acc.id);
                if (fill) {
                    const fees = this.calcFees(OrderSide.COVER, fill.totalCost, fill.filledQuantity, symbolMarket(pos.symbol));
                    recovered -= fill.totalCost;
                    totalFees += fees.totalFees;
                    await this.recordLiquidationTx(acc.id, pos.symbol, OrderSide.COVER, fill, fees);
                    pos.shortQty = Number(pos.shortQty) - fill.filledQuantity;
                    if (pos.shortQty <= 0) {
                        pos.shortQty = 0;
                        pos.shortCost = 0;
                    }
                    // 冻结保证金按实际平仓比例释放（剩余空仓保留对应保证金）
                    const released = before > 0 ? Number(acc.shortCollateral || 0) * (fill.filledQuantity / before) : 0;
                    acc.shortCollateral = Number(acc.shortCollateral || 0) - released;
                    recovered += released;
                    await this.settleCounterFillsInner(pos.symbol, acc.marketMode, fill.counterFills);
                }
            }
            await this.positionRepo.save(pos);
        }
        // 剩余空仓（跌停/无流动性未平）保留对应保证金；全部平完则归还所有冻结保证金
        const remainingShort = positions.reduce((s, p) => s + Number(p.shortQty || 0), 0);
        const leftover = Number(acc.shortCollateral || 0);
        if (remainingShort <= 0 && leftover > 0) {
            recovered += leftover;
            acc.shortCollateral = 0;
        }
        // Phase B P1#9: 全部持仓已清→剩余融资负债从现金扣除（负资产兜底：亏损破产时现金可负，走账户重置）
        const remainingLong = positions.reduce((s, p) => s + Number(p.longQty || 0), 0);
        const orphanDebt = Number(acc.borrowed || 0);
        if (remainingLong <= 0 && orphanDebt > 0) {
            recovered -= orphanDebt;
            acc.borrowed = 0;
        }
        // SECURITY: 强平归还冻结保证金并按标准计费（原实现清零保证金不归还、不计费，等于吞用户资产）
        acc.cash = Math.round((Number(acc.cash) + recovered - totalFees) * 100) / 100;
        acc.marginUsed = Math.round((Number(acc.borrowed || 0) + Number(acc.shortCollateral || 0)) * 100) / 100;
        await this.accountRepo.save(acc);
        this.logger.warn(`账户 ${acc.id} 已被强制平仓，净回收 ${recovered.toFixed(2)}，费用 ${totalFees.toFixed(2)}，负债剩余 ${Number(acc.borrowed || 0).toFixed(2)}，冻结保证金剩余 ${Number(acc.shortCollateral || 0).toFixed(2)}`);
        return recovered;
    }
    // F7 修复：日终检查所有账户保证金，爆仓（liquidate）则强制平仓
    async getAccountById(accountId: string) {
        try {
            return await this.accountRepo.findOne({ where: { id: accountId } });
        }
        catch (e) {
            return null;
        }
    }
    // P3 部分强平（追保）：按市值从大到小每次卖出/回补持仓一半，直到保证金率恢复到目标水平
    async forceLiquidateToTarget(account: Account, targetLevel: number) {
        // Phase A P0#4: 追保同样进入结算互斥队列
        return this.runExclusive(() => this.forceLiquidateToTargetInner(account, targetLevel));
    }
    async forceLiquidateToTargetInner(account: Account, targetLevel: number) {
        // 队列内重读账户（防过期数据丢失更新）
        const acc = await this.accountRepo.findOne({ where: { id: account.id } });
        if (!acc)
            return 0;
        const positions = await this.positionRepo.find({ where: { accountId: acc.id } });
        const priceOf = (symbol: string) => {
            const p = this.prices.get(symbol);
            return p === undefined || p === null ? null : p;
        };
        const evalMargin = () => {
            let equity = Number(acc.cash) + Number(acc.shortCollateral || 0);
            let borrowed = Number(acc.borrowed || 0); // Phase B: 融资负债为记账口径（非持仓推导）
            for (const pos of positions) {
                const price = priceOf(pos.symbol);
                if (price === null)
                    continue;
                equity += pos.longQty * price - pos.shortQty * price;
                borrowed += pos.shortQty * price * shortMarginRateFor(pos.symbol, this.volatilities.get(pos.symbol));
            }
            return borrowed > 0 ? equity / borrowed : 999;
        };
        let netCash = 0;
        const sorted = positions.slice().sort((a, b) => {
            const pa = priceOf(a.symbol) ?? 0;
            const pb = priceOf(b.symbol) ?? 0;
            return (b.longQty * pb + b.shortQty * pb) - (a.longQty * pa + a.shortQty * pa);
        });
        let releasedCollateral = 0;
        for (const pos of sorted) {
            if (evalMargin() >= targetLevel)
                break;
            if (pos.longQty > 0) {
                const qty = Math.ceil(Number(pos.longQty) * 0.5);
                // 自成交防护：追保市价单不与本人挂单撮合
                const fill = this.executeMarketOrder(pos.symbol, OrderSide.SELL, qty, acc.id);
                if (fill) {
                    const fees = this.calcFees(OrderSide.SELL, fill.totalCost, fill.filledQuantity, symbolMarket(pos.symbol));
                    // Phase B: 追保卖出同步按比例偿还融资负债（降杠杆）
                    const repay = Math.min(Number(acc.borrowed || 0), fill.totalCost * (1 - 1 / (Number(acc.leverage) || 1)));
                    acc.borrowed = Number(acc.borrowed || 0) - repay;
                    // P0-1 修复：偿还额必须从净现金里扣除（与 settleFillInner SELL 同口径），否则追保卖出凭空造钱
                    netCash += fill.totalCost - fees.totalFees - repay;
                    // P1-8 修复：追保成交同样要落流水
                    await this.recordLiquidationTx(acc.id, pos.symbol, OrderSide.SELL, fill, fees);
                    pos.longQty = Number(pos.longQty) - fill.filledQuantity;
                    if (pos.longQty <= 0) {
                        pos.longQty = 0;
                        pos.longCost = 0;
                    }
                    await this.settleCounterFillsInner(pos.symbol, acc.marketMode, fill.counterFills);
                }
            }
            if (pos.shortQty > 0) {
                const before = Number(pos.shortQty);
                const qty = Math.ceil(before * 0.5);
                const fill = this.executeMarketOrder(pos.symbol, OrderSide.COVER, qty, acc.id);
                if (fill) {
                    const fees = this.calcFees(OrderSide.COVER, fill.totalCost, fill.filledQuantity, symbolMarket(pos.symbol));
                    const released = Number(acc.shortCollateral || 0) * (fill.filledQuantity / before);
                    releasedCollateral += released;
                    acc.shortCollateral = Number(acc.shortCollateral || 0) - released;
                    netCash += released - fill.totalCost - fees.totalFees;
                    // P1-8 修复：平空回补同样要落流水
                    await this.recordLiquidationTx(acc.id, pos.symbol, OrderSide.COVER, fill, fees);
                    pos.shortQty = Number(pos.shortQty) - fill.filledQuantity;
                    if (pos.shortQty <= 0) {
                        pos.shortQty = 0;
                        pos.shortCost = 0;
                    }
                    await this.settleCounterFillsInner(pos.symbol, acc.marketMode, fill.counterFills);
                }
            }
            await this.positionRepo.save(pos);
        }
        acc.cash = Math.round((Number(acc.cash) + netCash) * 100) / 100;
        acc.marginUsed = Math.round((Number(acc.borrowed || 0) + Number(acc.shortCollateral || 0)) * 100) / 100;
        await this.accountRepo.save(acc);
        this.logger.warn('账户 ' + acc.id + ' 追保部分平仓，现金净变动 ' + netCash.toFixed(2) + '，归还保证金 ' + releasedCollateral.toFixed(2) + '，当前保证金率 ' + evalMargin().toFixed(4));
        return netCash;
    }
    async forceLiquidateMarginalAccounts() {
        const accounts = await this.accountRepo.find();
        const priceObj: Record<string, any> = {};
        for (const [sym, price] of this.prices) {
            priceObj[sym] = price;
        }
        const liquidated: any[] = [];
        // ── Phase F 精修：无负债账户免估值（N+1 裁剪）──
        // checkMarginLevel 的 totalBorrowed = borrowed + Σ 空头市值×折算率，三者皆 0 时恒返回 safe：
        // 这些账户（绝大多数玩家）无需查持仓，直接跳过（marginUsed 一并纳入守卫，兼容 Phase B 前的存量口径）
        const candidates = accounts.filter((a) => Number(a.borrowed || 0) > 0 || Number(a.shortCollateral || 0) > 0 || Number(a.marginUsed || 0) > 0);
        // 候选账户持仓一次 In 预载（原每账户一次 find → 1 次查询）
        const positionsByAccount = new Map<string, Position[]>();
        if (candidates.length > 0) {
            for (const a of candidates)
                positionsByAccount.set(a.id, []);
            try {
                const rows = await this.positionRepo.find({ where: { accountId: In(candidates.map((a) => a.id)) } });
                for (const p of rows) {
                    const arr = positionsByAccount.get(p.accountId);
                    if (arr)
                        arr.push(p);
                }
            }
            catch (e) {
                // 预载失败退回逐账户查询（clear 让 checkMarginLevel 走原路径），风控绝不因查询优化漏检
                positionsByAccount.clear();
                this.logger.warn('强平持仓预载失败，退回逐账户查询: ' + (e && e.message ? e.message : e));
            }
        }
        for (const account of candidates) {
            try {
                const preloaded = positionsByAccount.has(account.id) ? positionsByAccount.get(account.id) : undefined;
                const margin = await this.checkMarginLevel(account, priceObj, preloaded);
                if (margin.action === 'liquidate') {
                    await this.forceLiquidate(account);
                    liquidated.push({ accountId: account.id, marginLevel: Number(margin.marginLevel.toFixed(4)) });
                    this.logger.warn(`账户 ${account.id} 爆仓强平，保证金率 ${margin.marginLevel.toFixed(4)}`);
                }
                else if (margin.action === 'margin_call') {
                    // P3 追保：部分平仓恢复保证金率到目标水平
                    await this.forceLiquidateToTarget(account, RISK.marginCallTarget);
                    liquidated.push({ accountId: account.id, marginLevel: Number(margin.marginLevel.toFixed(4)) });
                    this.logger.warn(`账户 ${account.id} 触发追保，部分平仓至保证金率 ${RISK.marginCallTarget}`);
                }
            }
            catch (e) {
                this.logger.error(`强平检查失败 account=${account.id}: ${e.message}`);
            }
        }
        return liquidated;
    }
}
