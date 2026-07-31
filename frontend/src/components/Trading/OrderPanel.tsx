import { useCallback, useEffect, useState } from 'react';
import { tradingApi } from '../../services/api.client';
import { useAccountStore, useMarketStore, useUIStore } from '../../store';

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

  // ─── 下单 ───
  const placeOrder = async () => {
    if (orderSubmitting) return;
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
      setTimeout(() => setOrderSubmitting(false), 800);
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
    await tradingApi.cancelOrder(mode, id);
    loadOrders();
  };

  return (
    <>
      <div className="card">
        <h3>📝 下单 ({selectedSymbol})</h3>
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
              className="input" type="number" placeholder="价格" value={orderPrice}
              onChange={(e) => setOrderPrice(e.target.value)} step="0.01"
            />
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
            <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(orderQty + 100)}>+</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setOrderQty(Math.max(0, orderQty - 100))}>-</button>
          </div>
          {prices[selectedSymbol] && orderQty > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              预估金额: {(prices[selectedSymbol] * orderQty).toFixed(2)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={placeOrder} disabled={orderSubmitting}>
              {orderSubmitting ? '提交中...' : '确认下单'}
            </button>
            <button className="btn btn-danger btn-sm" onClick={quickClear}>清仓</button>
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
              <button className="btn btn-ghost btn-sm" onClick={() => cancelOrder(o.id)}>撤单</button>
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
                佣金:{Number(t.commission || 0).toFixed(2)} 印花税:{Number(t.stampDuty || 0).toFixed(2)} 总费:¥{Number(t.totalFees || 0).toFixed(2)}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
