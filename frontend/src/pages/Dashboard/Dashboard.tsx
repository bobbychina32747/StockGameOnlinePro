import { useEffect, useState, useCallback, useMemo } from 'react';
import ReactEChartsCore from 'echarts-for-react';
import { marketApi, tradingApi, accountApi } from '../../services/api.client';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useMarketStore, useAccountStore, useUIStore } from '../../store';

interface KlineData {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface OrderEntry {
  id?: string;
  symbol: string;
  side: string;
  quantity: number;
  price?: number;
  status?: string;
}

interface TradeEntry {
  id?: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  commission?: number;
  stampDuty?: number;
  transferFee?: number;
  totalFees?: number;
}

export default function Dashboard() {
  // 初始化 WebSocket
  useWebSocket();

  const prices = useMarketStore((s) => s.prices);
  const klines = useMarketStore((s) => s.klines);
  const orderBook = useMarketStore((s) => s.orderBook);
  const setKlines = useMarketStore((s) => s.setKlines);
  const setOrderBook = useMarketStore((s) => s.setOrderBook);
  const { account, positions } = useAccountStore();
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);
  const selectedTimeframe = useUIStore((s) => s.selectedTimeframe);
  const setSelectedTimeframe = useUIStore((s) => s.setSelectedTimeframe);
  const addNotification = useUIStore((s) => s.addNotification);

  const [mode, setModeState] = useState('US');
  const [orderType, setOrderType] = useState('market');
  const [orderSide, setOrderSide] = useState('buy');
  const [orderQty, setOrderQty] = useState(100);
  const [orderPrice, setOrderPrice] = useState('');
  const [orderTriggerPrice, setOrderTriggerPrice] = useState('');
  const [pendingOrders, setPendingOrders] = useState<OrderEntry[]>([]);
  const [tradeHistory, setTradeHistory] = useState<TradeEntry[]>([]);

  const isCN = mode === 'CN';

  // 切换区服（US/CN 两个独立档，数据不互通）
  const switchMode = (newMode: string) => {
    setModeState(newMode);
    loadAccountData(newMode);
  };

  // 获取行情数据
  const fetchMarketData = useCallback(async () => {
    try {
      const [kdata, ob] = await Promise.all([
        marketApi.klines(selectedSymbol, selectedTimeframe),
        marketApi.orderBook(selectedSymbol),
      ]);
      setKlines(selectedSymbol, selectedTimeframe, kdata);
      setOrderBook(selectedSymbol, ob);
    } catch (e) {
      // 忽略
    }
  }, [selectedSymbol, selectedTimeframe]);

  // ─── 账户数据加载 ───
  const loadAccountData = useCallback(async (marketMode: string) => {
    try {
      const [acctData, pending, history] = await Promise.all([
        accountApi.get(marketMode),
        tradingApi.getPending(marketMode),
        tradingApi.getHistory(marketMode),
      ]);
      useAccountStore.getState().setAccount(acctData);
      setPendingOrders(Array.isArray(pending) ? pending : []);
      setTradeHistory(Array.isArray(history) ? history : []);
    } catch (error) {
      console.warn('[Dashboard] 加载账户数据失败:', error);
      addNotification('加载账户数据失败，请检查网络', 'error');
    }
  }, [addNotification]);

