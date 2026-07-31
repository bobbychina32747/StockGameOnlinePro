import { useEffect, useState } from 'react';
import { accountApi } from '../../services/api.client';

// Q4 历史净值曲线（每日快照 → SVG 折线，含峰值标注）
export function EquityCurve() {
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    accountApi.history('US').then((h) => {
      if (alive && Array.isArray(h)) setHistory(h);
    }).catch(() => {}).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  if (loading) return <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>加载净值历史...</div>;
  if (history.length < 2) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>
        暂无足够的历史数据（需运行 2 个交易日以上），日终结算后自动记录。
      </div>
    );
  }

  const equities = history.map((h) => Number(h.equity));
  const init = Number(history[0].equity);
  const min = Math.min(...equities, init);
  const max = Math.max(...equities, init);
  const range = max - min || 1;
  const w = 100, h = 60;
  const points = equities.map((v, i) => {
    const x = (i / (equities.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const peak = Math.max(...equities);
  const latest = equities[equities.length - 1];
  const totalReturn = ((latest - init) / init) * 100;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3>📈 历史净值曲线（{history.length} 个交易日）</h3>
      <div style={{ display: 'flex', gap: 20, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          当前净值 <b className={totalReturn >= 0 ? 'up' : 'down'} style={{ fontFamily: 'var(--font-mono)' }}>¥{latest.toLocaleString()}</b>
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          总收益 <b className={totalReturn >= 0 ? 'up' : 'down'} style={{ fontFamily: 'var(--font-mono)' }}>{totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%</b>
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          峰值 <b style={{ fontFamily: 'var(--font-mono)' }}>¥{peak.toLocaleString()}</b>
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          距峰值回撤 <b className="down" style={{ fontFamily: 'var(--font-mono)' }}>{(latest <= 0 ? 0 : (1 - latest / peak) * 100).toFixed(1)}%</b>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 160, background: 'var(--bg-secondary)', borderRadius: 6 }}>
        <polyline
          points={points}
          fill="none"
          stroke={totalReturn >= 0 ? 'var(--color-up)' : 'var(--color-down)'}
          strokeWidth="0.6"
        />
        {/* 初始资金基准线 */}
        <line
          x1="0" y1={h - ((init - min) / range) * h}
          x2={w} y2={h - ((init - min) / range) * h}
          stroke="var(--border-strong)" strokeWidth="0.3" strokeDasharray="2,2"
        />
        {equities.map((v, i) => (
          <circle key={i} cx={(i / (equities.length - 1)) * w} cy={h - ((v - min) / range) * h} r="0.5" fill="var(--text-muted)" />
        ))}
      </svg>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
        虚线为初始资金线（¥{init.toLocaleString()}）
      </div>
    </div>
  );
}
