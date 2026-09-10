import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';

import { User } from '../../infrastructure/database/entities/user.entity';

// 行情 tick 广播载荷（market-data 生成：symbol/price/volume/timestamp）
interface MarketTick {
    symbol: string;
    price: number;
    volume: number;
    timestamp: number;
}

// 成交广播载荷：顶层字段保持引擎原命名（filledQuantity/avgPrice/totalCost/fees），
// counterFills 已由 sanitizeFill 脱敏（仅 side/price/qty/virtual）
interface FillBroadcast {
    symbol?: string;
    side?: string;
    filledQuantity?: number;
    avgPrice?: number;
    totalCost?: number;
    fees?: number;
    counterFills?: Array<{ side: string; price: number; qty: number; virtual: boolean }>;
    [key: string]: any;
}

// 新闻广播载荷（每日新闻 / 泡沫破灭 / 内幕消息共用）
interface NewsBroadcast {
    title: string;
    description: string;
    type: string;
    impact: Record<string, number>;
    duration: number;
    [key: string]: any;
}

@Injectable()
@WebSocketGateway({
    // FIX(M5): 收紧 CORS 白名单（原 origin:'*' 为无差别放行）
    cors: { origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'], credentials: true },
    namespace: '/market',
})
export class MarketGateway {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(MarketGateway.name);

    clients = 0;

    // R5-⑦: 单用户并发 WS 连接上限——5 个足够覆盖多标签页/多设备正常使用，同时限制
    // 单账号连接放大（每次连接都要跑一次 JWT verify + User 查询，无上限时可被单账号刷爆 DB/句柄）。
    // 与 auth 侧常量同样做成实例字段，便于单测覆写。
    MAX_CONNECTIONS_PER_USER = 5;

    // R5-⑦: userId → 该用户当前生效的 socket.id 集合（上限判定 + 断开时收缩），
    // 集合空时删除对应键，避免长期运行累积空 Set
    userConnections = new Map<string, Set<string>>();

    constructor(
        private readonly jwtService: JwtService,
        @InjectRepository(User) private readonly userRepo: Repository<User>,
    ) {}

    async handleConnection(client: Socket) {
        // SECURITY(C): WS 必须携带 JWT（前端 socket.io 使用 auth: { token } 传参），校验失败直接断开
        // Phase D: verify 后再查 User 校验 isActive——用户被禁用后其存量 WS 立即断开
        // （HTTP 侧由 JwtStrategy.validate 每次请求兜底；WS 无请求概念，故在此补 DB 检查）
        let userId: string; // R5-⑦: 认证通过后才有值（payload.sub 即已查到的用户 id）
        try {
            const token = client.handshake && client.handshake.auth ? client.handshake.auth.token : null;
            if (!token) {
                this.logger.warn(`WS 认证失败（缺少 token）: ${client.id}`);
                client.disconnect(true);
                return;
            }
            const payload = this.jwtService.verify(token);
            if (!payload || !payload.sub) {
                this.logger.warn(`WS 认证失败（token 载荷无效）: ${client.id}`);
                client.disconnect(true);
                return;
            }
            const user = await this.userRepo.findOne({ where: { id: payload.sub } });
            if (!user || !user.isActive) {
                this.logger.warn(`WS 认证失败（用户不存在或已被禁用）: ${client.id}`);
                client.disconnect(true);
                return;
            }
            userId = String(payload.sub);
        }
        catch (e) {
            this.logger.warn(`WS 认证失败: ${client.id} - ${e.message}`);
            client.disconnect(true);
            return;
        }
        let conns = this.userConnections.get(userId);
        if (!conns) {
            conns = new Set<string>();
            this.userConnections.set(userId, conns);
        }
        if (conns.size >= this.MAX_CONNECTIONS_PER_USER) {
            // R5-⑦: 超限则拒绝「新连接」（不踢旧连接）——踢旧会让正常页面闪断，且攻击者拿到
            // 一个有效账号后反而能借此踢掉受害者现有会话；此处只挡第 6 个及以后。
            // 该分支不计数、不打 __counted 标记，故其 handleDisconnect 不会误减 clients。
            this.logger.warn(`WS 连接数超限（用户 ${userId} 已有 ${conns.size} 个连接）: ${client.id}`);
            client.emit('error', { message: '连接数超限' });
            client.disconnect(true);
            return;
        }
        conns.add(client.id);
        this.clients++;
        // FIX(P1): 给「真正计过数」的连接打标记——认证失败分支在 return 前从不计数，
        // 但 socket.io 对它们照样触发 handleDisconnect；无标记时自减会把合法连接一起扣掉
        // （1 合法 + 1 坏 token 被拒 → clients 归 0，监控/日志失真）
        if (!client.data)
            client.data = {};
        client.data.__counted = true;
        // R5-⑦: 断开时据此从 per-user 集合中移除（与 __counted 同一标记守护，保证只清理一次）
        client.data.__userId = userId;
        this.logger.log(`WS 客户端已连接: ${client.id} (在线: ${this.clients}, 用户 ${userId} 连接数: ${conns.size})`);
    }

    handleDisconnect(client: Socket) {
        // FIX(P1): 只在「已计数」标记存在时自减并清除标记（防重复断连事件重复扣减）；
        // 认证失败连接从未 ++，此处不得 --。Math.max(0, ...) 作为最后兜底保留。
        if (client.data && client.data.__counted) {
            client.data.__counted = false;
            this.clients = Math.max(0, this.clients - 1);
            // R5-⑦: 仅「已计数」连接持有 per-user 集合条目，同一标记保证只清理一次
            const userId = client.data.__userId;
            const conns = userId ? this.userConnections.get(userId) : null;
            if (conns) {
                conns.delete(client.id);
                if (conns.size === 0)
                    this.userConnections.delete(userId); // 空集合回收，断开后计数收缩
            }
        }
        this.logger.log(`WS 客户端已断开: ${client.id} (在线: ${this.clients})`);
    }

    broadcastTick(ticks: MarketTick[]) {
        this.server.emit('tick', { ticks, timestamp: Date.now() });
    }

    broadcastFill(fill: FillBroadcast) {
        this.server.emit('fill', fill);
    }

    broadcastNews(news: NewsBroadcast) {
        this.server.emit('news', news);
    }
}
