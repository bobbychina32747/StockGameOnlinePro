import { useCallback, useEffect, useState } from 'react';
import { tradingApi } from '../../services/api.client';
import { useAccountStore, useMarketStore, useUIStore } from '../../store';
import { CollapsibleCard } from './CollapsibleCard';
import { isTradingTimeFor, sessionLabel } from '../../utils/marketSessions';

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

// 右侧下单面板：下单表单 + 挂单 + 交易历史 + 一键清仓
export function OrderPanel() {
  const mode = useUIStore((s) => s.marketMode);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const addNotification = useUIStore((s) => s.addNotification);
  const positions = useAccountStore((s) => s.positions);
  const fetchAccount = useAccountStore((s) => s.fetchAccount);
  const prices = useMarketStore((s) => s.prices);

  const isCN = mode === 'CN';
  const [orderType, setOrderType] = useState('market');
  const [orderSide, setOrderSide] = useState('buy');
  const [orderQty, setOrderQty] = useState(100);
  const [orderPrice, setOrderPrice] = useState('');
  const [orderTriggerPrice, setOrderTriggerPrice] = useState('');
  const [pendingOrders, setPendingOrders] = useState<OrderEntry[]>([]);
  const [tradeHistory, setTradeHistory] = useState<TradeEntry[]>([]);
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const account = useAccountStore((s) => s.account);
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const loadOrders = useCallback(async () => {
    try {
      const [pending, history] = await Promise.all([
        tradingApi.getPending(mode),
        tradingApi.getHistory(mode),
      ]);
      setPendingOrders(Array.isArray(pending) ? pending : []);
      setTradeHistory(Array.isArray(history) ? history : []);
    } catch (e) {
      console.warn('[OrderPanel] 加载订单失败:', e);
    }
  }, [mode]);

  useEffect(() => {
    loadOrders();
    const timer = setInterval(loadOrders, 15000);
    return () => clearInterval(timer);
  }, [loadOrders]);

  // ─── Q8 实时校验：资金预算 / 数量 / 价格 ───
  const livePrice = prices[selectedSymbol] ?? 0;
  const effPrice =
    (orderType === 'limit' || orderType === 'stop-limit' || orderType === 'fok' || orderType === 'ioc') && parseFloat(orderPrice)
      ? parseFloat(orderPrice)
      : livePrice;
  const feeRate = 0.0008; // 综合费率估算（佣金+印花税）
  const estimated = orderQty * effPrice;
  const fee = estimated * feeRate;
  const totalCost = estimated + fee;
  const cash = Number(account?.cash ?? 0);
  const overBudget = orderSide === 'buy' && totalCost > cash && estimated > 0;
  const invalidQty = !orderQty || orderQty <= 0 || !Number.isInteger(Number(orderQty));
  // P1 休市禁用：按当前市场独立时段判断（每 10s 刷新；后端下单接口同样按市场校验）
  // 管理员调试模式（休市忽略）：服务端对开启者放行，前端同步解锁下单按钮
  const debugMode = useUIStore((s) => s.debugMode);
  const [marketOpen, setMarketOpen] = useState(isTradingTimeFor(mode));
  useEffect(() => {
    setMarketOpen(isTradingTimeFor(mode));
    const id = setInterval(() => setMarketOpen(isTradingTimeFor(mode)), 10000);
    return () => clearInterval(id);
  }, [mode]);
  const canSubmit = !orderSubmitting && !invalidQty && !overBudget && effPrice > 0 && (marketOpen || debugMode);

  // ─── 下单 ───
  const placeOrder = async () => {
    if (orderSubmitting) return;
    // 限价/止损类订单必须填写 >0 的价格
    if ((orderType === 'limit' || orderType === 'stop' || orderType === 'stop-limit' || orderType === 'fok' || orderType === 'ioc') && !(parseFloat(orderPrice) > 0)) {
      addNotification('请输入大于 0 的订单价格', 'error');
      return;
    }
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
        const filledQty = result.fill?.quantity;
        if (filledQty != null && filledQty < orderQty) {
          addNotification(`⚠️ 部分成交: ${selectedSymbol} ${orderSide} 仅成交 ${filledQty}/${orderQty}股`, 'info');
        } else {
          addNotification(`下单成功: ${selectedSymbol} ${orderSide} ${orderQty}股`, 'success');
        }
        fetchAccount(mode);
        loadOrders();
      } else {
        addNotification(`下单失败: ${result.error}`, 'error');
      }
    } catch (error) {
      const axiosErr = error as { response?: { data?: { message?: string } } };
      addNotification(`下单失败: ${axiosErr?.response?.data?.message || '网络错误'}`, 'error');
    } finally {
      // 请求 settle 后立即解锁（orderSubmitting 已防重复提交，无需固定延时）
      setOrderSubmitting(false);
    }
  };

  // ─── 一键清仓 ───
  const quickClear = async () => {
    if (!window.confirm('确定一键清仓所有持仓？')) return;
    try {
      const orderPromises: Promise<unknown>[] = [];
      for (const pos of (positions as any[])) {
        if (pos.longQty > 0) {
          orderPromises.push(
            tradingApi.placeOrder(mode, { symbol: pos.symbol, type: 'market', side: 'sell', quantity: pos.longQty })
          );
        }
        if (pos.shortQty > 0) {
          orderPromises.push(
            tradingApi.placeOrder(mode, { symbol: pos.symbol, type: 'market', side: 'cover', quantity: pos.shortQty })
          );
        }
      }
      await Promise.all(orderPromises);
      addNotification('已清仓', 'success');
      fetchAccount(mode);
      loadOrders();
    } catch (error) {
      console.error('[OrderPanel] 清仓失败:', error);
      addNotification('清仓失败，部分订单可能未成交', 'error');
    }
  };

  const cancelOrder = async (id: string) => {
    try {
      await tradingApi.cancelOrder(mode, id);
      loadOrders();
    } catch (error) {
      const axiosErr = error as { response?: { data?: { message?: string } } };
      addNotification(`撤单失败: ${axiosErr?.response?.data?.message || '网络错误'}`, 'error');
      loadOrders();
    }
  };

  return (
    <>
      <CollapsibleCard title={`📝 下单 (${selectedSymbol})`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <select className="input" value={orderType} onChange={(e) => { setOrderType(e.target.value); if (e.target.value === 'limit') useUIStore.getState().tutorialEvent('limit'); }}>
            <option value="market">市价单</option>
            <option value="limit">限价单</option>
            <option value="stop">止损单</option>
            <option value="stop-limit">止损限价单</option>
            <option value="fok">FOK（全成或撤）</option>
            <option value="ioc">IOC（即成余撤）</option>
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
          <select className="input" value={orderSide} onChange={(e) => setOrderSide(e.target.value)}>
            <option value="buy">买入</option>
            <option value="sell">卖出</option>
            <option value="short" disabled={isCN}>{isCN ? '❌ 做空' : '做空'}</option>
            <option value="cover" disabled={isCN}>{isCN ? '❌ 平空' : '平空'}</option>
          </select>
          <button className="btn btn-sm btn-ghost" title="买卖对切" onClick={() => setOrderSide(orderSide === 'buy' ? 'sell' : 'buy')}>⇄</button>
          </div>
          {orderType !== 'market' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input" type="number" placeholder="价格" value={orderPrice}
                onChange={(e) => setOrderPrice(e.target.value)} step="0.01"
              />
              <button className="btn btn-sm btn-ghost" title="填入现价" onClick={() => prices[selectedSymbol] && setOrderPrice(String(prices[selectedSymbol].toFixed(2)))}>现价</button>
            </div>
          )}
          {(orderType === 'stop' || orderType === 'stop-limit') && (
            <input
              className="input" type="number" placeholder="触发价" value={orderTriggerPrice}
              onChange={(e) => setOrderTriggerPrice(e.target.value)} step="0.01"
            />
          )}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>数量:</span>
            <input
              className="input" type="number" value={orderQty}
              onChange={(e) => setOrderQty(parseInt(e.target.value) || 0)} min={1} step={100}
            />
            <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(100)}>100</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(500)}>500</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(1000)}>1000</button>
            <button className="btn btn-sm btn-ghost" onClick={() => { const p = prices[selectedSymbol] || 0; setOrderQty(p > 0 ? Math.floor((cash / p) / 100) * 100 : 0); }} title="按可用现金全仓">全仓</button>
          </div>
          {effPrice > 0 && orderQty > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 }}>
              <div>预估金额: {estimated.toFixed(2)}（手续费≈{fee.toFixed(2)}）</div>
              <div>
                可用现金: <b style={{ fontFamily: 'var(--font-mono)' }}>¥{cash.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</b>
                {orderSide === 'buy' && (
                  <span className={overBudget ? 'down' : 'up'} style={{ marginLeft: 6 }}>
                    {overBudget ? '⚠️ 超出可用资金' : `余量 ¥${(cash - totalCost).toFixed(2)}`}
                  </span>
                )}
              </div>
              {invalidQty && <div className="down">数量需为正整数</div>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={placeOrder} disabled={!canSubmit}>
              {!marketOpen && !debugMode ? `休市中（${sessionLabel(mode)}）` : orderSubmitting ? '提交中...' : '确认下单'}
            </button>
            <button className="btn btn-danger btn-sm" onClick={quickClear}>清仓</button>
          </div>
        </div>
    </CollapsibleCard>

      {/* 挂单 */}
      <CollapsibleCard title="📋 当前挂单">
        {pendingOrders.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>无挂单</div>
        ) : (
          pendingOrders.map((o: any) => (
            <div key={o.id} className="pending-order">
              <span>{o.symbol} {o.side} {o.quantity}股 @ {o.price || '-'}</span>
              {confirmCancelId === o.id ? (
                <button className="btn btn-danger btn-sm" onClick={() => { cancelOrder(o.id); setConfirmCancelId(null); }} onMouseLeave={() => setTimeout(() => setConfirmCancelId(null), 1500)}>确认撤单？</button>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmCancelId(o.id)}>撤单</button>
              )}
            </div>
          ))
        )}
    </CollapsibleCard>

      {/* 交易历史 */}
      <CollapsibleCard title="📋 最近交易">
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
                佣金:{Number(t.commission || 0).toFixed(2)} 印花税:{Number(t.stampDuty || 0).toFixed(2)} 总费:¥{Number(t.totalFees || 0).toFixed(2)}
              </div>
            </div>
          ))
        )}
    </CollapsibleCard>
    </>
  );
}
