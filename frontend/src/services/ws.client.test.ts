import { io } from 'socket.io-client';
import { connectWebSocket, disconnectWebSocket, getSocket } from './ws.client';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));

describe('WebSocket lifecycle', () => {
  beforeEach(() => {
    disconnectWebSocket();
    jest.clearAllMocks();
  });

  it('reuses the connection while connecting or reconnecting', () => {
    const socket = { connected: false, on: jest.fn(), removeAllListeners: jest.fn(), disconnect: jest.fn() };
    (io as jest.Mock).mockReturnValue(socket);
    expect(connectWebSocket()).toBe(socket);
    expect(connectWebSocket()).toBe(socket);
    expect(io).toHaveBeenCalledTimes(1);
  });

  it('clears listeners and the fallback reference on explicit disconnect', () => {
    const socket = { connected: true, on: jest.fn(), removeAllListeners: jest.fn(), disconnect: jest.fn() };
    (io as jest.Mock).mockReturnValue(socket);
    connectWebSocket();
    (window as any).__wsSocket = socket;
    disconnectWebSocket();
    expect(socket.removeAllListeners).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(getSocket()).toBeNull();
    expect((window as any).__wsSocket).toBeNull();
    connectWebSocket();
    expect(io).toHaveBeenCalledTimes(2);
  });
});
