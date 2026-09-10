import { useEffect } from 'react';
import { connectWebSocket, disconnectWebSocket } from '../services/ws.client';
import { useMarketStore, useUIStore } from '../store';

export function useWebSocket() {
  const addTicks = useMarketStore((s) => s.addTicks);
  const addNotification = useUIStore((s) => s.addNotification);

  useEffect(() => {
    const socket = connectWebSocket();

    socket.on('tick', (data: any) => {
      // 负载校验：结构/字段非法时跳过（store 内还有逐条防御）
      if (!data || !Array.isArray(data.ticks)) return;
      // Phase C: 整批交给 store 批量 set（一次 setState 处理全部 tick）
      addTicks(data.ticks);
    });

    socket.on('fill', (data: any) => {
      if (!data || !data.symbol) return;
      addNotification(`成交: ${data.symbol} ${data.side} ${data.filledQuantity}股 @ ${data.avgPrice}`, 'success');
      useUIStore.getState().addNotice({ type: 'fill', title: '✅ 成交', desc: `${data.symbol} ${data.side === 'buy' ? '买入' : data.side === 'sell' ? '卖出' : data.side === 'short' ? '做空' : '平仓'} ${data.filledQuantity} 股 @ ${data.avgPrice}` });
    });

    socket.on('news', (data: any) => {
      if (!data || !data.title) return;
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
    // addTicks / addNotification 是 zustand `create` 初始化时一次性定义、永不重建的 action 引用，
    // 选择器每次返回同一个函数指针，所以把它们放进依赖不会导致 effect 反复重订阅；
    // 同时消除了"闭包里抓到旧 action 引用"的隐患（connectWebSocket/disconnectWebSocket 成对，重跑安全）。
  }, [addTicks, addNotification]);
}
