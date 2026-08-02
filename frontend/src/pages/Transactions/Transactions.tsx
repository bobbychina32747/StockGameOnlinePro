import { useEffect, useState } from 'react';
import { useUIStore } from '../../store';
import { accountApi } from '../../services/api.client';
import { useMarketStore } from '../../store';

const SIDE_LABEL: Record<string, string> = {
  buy: '买入', sell: '卖出', short: '做空', cover: '平仓', DIVIDEND: '分红',
};
const SIDE_CLS: Record<string, string> = {
  buy: 'up', sell: 'down', short: 'up', cover: 'down',
};

// Q7 交易流水页（交割单）
export default function Transactions() {
  const [list, setList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const stocks = useMarketStore((s) => s.stocks);

  useEffect(() => {
    useUIStore.getState().tutorialEvent('tx');
    let alive = true;
    accountApi.transactions('US').then((t) => {
      if (alive && Array.isArray(t)) setList(t);
    }).catch(() => {}).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const nameOf = (sym: string) => {
    const s = stocks.find((x: any) => x.symbol === sym);
    return s ? `${s.code} ${s.name}` : sym;
  };

  const filtered = filter === 'all' ? list : list.filter((t) => t.side === filter);

  return (
    <div className="transactions-page">
      <h2>💸 交易流水</h2>
      <div className="ranking-tabs" style={{ marginBottom: 10 }}>
        {([['all', '全部'], ['buy', '买入'], ['sell', '卖出'], ['short', '做空'], ['cover', '平仓'], ['DIVIDEND', '分红']] as const).map(([k, label]) => (
          <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>加载中...</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>股票</th>
                <th>方向</th>
                <th style={{ textAlign: 'right' }}>数量</th>
                <th style={{ textAlign: 'right' }}>价格</th>
                <th style={{ textAlign: 'right' }}>手续费</th>
                <th style={{ textAlign: 'right' }}>成交额</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const amt = Number(t.price) * Number(t.quantity);
                return (
                  <tr key={t.id}>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td>{nameOf(t.symbol)}</td>
                    <td className={SIDE_CLS[t.side] || ''}>{SIDE_LABEL[t.side] || t.side}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{t.quantity}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{Number(t.price).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{Number(t.totalFees ?? 0).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{amt.toFixed(2)}</td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
                    暂无交易记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
