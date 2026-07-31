/// <reference types="vite/client" />
import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function connectWebSocket(): Socket {
  if (socket?.connected) return socket;

  // 开发模式走 Vite 代理，生产模式直连后端
  socket = io(import.meta.env.DEV ? '/market' : `http://${window.location.hostname}:8000/market`, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: 10,
  });

  socket.on('connect', () => {
    console.log('[WS] 已连接');
    (window as any).__wsSocket = socket;
  });
  socket.on('disconnect', () => {
    console.log('[WS] 已断开');
    (window as any).__wsSocket = null;
  });
  socket.on('connect_error', (err) => console.error('[WS] 连接错误:', err.message));

  return socket;
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
