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
      useUIStore.getState().addNotice({ type: 'fill', title: '✅ 成交', desc: `${data.symbol} ${data.side === 'buy' ? '买入' : data.side === 'sell' ? '卖出' : data.side === 'short' ? '做空' : '平仓'} ${data.filledQuantity} 股 @ ${data.avgPrice}` });
    });

    socket.on('news', (data: any) => {
      addNotification(`📰 ${data.title}`, 'info');
      useUIStore.getState().addNotice({ type: 'news', title: data.type === 'insider' ? '⚠️ 内幕消息' : data.type === 'night' ? '🌙 隔夜事件' : '📰 新闻', desc: data.title });
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
