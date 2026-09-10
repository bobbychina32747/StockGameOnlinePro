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

    constructor(
        private readonly jwtService: JwtService,
        @InjectRepository(User) private readonly userRepo: Repository<User>,
    ) {}

    async handleConnection(client: Socket) {
        // SECURITY(C): WS 必须携带 JWT（前端 socket.io 使用 auth: { token } 传参），校验失败直接断开
        // Phase D: verify 后再查 User 校验 isActive——用户被禁用后其存量 WS 立即断开
        // （HTTP 侧由 JwtStrategy.validate 每次请求兜底；WS 无请求概念，故在此补 DB 检查）
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
        }
        catch (e) {
            this.logger.warn(`WS 认证失败: ${client.id} - ${e.message}`);
            client.disconnect(true);
            return;
        }
        this.clients++;
        this.logger.log(`WS 客户端已连接: ${client.id} (在线: ${this.clients})`);
    }

    handleDisconnect(client: Socket) {
        // 认证失败的连接未计入 clients，避免计数变负
        this.clients = Math.max(0, this.clients - 1);
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
