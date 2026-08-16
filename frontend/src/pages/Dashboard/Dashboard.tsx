import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore, useUIStore } from '../../store';
import { StockListPanel } from '../../components/Trading/StockListPanel';
import { ChartPanel } from '../../components/Trading/ChartPanel';
import { OrderBookPanel } from '../../components/Trading/OrderBookPanel';
import { AccountPanel } from '../../components/Trading/AccountPanel';
import { OrderPanel } from '../../components/Trading/OrderPanel';
import { StockDetailModal } from '../../components/Trading/StockDetailModal';
import { AIAssistant } from '../../components/Trading/AIAssistant';
import { TutorialOverlay } from '../../components/Tutorial/TutorialOverlay';

// 主交易页（同花顺式三栏布局：股票列表 | 图表 | 盘口/账户/下单，两侧可拖拽调宽）
export default function Dashboard() {
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setKlines = useMarketStore((s) => s.setKlines);
  const setOrderBook = useMarketStore((s) => s.setOrderBook);
  const setStocks = useMarketStore((s) => s.setStocks);
  const setPrices = useMarketStore((s) => s.setPrices);
  const stocks = useMarketStore((s) => s.stocks);
  const setDetailSymbol = useUIStore((s) => s.setDetailSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const setSelectedTimeframe = useUIStore((s) => s.setSelectedTimeframe);

  // 初始：拉股票列表
  useEffect(() => {
    marketApi.stocks().then((list) => {
      if (Array.isArray(list)) setStocks(list);
    }).catch(() => {});
  }, [setStocks]);

  // 选中股票/周期变化时拉取 K 线与盘口
  // Q5：1min/intraday 由 WS tick 实时维护，只首次拉一次历史；其他周期 15s 低频轮询
  const realtimeTf = selectedTimeframe === '1min' || selectedTimeframe === 'intraday';
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
    let timer: ReturnType<typeof setInterval> | null = null;
    if (!realtimeTf) {
      timer = setInterval(load, 15000);
    }
    return () => { if (timer) clearInterval(timer); };
  }, [selectedSymbol, selectedTimeframe, realtimeTf, setKlines, setOrderBook]);

  // WS 断线时降级到 REST 轮询（每 5 秒）
  const [wsConnected, setWsConnected] = useState(true);
  useEffect(() => {
    const interval = setInterval(() => {
      const socket = (window as any).__wsSocket;
      const connected = socket?.connected ?? false;
      setWsConnected(connected);
      if (!connected) {
        // 断线兜底：价格映射与 K 线一起拉，避免列表/盘口价格冻结
        marketApi.prices().then((p) => {
          if (p && typeof p === 'object') setPrices(p);
        }).catch(() => {});
        marketApi.klines(selectedSymbol, selectedTimeframe).then((k) =>
          setKlines(selectedSymbol, selectedTimeframe, k)
        ).catch(() => {});
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedSymbol, selectedTimeframe, setKlines, setPrices]);

  // ─── S5 快捷键：数字选股 / T 切周期 / 上下键换股 / Enter 详情 ───
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const sorted = [...stocks].sort((a: any, b: any) => (a.symbol < b.symbol ? -1 : 1));
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        if (sorted[idx]) setSelectedSymbol(sorted[idx].symbol);
      } else if (e.key === 't' || e.key === 'T') {
        const tfs = ['intraday', '1min', '5min', '60min', 'daily', 'weekly', 'monthly'];
        const cur = tfs.indexOf(selectedTimeframe);
        setSelectedTimeframe(tfs[(cur + 1) % tfs.length]);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = sorted.findIndex((x: any) => x.symbol === selectedSymbol);
        const next = sorted[idx + (e.key === 'ArrowUp' ? -1 : 1)];
        if (next) setSelectedSymbol(next.symbol);
      } else if (e.key === 'Enter') {
        setDetailSymbol(selectedSymbol);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stocks, selectedSymbol, selectedTimeframe, setSelectedSymbol, setSelectedTimeframe, setDetailSymbol]);

  // ─── 三栏宽度拖拽（左列表 / 右面板） ───
  // S4 布局持久化：宽度从 localStorage 恢复
  // A1 移动端：设备检测（≤768px 视为移动端）+ 底部Tab切换
  const isMobile = useUIStore((s) => s.isMobile);
  const setMobile = useUIStore((s) => s.setMobile);
  const mobileTab = useUIStore((s) => s.mobileTab);
  const setMobileTab = useUIStore((s) => s.setMobileTab);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [setMobile]);

  const [leftWidth, setLeftWidth] = useState(() => Number(localStorage.getItem('ss.leftW')) || 230);
  const [rightWidth, setRightWidth] = useState(() => Number(localStorage.getItem('ss.rightW')) || 330);
  const dragRef = useRef<{ side: 'left' | 'right'; startX: number; startW: number } | null>(null);
  // 用 ref 保存最新宽度：onUp 闭包创建于挂载时，读 state 会拿到过期值
  const leftWidthRef = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);

  const startDrag = (e: ReactMouseEvent, side: 'left' | 'right') => {
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
        const w = Math.min(360, Math.max(150, d.startW + dx));
        setLeftWidth(w);
        leftWidthRef.current = w;
      } else {
        const w = Math.min(480, Math.max(250, d.startW - dx));
        setRightWidth(w);
        rightWidthRef.current = w;
      }
    };
    const onUp = () => {
      if (dragRef.current) {
        const w = dragRef.current.side === 'left' ? leftWidthRef.current : rightWidthRef.current;
        localStorage.setItem(dragRef.current.side === 'left' ? 'ss.leftW' : 'ss.rightW', String(w));
      }
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
    <div className={isMobile ? 'dashboard dashboard-mobile' : 'dashboard'}>
      {!wsConnected && (
        <div className="ws-offline-tip">
          ⚠️ 实时行情连接已断开，正在通过轮询获取数据...
        </div>
      )}
      {!isMobile && (
        <>
          <div className="resizable-panel" style={{ width: leftWidth }}>
            <StockListPanel />
          </div>
          <div className="drag-handle" onMouseDown={(e) => startDrag(e, 'left')} title="拖拽调整宽度" />
        </>
      )}
      {isMobile ? (
        mobileTab === 'list' ? (
          <div className="m-view">
            <StockListPanel />
          </div>
        ) : mobileTab === 'chart' ? (
          <div className="m-view">
            <ChartPanel />
            <OrderBookPanel />
          </div>
        ) : (
          <div className="m-view m-trade">
            <AccountPanel />
            <OrderPanel />
            <AIAssistant />
          </div>
        )
      ) : (
        <>
          <ChartPanel />
          <div className="drag-handle" onMouseDown={(e) => startDrag(e, 'right')} title="拖拽调整宽度" />
          <div className="resizable-panel" style={{ width: rightWidth }}>
            <div className="side-panel">
              <OrderBookPanel />
              <AccountPanel />
              <OrderPanel />
              <AIAssistant />
            </div>
          </div>
        </>
      )}
      <StockDetailModal />
      <TutorialOverlay />
      {isMobile && (
        <div className="m-tabbar">
          <button className={mobileTab === 'list' ? 'm-tab active' : 'm-tab'} onClick={() => setMobileTab('list')}>📈 行情</button>
          <button className={mobileTab === 'chart' ? 'm-tab active' : 'm-tab'} onClick={() => setMobileTab('chart')}>📊 图表</button>
          <button className={mobileTab === 'trade' ? 'm-tab active' : 'm-tab'} onClick={() => setMobileTab('trade')}>💼 交易</button>
        </div>
      )}
    </div>
  );
}
