import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore } from '../../store';

// B2 策略回测工具（后端 API：MA 交叉策略）
export default function Backtest() {
  const stocks = useMarketStore((s) => s.stocks);
  const [symbol, setSymbol] = useState('T1');
  const [fast, setFast] = useState(5);
  const [slow, setSlow] = useState(20);
  const [timeframe, setTimeframe] = useState('1min');
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    marketApi.stocks().then((list) => {
      if (Array.isArray(list) && list.length && !stocks.length) {
        useMarketStore.getState().setStocks(list);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setRunning(true);
    setErr('');
    try {
      const res = await marketApi.backtest({ symbol, fast, slow, timeframe });
      setResult(res);
      if (res?.error) setErr(res.error);
    } catch (e) {
      setErr('回测失败：' + (e as any).message);
    } finally {
      setRunning(false);
    }
  };

  // 收益曲线 SVG（归一化到 100px 高）
  const curvePoints = (() => {
    if (!result?.equityCurve?.length) return '';
    const data = result.equityCurve;
    const min = Math.min(...data, 100000);
    const max = Math.max(...data, 100000);
    const range = max - min || 1;
    const w = 100, h = 100;
    return data.map((v: number, i: number) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  })();

  return (
    <div className="backtest-page">
      <h2>🧪 策略回测</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>参数设置（MA 金叉买 / 死叉卖）</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginTop: 8 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            股票
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="backtest-select">
              {stocks.map((s: any) => (
                <option key={s.symbol} value={s.symbol}>{s.code} {s.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            快线 MA
            <input type="number" min={2} max={50} value={fast} onChange={(e) => setFast(Number(e.target.value))} className="backtest-input" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            慢线 MA
            <input type="number" min={5} max={120} value={slow} onChange={(e) => setSlow(Number(e.target.value))} className="backtest-input" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            周期
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="backtest-select">
              <option value="1min">1分</option>
              <option value="5min">5分</option>
              <option value="60min">60分</option>
              <option value="daily">日线</option>
            </select>
          </label>
          <button className="btn btn-primary" onClick={run} disabled={running}>
            {running ? '回测中...' : '开始回测'}
          </button>
        </div>
      </div>

      {err && <div style={{ color: 'var(--color-warning)', fontSize: 13, marginBottom: 8 }}>{err}</div>}

      {result && !err && (
        <div className="card">
          <h3>
            回测结果 · {result.symbol}（{result.timeframe} · {result.bars} 根）
          </h3>
          <div className="backtest-stats">
            <div className="backtest-stat">
              <span className="label">总收益</span>
              <span className={`value ${result.totalReturn >= 0 ? 'up' : 'down'}`}>
                {result.totalReturn >= 0 ? '+' : ''}{result.totalReturn}%
              </span>
            </div>
            <div className="backtest-stat">
              <span className="label">期末资金</span>
              <span className="value">¥{Number(result.finalEquity).toLocaleString()}</span>
            </div>
            <div className="backtest-stat">
              <span className="label">交易次数</span>
              <span className="value">{result.trades} 笔</span>
            </div>
            <div className="backtest-stat">
              <span className="label">胜率</span>
              <span className="value">{result.winRate}%</span>
            </div>
          </div>
          {curvePoints && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>资金曲线（起始 100,000）</div>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 160, background: 'var(--bg-secondary)', borderRadius: 6 }}>
                <polyline
                  points={curvePoints}
                  fill="none"
                  stroke={result.totalReturn >= 0 ? 'var(--color-up)' : 'var(--color-down)'}
                  strokeWidth="0.8"
                />
                <line x1="0" y1="100" x2="100" y2="100" stroke="var(--border-default)" strokeWidth="0.3" strokeDasharray="2,2" />
              </svg>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        <h3>说明</h3>
        <p style={{ lineHeight: 1.8 }}>
          · 策略：快线 MA 上穿慢线 MA 全仓买入，下穿全仓卖出（100 股整手），不计手续费<br />
          · 数据：当前内存中的历史 K 线（启动后约 3 个交易日），周期越长样本越少<br />
          · 结果仅供参考——模拟世界存在宏观反馈与新闻冲击，历史收益不代表未来
        </p>
      </div>
    </div>
  );
}
