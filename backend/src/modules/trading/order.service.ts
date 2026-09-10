import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Account } from '../../infrastructure/database/entities/account.entity';
import { Position } from '../../infrastructure/database/entities/position.entity';
import { Order, OrderSide, OrderType } from '../../infrastructure/database/entities/order.entity';
import { Transaction } from '../../infrastructure/database/entities/transaction.entity';

import { TradingEngineService } from '../../core/trading-engine/trading-engine.service';

import { DebugModeService } from '../../common/debug-mode/debug-mode.service';

import { afterHoursStageFor, auctionStageFor, isTradingTimeFor } from '../../common/constants';

// Phase B: 跨市场闸门
import { symbolMarket } from '../../common/market-utils';

@Injectable()
export class OrderService {
    private readonly logger = new Logger(OrderService.name);

    constructor(
        @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
        @InjectRepository(Position) private readonly positionRepo: Repository<Position>,
        @InjectRepository(Order) private readonly orderRepo: Repository<Order>,
        @InjectRepository(Transaction) private readonly txRepo: Repository<Transaction>,
        private readonly engine: TradingEngineService,
        private readonly dataSource: DataSource,
        private readonly debugMode: DebugModeService,
    ) {}

    async placeOrder(userId: string, mode: string, symbol: string, type: OrderType, side: OrderSide, quantity: number, price: number, triggerPrice: number, displayQty: number, clientOrderId?: string) {
        // S2 休市校验：非交易时段拒绝下单
        // 调试模式仅对开启它的管理员（canBypassHours 白名单）跳过休市检查
        // P1 三阶段竞价（A股）：9:15-9:20 可申报可撤 / 9:20-9:25 可申报不可撤 / 9:25-9:30 撮合中不接受申报
        const auctionStage = auctionStageFor(mode);
        if (!this.debugMode.canBypassHours(userId) && auctionStage === 'matching') {
            throw new BadRequestException('集合竞价撮合中（9:25-9:30），暂不接受申报');
        }
        const canPlaceInAuction = auctionStage === 'cancelable' || auctionStage === 'locked';
        if (!this.debugMode.canBypassHours(userId) && !isTradingTimeFor(mode) && !canPlaceInAuction) {
            throw new BadRequestException('休市中，当前市场不在交易时段，无法下单');
        }
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            throw new NotFoundException(`账户不存在（${mode}）`);
        // R5-⑥: 下单幂等键——客户端网络重试携带同一 clientOrderId 时直接返回既有订单，不再走引擎
        // （否则重试 = 二次撮合/二次扣款/二次建仓）。空/未传（含纯空白）不生成默认键，行为与修复前完全一致。
        const idempotencyKey = typeof clientOrderId === 'string' && clientOrderId.trim() ? clientOrderId.trim() : null;
        if (idempotencyKey) {
            const existing = await this.orderRepo.findOne({ where: { accountId: account.id, clientOrderId: idempotencyKey } });
            if (existing)
                return { success: true, order: existing, duplicate: true };
        }
        if (account.marketMode === 'CN' && (side === OrderSide.SHORT || side === OrderSide.COVER)) {
            return { success: false, error: 'A股模式不支持做空/融券' };
        }
        // Phase B P1#7: 服务层跨市场闸门（给前端明确 400，引擎层另有兜底）
        const symbolMode = symbolMarket(symbol);
        if (symbolMode !== mode) {
            throw new BadRequestException(`账户市场与股票市场不一致，禁止跨市场交易（${mode} 账户不能交易 ${symbol}）`);
        }
        // Phase B P1: 盘后固定价格交易（A股 15:00-15:30，仅限价单且价格=当日收盘价）
        const afterStage = afterHoursStageFor(mode);
        if (!this.debugMode.canBypassHours(userId) && afterStage === 'fixedPrice') {
            if (type !== OrderType.LIMIT) {
                throw new BadRequestException('盘后固定价格交易仅支持限价单申报');
            }
            const close = this.engine.prices.get(symbol);
            if (close === undefined || close === null || !Number.isFinite(Number(close))) {
                throw new BadRequestException('盘后固定价格交易：暂无当日收盘价，无法申报');
            }
            if (Math.round(Number(price || 0) * 100) / 100 !== Math.round(Number(close) * 100) / 100) {
                throw new BadRequestException(`盘后固定价格交易限以收盘价 ${Number(close).toFixed(2)} 申报`);
            }
            // 引擎返回值的字段随分支不同（success/error/order/fill 非同一形状），保持原动态取值语义
            const result: any = await this.engine.submitClosingOrder({ userId, accountId: account.id, symbol, type: OrderType.LIMIT, side, quantity, price: Number(Number(close).toFixed(2)), clientOrderId: idempotencyKey || undefined }, account, close);
            if (!result.success) {
                return { success: false, error: result.error };
            }
            await this.backfillClientOrderId(result, idempotencyKey);
            return { success: true, order: result.order, fill: result.fill || null };
        }
        // 同上：success 分支或带 settle、或仅带 order，沿用原动态取值
        const result: any = await this.engine.submitOrder({ userId, accountId: account.id, symbol, type, side, quantity, price, triggerPrice, displayQty, clientOrderId: idempotencyKey || undefined }, account);
        if (!result.success) {
            return { success: false, error: result.error };
        }
        if (type === OrderType.MARKET) {
            // P0: 本方与对手方结算已由引擎 submitOrder 完成（返回 settle），避免二次撮合
            // R5-⑥: 市价单该路径不落订单实体（无 orderId 可回填），幂等键对市价单不生效——见 REFACTOR-5 备注
            return result.settle || result;
        }
        await this.backfillClientOrderId(result, idempotencyKey);
        return { success: true, order: result.order };
    }

    // R5-⑥: 幂等键兜底回填——引擎在成交/挂单路径自建并落库订单实体（FOK/IOC 甚至不向上返回该实体），
    // 故提交成功后按返回的 order 实体补写 clientOrderId，保证下一次重试能被上面的去重查询命中。
    private async backfillClientOrderId(result: any, clientOrderId: string | null) {
        const order = result && result.order;
        if (!clientOrderId || !order || !order.id || order.clientOrderId === clientOrderId)
            return;
        try {
            order.clientOrderId = clientOrderId;
            await this.orderRepo.save(order);
        }
        catch (e) {
            // 回填失败不阻断下单（订单已成交/已挂单），仅告警：该键此后的重试仍可能重复下单
            this.logger.warn(`幂等键回填失败（orderId=${order.id}）: ${e && e.message ? e.message : e}`);
        }
    }

    async cancelOrder(userId: string, orderId: string, mode: string) {
        // P1 三阶段竞价：9:20-9:25 申报锁定不可撤单，9:25-9:30 撮合阶段不可撤单（真实规则）
        const stage = auctionStageFor(mode);
        if (!this.debugMode.canBypassHours(userId) && (stage === 'locked' || stage === 'matching')) {
            throw new BadRequestException('集合竞价 9:20-9:25 申报不可撤单（9:25 起进入撮合），请在开盘后撤单');
        }
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            throw new NotFoundException('账户不存在');
        const ok = await this.engine.cancelOrder(orderId, account.id);
        return { success: ok };
    }

    async getHistory(userId: string, mode: string) {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            return [];
        return this.txRepo.find({
            where: { accountId: account.id },
            order: { createdAt: 'DESC' },
            take: 100,
        });
    }

    async getPendingOrders(userId: string, mode: string) {
        const account = await this.accountRepo.findOne({ where: { userId, marketMode: mode } });
        if (!account)
            return [];
        return this.engine.getPendingOrders(account.id);
    }
}
