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

let MarketGateway = class MarketGateway {
    [key: string]: any;
    constructor() {
        this.logger = new common_1.Logger(MarketGateway.name);
        this.clients = 0;
    }
    handleConnection(client) {
        this.clients++;
        this.logger.log(`WS 客户端已连接: ${client.id} (在线: ${this.clients})`);
    }
    handleDisconnect(client) {
        this.clients--;
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
    (0, websockets_1.WebSocketGateway)({
        cors: { origin: '*', credentials: true },
        namespace: '/market',
    })
],
MarketGateway
);

