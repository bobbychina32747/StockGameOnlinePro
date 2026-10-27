import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * 私线实时通道（2026-10-27）——用 SSE 而不是 socket.io。
 *
 * 为什么是 SSE：
 *   · 主站是纯静态页，站点自我约束「不加载任何第三方脚本」；socket.io 客户端要额外 vendor 一份 100KB+
 *     的脚本才能用，而 EventSource 是浏览器原生能力，零依赖。
 *   · 鉴权走域级 HttpOnly Cookie（sid），EventSource 同源请求自动带 Cookie，不需要把令牌暴露给 JS。
 *   · 只有「服务端 → 客户端」的推送需求（新消息 / 已读回执 / 对方正在输入），上行全部走 REST，
 *     这样上行的权限、限流、校验只有一份实现（ChatService.send 等），不会出现 WS 与 HTTP 两套口径。
 *
 * 断线由浏览器自动重连（retry: 3000）；每 20s 发一次注释行心跳，避免 Cloudflare / nginx 空闲超时。
 */
interface SseConn {
    id: string;
    identityId: string;
    threadId: string;
    res: any;
    timer: any;
}

@Injectable()
export class ChatEventsService {
    private readonly logger = new Logger(ChatEventsService.name);
    private readonly conns = new Map<string, SseConn>();

    /** 心跳间隔：小于 CF 100s / nginx 默认 60s 空闲超时，留足余量 */
    HEARTBEAT_MS = 20_000;

    /** 建立一条 SSE 连接，返回取消订阅函数 */
    subscribe(input: { identityId: string; threadId: string; res: any }): () => void {
        const { identityId, threadId, res } = input;
        const id = randomUUID();
        res.status?.(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // 让 nginx 别缓冲（配置里也会写 proxy_buffering off，这里是双保险）
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        res.write('retry: 3000\n\n');
        this.write(res, 'hello', { ok: true, threadId, at: new Date().toISOString() });

        const timer = setInterval(() => {
            // 注释行心跳：不是事件，客户端 EventSource 不会派发
            try {
                res.write(': ping\n\n');
            }
            catch {
                // 写失败说明连接已断，交给 close 回调清理
            }
        }, this.HEARTBEAT_MS);
        timer.unref?.();

        this.conns.set(id, { id, identityId, threadId, res, timer });
        // 新连接加入：把「对方在不在线」广播给这条会话上的所有连接（含自己）
        this.broadcastPresence(threadId);
        return () => this.drop(id);
    }

    /** 向某条会话的所有在线连接广播一个事件 */
    publish(threadId: string, event: string, data: any): void {
        for (const conn of Array.from(this.conns.values())) {
            if (conn.threadId !== threadId)
                continue;
            if (!this.write(conn.res, event, data))
                this.drop(conn.id);
        }
    }

    /** 对某个身份而言「对端是否在线」：同一条会话里存在另一个身份的连接 */
    peerOnline(threadId: string, identityId: string): boolean {
        for (const conn of this.conns.values()) {
            if (conn.threadId === threadId && conn.identityId !== identityId)
                return true;
        }
        return false;
    }

    /**
     * 广播在线状态（区分「我」与「对方」）：
     * 两个标签页同时开着也只算一个人在线；自己上线不能把「对方在线」点亮 —— 这是真实语义，
     * 否则页面永远显示对方在线，等于没有这个指示器。
     */
    broadcastPresence(threadId: string): void {
        const conns = Array.from(this.conns.values()).filter((c) => c.threadId === threadId);
        for (const conn of conns) {
            const online = conns.some((other) => other.id !== conn.id && other.identityId !== conn.identityId);
            if (!this.write(conn.res, 'presence', { online }))
                this.drop(conn.id);
        }
    }

    private write(res: any, event: string, data: any): boolean {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            return true;
        }
        catch (e) {
            this.logger.warn(`SSE 写入失败，准备清理连接：${e && e.message ? e.message : e}`);
            return false;
        }
    }

    private drop(id: string): void {
        const conn = this.conns.get(id);
        if (!conn)
            return;
        clearInterval(conn.timer);
        this.conns.delete(id);
        // 离开也要广播：对方页面要立刻从「在线」变回「离线」
        this.broadcastPresence(conn.threadId);
    }
}
