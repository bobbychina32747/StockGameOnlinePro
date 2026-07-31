import { useEffect } from 'react';
import { connectWebSocket, disconnectWebSocket } from '../services/ws.client';
import { useMarketStore, useUIStore } from '../store';

export function useWebSocket() {
  const addTick = useMarketStore((s) => s.addTick);
  const addNotification = useUIStore((s) => s.addNotification);

  useEffect(() => {
    const socket = connectWebSocket();

    socket.on('tick', (data: { ticks: { symbol: string; price: number; volume: number; timestamp: number }[] }) => {
      data.ticks.forEach((t) => addTick(t));
    });

    socket.on('fill', (data: any) => {
      addNotification(`成交: ${data.symbol} ${data.side} ${data.filledQuantity}股 @ ${data.avgPrice}`, 'success');
    });

    socket.on('news', (data: any) => {
      addNotification(`📰 ${data.title}`, 'info');
      if (data.title) {
        useUIStore.getState().addNews(
          data.type === 'insider' ? `⚠️ ${data.title}` :
          data.type === 'night' ? `${data.title}` :
          `📰 ${data.title}: ${data.description}`
        );
      }
    });

    return () => {
      disconnectWebSocket();
    };
  }, []);
}
