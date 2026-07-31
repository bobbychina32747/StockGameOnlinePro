import { useEffect, useRef, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useMarketStore, useUIStore } from '../../store';
import { StockListPanel } from '../../components/Trading/StockListPanel';
import { ChartPanel } from '../../components/Trading/ChartPanel';
import { OrderBookPanel } from '../../components/Trading/OrderBookPanel';
import { AccountPanel } from '../../components/Trading/AccountPanel';
import { OrderPanel } from '../../components/Trading/OrderPanel';
import { StockDetailModal } from '../../components/Trading/StockDetailModal';

// 主交易页（同花顺式三栏布局：股票列表 | 图表 | 盘口/账户/下单，两侧可拖拽调宽）
export default function Dashboard() {
  // 初始化 WebSocket（tick/成交/新闻推送）
  useWebSocket();

  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setKlines = useMarketStore((s) => s.setKlines);
  const setOrderBook = useMarketStore((s) => s.setOrderBook);
  const setStocks = useMarketStore((s) => s.setStocks);

  // 初始：拉股票列表
  useEffect(() => {
    marketApi.stocks().then((list) => {
      if (Array.isArray(list)) setStocks(list);
    }).catch(() => {});
  }, [setStocks]);

  // 选中股票/周期变化时拉取 K 线与盘口
  useEffect(() => {
    const load = async () => {
      try {
        const [kdata, ob] = await Promise.all([
          marketApi.klines(selectedSymbol, selectedTimeframe),
          marketApi.orderBook(selectedSymbol),
        ]);
        setKlines(selectedSymbol, selectedTimeframe, kdata);
        setOrderBook(selectedSymbol, ob);
      } catch (e) {
        // 忽略瞬时错误，WS 会持续推送
      }
    };
    load();
  }, [selectedSymbol, selectedTimeframe, setKlines, setOrderBook]);

  // WS 断线时降级到 REST 轮询（每 5 秒）
  const [wsConnected, setWsConnected] = useState(true);
  useEffect(() => {
    const interval = setInterval(() => {
      const socket = (window as any).__wsSocket;
      const connected = socket?.connected ?? false;
      setWsConnected(connected);
      if (!connected) {
        marketApi.klines(selectedSymbol, selectedTimeframe).then((k) =>
          setKlines(selectedSymbol, selectedTimeframe, k)
        ).catch(() => {});
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedSymbol, selectedTimeframe, setKlines]);

  // ─── 三栏宽度拖拽（左列表 / 右面板） ───
  const [leftWidth, setLeftWidth] = useState(230);
  const [rightWidth, setRightWidth] = useState(330);
  const dragRef = useRef<{ side: 'left' | 'right'; startX: number; startW: number } | null>(null);

  const startDrag = (e: React.MouseEvent, side: 'left' | 'right') => {
    e.preventDefault();
    dragRef.current = { side, startX: e.clientX, startW: side === 'left' ? leftWidth : rightWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      if (d.side === 'left') {
        setLeftWidth(Math.min(360, Math.max(150, d.startW + dx)));
      } else {
        setRightWidth(Math.min(480, Math.max(250, d.startW - dx)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div className="dashboard">
      {!wsConnected && (
        <div className="ws-offline-tip">
          ⚠️ 实时行情连接已断开，正在通过轮询获取数据...
        </div>
      )}
      <div className="resizable-panel" style={{ width: leftWidth }}>
        <StockListPanel />
      </div>
      <div className="drag-handle" onMouseDown={(e) => startDrag(e, 'left')} title="拖拽调整宽度" />
      <ChartPanel />
      <div className="drag-handle" onMouseDown={(e) => startDrag(e, 'right')} title="拖拽调整宽度" />
      <div className="resizable-panel" style={{ width: rightWidth }}>
        <div className="side-panel">
          <OrderBookPanel />
          <AccountPanel />
          <OrderPanel />
        </div>
      </div>
      <StockDetailModal />
    </div>
  );
}
