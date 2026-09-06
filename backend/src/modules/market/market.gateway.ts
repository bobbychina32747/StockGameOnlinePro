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
import websockets_1 = require("@nestjs/websockets");

import socket_io_1 = require("socket.io");

import common_1 = require("@nestjs/common");

import jwt_1 = require("@nestjs/jwt");

import typeorm_1 = require("@nestjs/typeorm");

import typeorm_2 = require("typeorm");

import user_entity_1 = require("../../infrastructure/database/entities/user.entity");

let MarketGateway = class MarketGateway {
    [key: string]: any;
    constructor(jwtService, userRepo) {
        this.jwtService = jwtService;
        this.userRepo = userRepo;
        this.logger = new common_1.Logger(MarketGateway.name);
        this.clients = 0;
    }
    async handleConnection(client) {
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
    handleDisconnect(client) {
        // 认证失败的连接未计入 clients，避免计数变负
        this.clients = Math.max(0, this.clients - 1);
        this.logger.log(`WS 客户端已断开: ${client.id} (在线: ${this.clients})`);
    }
    broadcastTick(ticks) {
        this.server.emit('tick', { ticks, timestamp: Date.now() });
    }
    broadcastFill(fill) {
        this.server.emit('fill', fill);
    }
    broadcastNews(news) {
        this.server.emit('news', news);
    }
};
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], MarketGateway.prototype, "server", void 0);

export { MarketGateway };

MarketGateway = __decorate(
[
    (0, common_1.Injectable)(),
    (0, websockets_1.WebSocketGateway)({
        // FIX(M5): 收紧 CORS 白名单（原 origin:'*' 为无差别放行）
        cors: { origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'], credentials: true },
        namespace: '/market',
    }),
    __param(1, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [jwt_1.JwtService, typeorm_2.Repository])
],
MarketGateway
);

