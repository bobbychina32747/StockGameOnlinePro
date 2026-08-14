var __decorate = function (decorators, target, key?, desc?) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import websockets_1 = require("@nestjs/websockets");

import socket_io_1 = require("socket.io");

import common_1 = require("@nestjs/common");

import jwt_1 = require("@nestjs/jwt");

let MarketGateway = class MarketGateway {
    [key: string]: any;
    constructor(jwtService) {
        this.jwtService = jwtService;
        this.logger = new common_1.Logger(MarketGateway.name);
        this.clients = 0;
    }
    handleConnection(client) {
        // SECURITY(C): WS 必须携带 JWT（前端 socket.io 使用 auth: { token } 传参），校验失败直接断开
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
    __metadata("design:paramtypes", [jwt_1.JwtService])
],
MarketGateway
);