  // WebSocket 优先，仅断连时降级到 REST 轮询
  const [wsConnected, setWsConnected] = useState(true);
  useEffect(() => {
    fetchMarketData();
    loadAccountData(mode);
    const interval = setInterval(() => {
      const socket = (window as any).__wsSocket;
      const connected = socket?.connected ?? false;
      setWsConnected(connected);
      if (!connected) fetchMarketData();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchMarketData, loadAccountData, mode]);

  // ─── 下单 ───
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const placeOrder = async () => {
    if (orderSubmitting) return; // 防重复提交
    setOrderSubmitting(true);
    try {
      const result = await tradingApi.placeOrder(mode, {
        symbol: selectedSymbol,
        type: orderType,
        side: orderSide,
        quantity: orderQty,
        price: orderPrice ? parseFloat(orderPrice) : undefined,
        triggerPrice: orderTriggerPrice ? parseFloat(orderTriggerPrice) : undefined,
      });
      if (result.success) {
        // 部分成交提示（F5 修复：实际成交可能与下单量不一致）
        const filledQty = result.fill?.quantity;
        if (filledQty != null && filledQty < orderQty) {
          addNotification(`⚠️ 部分成交: ${selectedSymbol} ${orderSide} 仅成交 ${filledQty}/${orderQty}股`, 'info');
        } else {
          addNotification(`下单成功: ${selectedSymbol} ${orderSide} ${orderQty}股`, 'success');
        }
        loadAccountData(mode);
      } else {
        addNotification(`下单失败: ${result.error}`, 'error');
      }
    } catch (error) {
      const axiosErr = error as { response?: { data?: { message?: string } } };
      addNotification(`下单失败: ${axiosErr?.response?.data?.message || '网络错误'}`, 'error');
    } finally {
      setTimeout(() => setOrderSubmitting(false), 800);
    }
  };

  // ─── 一键清仓（并行执行） ───
  const quickClear = async () => {
    if (!window.confirm('确定一键清仓所有持仓？')) return;
    try {
      const orderPromises: Promise<unknown>[] = [];
      for (const pos of (positions as any[])) {
        if (pos.longQty > 0) {
          orderPromises.push(
            tradingApi.placeOrder(mode, {
              symbol: pos.symbol, type: 'market', side: 'sell', quantity: pos.longQty,
            })
          );
        }
        if (pos.shortQty > 0) {
          orderPromises.push(
            tradingApi.placeOrder(mode, {
              symbol: pos.symbol, type: 'market', side: 'cover', quantity: pos.shortQty,
            })
          );
        }
      }
      await Promise.all(orderPromises);
      addNotification('已清仓', 'success');
      loadAccountData(mode);
    } catch (error) {
      console.error('[Dashboard] 清仓失败:', error);
      addNotification('清仓失败，部分订单可能未成交', 'error');
    }
  };

  // ─── 技术指标计算（缓存，仅数据变化时重算） ───
  const klineData: KlineData[] = (klines[selectedSymbol]?.[selectedTimeframe] || []) as KlineData[];
  const chartOption = useMemo(() => {
    const closes = klineData.map((k) => k.close);
    const calcMA = (period: number): (string | null)[] => {
      const r: (string | null)[] = new Array(closes.length).fill(null);
      for (let i = period - 1; i < closes.length; i++) {
        let s = 0; for (let j = 0; j < period; j++) s += closes[i - j];
        r[i] = (s / period).toFixed(2);
      }
      return r;
    };
    const calcRSI = (period = 14): (number | null)[] => {
      const r: (number | null)[] = new Array(closes.length).fill(null);
      let g = 0, l = 0;
      for (let i = 1; i <= period && i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
      }
      let ag = g / period, al = l / period;
      if (period < closes.length) r[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (period - 1) + (d >= 0 ? d : 0)) / period;
        al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
        r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      }
      return r;
    };
    const calcBB = (period = 20) => {
      const mid = calcMA(period);
      const u = [...mid], l = [...mid];
      for (let i = period - 1; i < closes.length; i++) {
        let sq = 0; for (let j = 0; j < period; j++) sq += (closes[i - j] - Number(mid[i])) ** 2;
        const std = Math.sqrt(sq / period);
        u[i] = (Number(mid[i]) + 2 * std).toFixed(2);
        l[i] = (Number(mid[i]) - 2 * std).toFixed(2);
      }
      return { upper: u, mid, lower: l };
    };
    const ma5 = calcMA(5), ma10 = calcMA(10), ma20 = calcMA(20);
    const rsi = calcRSI(14);
    const bb = calcBB(20);
    const klineTimes = klineData.map((k) => {
      const d = new Date(k.time);
      return selectedTimeframe === 'daily' ? `${d.getMonth()+1}/${d.getDate()}` : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
    });
    const candleData = klineData.map((k) => [k.open, k.close, k.low, k.high]);

    return {
      animationDuration: 300,
      animationDurationUpdate: 300,
      animationEasingUpdate: 'linear',
      backgroundColor: 'transparent',
    grid: [
      { left: '8%', right: '8%', top: 30, bottom: 90 },
      { left: '8%', right: '8%', top: '74%', bottom: 20 },
    ],
    xAxis: [
      { type: 'category', data: klineTimes, axisLine: { lineStyle: { color: '#2e3240' } }, axisLabel: { color: '#6a6d78', fontSize: 10 } },
      { type: 'category', data: klineTimes, gridIndex: 1, axisLine: { lineStyle: { color: '#2e3240' } }, axisLabel: { color: '#6a6d78', fontSize: 9 } },
    ],
    yAxis: [
      { type: 'value', scale: true, splitLine: { lineStyle: { color: '#2e3240', type: 'dashed' } }, axisLabel: { color: '#6a6d78', fontSize: 10, formatter: (v: number) => v.toFixed(2) } },
      { type: 'value', gridIndex: 1, splitLine: { show: false }, axisLabel: { color: '#6a6d78', fontSize: 9 }, min: 0, max: 100 },
    ],
    series: [
      { type: 'candlestick', data: candleData, itemStyle: { color: '#00c853', color0: '#ff5252', borderColor: '#00c853', borderColor0: '#ff5252' }, name: 'K线' },
      { type: 'line', data: bb.upper, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, name: 'BOLL上' },
      { type: 'line', data: bb.mid, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0' }, name: 'BOLL中' },
      { type: 'line', data: bb.lower, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#9c27b0', opacity: 0.4 }, areaStyle: { color: 'rgba(156,39,176,0.05)' }, name: 'BOLL下' },
      { type: 'line', data: ma5, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ffa726' }, name: 'MA5' },
      { type: 'line', data: ma10, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#42a5f5' }, name: 'MA10' },
      { type: 'line', data: ma20, smooth: true, symbol: 'none', lineStyle: { width: 1, color: '#ef5350' }, name: 'MA20' },
      { type: 'line', data: rsi, smooth: true, symbol: 'none', xAxisIndex: 1, yAxisIndex: 1, lineStyle: { width: 1, color: '#ab47bc' }, name: 'RSI(14)', markLine: { silent: true, data: [{ yAxis: 70, lineStyle: { color: '#ff5252', type: 'dashed' } }, { yAxis: 30, lineStyle: { color: '#00c853', type: 'dashed' } }] } },
    ],
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1e222d',
      borderColor: '#2e3240',
      textStyle: { color: '#d1d4dc', fontSize: 12 },
      formatter: (params: any[]) => {
        if (!params || params.length === 0) return '';
        const title = params[0].axisValue;
        const lines = params.map((p: any) => {
          const val = p.value;
          let display: string;
          if (Array.isArray(val)) {
            display = `O: ${val[0].toFixed(2)}  H: ${val[3].toFixed(2)}  L: ${val[2].toFixed(2)}  C: ${val[1].toFixed(2)}`;
          } else if (val != null) {
            display = val.toFixed(2);
          } else {
            display = '-';
          }
          return `${p.marker} ${p.seriesName}: ${display}`;
        });
        return `${title}<br/>${lines.join('<br/>')}`;
      },
    },
    legend: { data: ['MA5', 'MA10', 'MA20', 'BOLL中', 'RSI(14)'], top: 2, textStyle: { color: '#9fa3b0', fontSize: 10 } },
  };
}, [klineData, selectedTimeframe]);

  // 账户指标
  const holdValue = positions.reduce((sum: number, p: any) =>
    sum + (p.longQty - p.shortQty) * (prices[p.symbol] || 0), 0);
  const totalEquity = account ? Number(account.cash) + holdValue : 0;
  const dailyPnl = account ? totalEquity - Number(account.dayStartEquity) : 0;
  const totalPnl = account ? totalEquity - Number(account.initialEquity) : 0;

  // 盘口
  const ob = orderBook[selectedSymbol] || { asks: [], bids: [], spread: 0 };

  return (
    <div className="dashboard">
      {/* 图表区域 */}
      <div className="chart-area">
        <div className="chart-tabs">
          <button
            className={selectedSymbol === 'A' ? 'active' : ''}
            onClick={() => setSelectedSymbol('A')}
          >
            股票A (科技)
          </button>
          <button
            className={selectedSymbol === 'B' ? 'active' : ''}
            onClick={() => setSelectedSymbol('B')}
          >
            股票B (金融)
          </button>
          <div style={{ flex: 1 }} />
          <button
            className={selectedTimeframe === '1min' ? 'active' : ''}
            onClick={() => setSelectedTimeframe('1min')}
          >
            1分
          </button>
          <button
            className={selectedTimeframe === '5min' ? 'active' : ''}
            onClick={() => setSelectedTimeframe('5min')}
          >
            5分
          </button>
          <button
            className={selectedTimeframe === 'daily' ? 'active' : ''}
            onClick={() => setSelectedTimeframe('daily')}
          >
            日线
          </button>
        </div>
        <div className="chart-container">
          <ReactEChartsCore
            option={chartOption}
            style={{ height: '100%', width: '100%' }}
          />
        </div>
      </div>

      {/* 侧边面板 */}
      <div className="side-panel">
        {/* 账户总览 */}
        <div className="card">
          <h3>💰 账户总览</h3>
          <div className="info-row">
            <span className="label">现金</span>
            <span className="value">{account ? Number(account.cash).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : '---'}</span>
          </div>
          <div className="info-row">
            <span className="label">持仓市值</span>
            <span className="value">{holdValue.toFixed(2)}</span>
          </div>
          <div className="info-row">
            <span className="label">总资产</span>
            <span className="value">{totalEquity.toFixed(2)}</span>
          </div>
          <div className="info-row">
            <span className="label">杠杆</span>
            <span className="value">{account ? `${account.leverage}x` : '---'}</span>
          </div>
          <div className="info-row">
            <span className="label">今日盈亏</span>
            <span className={`value ${dailyPnl >= 0 ? 'up' : 'down'}`}>
              {dailyPnl >= 0 ? '+' : ''}{dailyPnl.toFixed(2)}
            </span>
          </div>
          <div className="info-row">
            <span className="label">总盈亏</span>
            <span className={`value ${totalPnl >= 0 ? 'up' : 'down'}`}>
              {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}
            </span>
          </div>
          <div className="info-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 6, marginTop: 4 }}>
            <span className="label">交易模式</span>
            <span className="value" style={{ fontSize: 11 }}>
              {isCN ? '🇨🇳 A股 T+1' : '🇺🇸 美股 T+0'}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => switchMode(isCN ? 'US' : 'CN')}>
                {isCN ? '切美股' : '切A股'}
              </button>
            </span>
          </div>
          {isCN && (
            <div className="info-row">
              <span className="label" style={{ color: 'var(--color-warning)' }}>⚠️ T+1规则</span>
              <span className="value" style={{ fontSize: 11, color: 'var(--color-warning)' }}>当日买入次日方可卖出</span>
            </div>
          )}
          <div className="info-row" style={{ borderTop: '1px solid var(--border-color)', paddingTop: 6, marginTop: 4 }}>
            <span className="label">角色预设</span>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
            <button className="btn btn-sm btn-ghost" onClick={async () => { await accountApi.reset(mode, '散户'); loadAccountData(mode); addNotification('已重置为散户', 'success'); }}>散户</button>
            <button className="btn btn-sm btn-ghost" onClick={async () => { await accountApi.reset(mode, '机构'); loadAccountData(mode); addNotification('已重置为机构', 'success'); }}>机构</button>
            <button className="btn btn-sm btn-ghost" onClick={async () => { await accountApi.reset(mode, '日内交易者'); loadAccountData(mode); addNotification('已重置为日内交易者', 'success'); }}>日内</button>
          </div>
          <div style={{ marginTop: 6 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => { document.body.classList.toggle('color-scheme-cn'); addNotification('配色已切换', 'info'); }}>
              切换配色
            </button>
          </div>
        </div>

        {/* 持仓明细 */}
        <div className="card">
          <h3>📊 持仓明细</h3>
          {positions.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 0' }}>暂无持仓</div>
          ) : (
            positions.map((pos: any) => (
              <div key={pos.symbol} style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{pos.symbol}</div>
                <div className="info-row">
                  <span className="label">多仓</span>
                  <span className="value">{pos.longQty} 股</span>
                </div>
                <div className="info-row">
                  <span className="label">空仓</span>
                  <span className="value">{pos.shortQty} 股</span>
                </div>
                <div className="info-row">
                  <span className="label">多仓成本</span>
                  <span className="value">{pos.longCost > 0 ? pos.longCost.toFixed(2) : '-'}</span>
                </div>
                {isCN && (
                  <div className="info-row">
                    <span className="label">今日可卖</span>
                    <span className="value" style={{ color: 'var(--color-warning)' }}>{Math.max(0, pos.longQty - (pos.boughtToday || 0))} 股</span>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* 盘口 */}
        <div className="card">
          <h3>📖 盘口深度 ({selectedSymbol})</h3>
          <div className="orderbook-levels">
            <div style={{ marginBottom: 4 }}>
              {ob.asks?.slice().reverse().map((a: any, i: number) => (
                <div key={i} className="ob-row ask">
                  <span>{a.price != null ? a.price.toFixed(2) : '-'}</span>
                  <span>{a.size ?? '-'}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2px 0', borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)' }}>
              价差: {ob.spread ?? '-'}
            </div>
            <div style={{ marginTop: 4 }}>
              {ob.bids?.map((b: any, i: number) => (
                <div key={i} className="ob-row bid">
                  <span>{b.price != null ? b.price.toFixed(2) : '-'}</span>
                  <span>{b.size ?? '-'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 下单 */}
        <div className="card">
          <h3>📝 下单</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <select className="input" value={orderType} onChange={(e) => setOrderType(e.target.value)}>
              <option value="market">市价单</option>
              <option value="limit">限价单</option>
              <option value="stop">止损单</option>
              <option value="stop-limit">止损限价单</option>
            </select>
            <select className="input" value={orderSide} onChange={(e) => setOrderSide(e.target.value)}>
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
              <option value="short" disabled={isCN}>{isCN ? '❌ 做空' : '做空'}</option>
              <option value="cover" disabled={isCN}>{isCN ? '❌ 平空' : '平空'}</option>
            </select>
            {orderType !== 'market' && (
              <input
                className="input"
                type="number"
                placeholder="价格"
                value={orderPrice}
                onChange={(e) => setOrderPrice(e.target.value)}
                step="0.01"
              />
            )}
            {(orderType === 'stop' || orderType === 'stop-limit') && (
              <input
                className="input"
                type="number"
                placeholder="触发价"
                value={orderTriggerPrice}
                onChange={(e) => setOrderTriggerPrice(e.target.value)}
                step="0.01"
              />
            )}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>数量:</span>
              <input
                className="input"
                type="number"
                value={orderQty}
                onChange={(e) => setOrderQty(parseInt(e.target.value) || 0)}
                min={1}
                step={100}
              />
              <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(orderQty + 100)}>+</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(Math.max(0, orderQty - 100))}>-</button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={placeOrder} disabled={orderSubmitting}>
                {orderSubmitting ? '提交中...' : '确认下单'}
              </button>
              <button className="btn btn-danger btn-sm" onClick={quickClear}>
                清仓
              </button>
            </div>
          </div>
        </div>

        {/* 挂单 */}
        <div className="card">
          <h3>📋 当前挂单</h3>
          {pendingOrders.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>无挂单</div>
          ) : (
            pendingOrders.map((o: any) => (
              <div key={o.id} className="pending-order">
                <span>{o.symbol} {o.side} {o.quantity}股 @ {o.price || '-'}</span>
                <span style={{ color: 'var(--color-warning)' }}>等待中</span>
              </div>
            ))
          )}
        </div>

        {/* 交易历史 */}
        <div className="card">
          <h3>📋 最近交易</h3>
          {tradeHistory.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无交易</div>
          ) : (
            tradeHistory.slice(0, 10).map((t: any, i: number) => (
              <div key={i} className="pending-order" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{t.symbol} {t.side} {t.quantity}股</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    @ {Number(t.price).toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  佣金:{Number(t.commission||0).toFixed(2)} 印花税:{Number(t.stampDuty||0).toFixed(2)} 过户费:{Number(t.transferFee||0).toFixed(2)} 总费用:¥{Number(t.totalFees||0).toFixed(2)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
