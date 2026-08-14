/// <reference types="vite/client" />
import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function connectWebSocket(): Socket {
  if (socket?.connected) return socket;

  // 始终同源连接：开发走 Vite 代理 /socket.io，生产走 nginx 代理 /socket.io
  const s = io('/market', {
    transports: ['websocket'], // 只走 WS（polling 长轮询经 vite proxy 会 ECONNABORTED）
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
    auth: { token: localStorage.getItem('token') || '' }, // 后端网关校验 handshake.auth.token
  });
  socket = s;

  s.on('connect', () => {
    console.log('[WS] 已连接');
    (window as any).__wsSocket = s;
  });
  s.on('disconnect', () => {
    console.log('[WS] 已断开');
    (window as any).__wsSocket = null;
  });
  s.on('connect_error', (err) => {
    console.error('[WS] 连接错误:', err.message);
    // 认证相关错误时刷新 token，下次重连握手携带最新凭证
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('auth') || msg.includes('token') || msg.includes('401') || msg.includes('jwt')) {
      s.auth = { token: localStorage.getItem('token') || '' };
    }
  });

  return s;
}

export function disconnectWebSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getSocket(): Socket | null {
  return socket;
}
