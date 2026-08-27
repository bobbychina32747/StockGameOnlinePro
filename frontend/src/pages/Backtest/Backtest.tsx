import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore } from '../../store';

// B2 策略回测工具（Phase 6：真实手续费 + 滑点 + 多策略 + 基准对比）
const STRATEGIES = [
  { value: 'ma_cross', label: 'MA 金叉/死叉', params: ['fast', 'slow'] },
  { value: 'rsi_reversal', label: 'RSI 超买超卖反转', params: ['period'] },
  { value: 'momentum', label: 'N 日动量', params: ['momentumN'] },
];

export default function Backtest() {
  const stocks = useMarketStore((s) => s.stocks);
  const [symbol, setSymbol] = useState('T1');
  const [strategy, setStrategy] = useState('ma_cross');
  const [fast, setFast] = useState(5);
  const [slow, setSlow] = useState(20);
  const [period, setPeriod] = useState(14);
  const [momentumN, setMomentumN] = useState(10);
  const [slippageBps, setSlippageBps] = useState(0); // 0=按市场默认
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
      const res = await marketApi.backtest({ symbol, strategy, fast, slow, period, momentumN, slippageBps, timeframe });
      setResult(res);
      if (res?.error) setErr(res.error);
    } catch (e) {
      setErr('回测失败：' + (e as any).message);
    } finally {
      setRunning(false);
    }
  };

  // 收益曲线 SVG（策略 + 基准双线，归一化到 100px 高）
  const curvePoints = (data: number[]) => {
    if (!data?.length) return '';
    const min = Math.min(...data, 100000);
    const max = Math.max(...data, 100000);
    const range = max - min || 1;
    const w = 100, h = 100;
    return data.map((v: number, i: number) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  };

  const stratPts = curvePoints(result?.equityCurve || []);
  const benchPts = curvePoints(result?.equityCurveBench || []);

  const stat = (label: string, value: any, cls = '') => (
    <div className="backtest-stat">
      <span className="label">{label}</span>
      <span className={`value ${cls}`}>{value}</span>
    </div>
  );

  return (
    <div className="backtest-page">
      <h2>🧪 策略回测</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>参数设置（真实手续费 + 滑点模型，与实盘同口径）</h3>
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
            策略
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="backtest-select">
              {STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>
          {strategy === 'ma_cross' && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                快线 MA
                <input type="number" min={2} max={50} value={fast} onChange={(e) => setFast(Number(e.target.value))} className="backtest-input" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
                慢线 MA
                <input type="number" min={5} max={120} value={slow} onChange={(e) => setSlow(Number(e.target.value))} className="backtest-input" />
              </label>
            </>
          )}
          {strategy === 'rsi_reversal' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              RSI 周期
              <input type="number" min={5} max={30} value={period} onChange={(e) => setPeriod(Number(e.target.value))} className="backtest-input" />
            </label>
          )}
          {strategy === 'momentum' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              动量回看天数
              <input type="number" min={2} max={60} value={momentumN} onChange={(e) => setMomentumN(Number(e.target.value))} className="backtest-input" />
            </label>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
            滑点 bp（0=默认）
            <input type="number" min={0} max={100} value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))} className="backtest-input" />
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
            回测结果 · {result.symbol}（{result.timeframe} · {result.bars} 根 · 市场{result.feeMode} · 滑点{result.slippageBps}bp）
          </h3>
          <div className="backtest-stats">
            {stat('总收益', `${result.totalReturn >= 0 ? '+' : ''}${result.totalReturn}%`, result.totalReturn >= 0 ? 'up' : 'down')}
            {stat('年化收益', `${result.annualizedReturn >= 0 ? '+' : ''}${result.annualizedReturn}%`, result.annualizedReturn >= 0 ? 'up' : 'down')}
            {stat('基准(持有)', `${result.benchmarkReturn >= 0 ? '+' : ''}${result.benchmarkReturn}%`, result.benchmarkReturn >= 0 ? 'up' : 'down')}
            {stat('最大回撤', `${result.maxDrawdown}%`)}
            {stat('夏普', result.sharpe)}
            {stat('盈亏因子', result.profitFactor ?? '—')}
            {stat('交易次数', `${result.trades} 笔`)}
            {stat('胜率', `${result.winRate}%`)}
            {stat('手续费', `¥${Number(result.fees).toLocaleString()}`)}
            {stat('滑点成本', `¥${Number(result.slippageCost).toLocaleString()}`)}
          </div>
          {stratPts && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                资金曲线（起始 100,000 · <span style={{ color: result.totalReturn >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>策略</span>
                {' · '}<span style={{ color: 'var(--color-info)' }}>基准买入持有</span>）
              </div>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 160, background: 'var(--bg-secondary)', borderRadius: 6 }}>
                {benchPts && <polyline points={benchPts} fill="none" stroke="var(--color-info)" strokeWidth="0.8" />}
                <polyline
                  points={stratPts}
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
          · 策略：MA 金叉/死叉 · RSI 超卖(30)买/超买(70)卖 · N 日动量转正买/转负卖，满仓进出（整手）<br />
          · 成本：与实盘同口径的三市场手续费（佣金最低/印花税/征费）+ 单边滑点（默认 A股·港股 5bp / 美股 3bp，可调）<br />
          · 基准：等额买入持有同期的收益，跑赢基准才算真策略<br />
          · 数据：当前内存中的历史 K 线（启动后约 3 个交易日），周期越长样本越少<br />
          · 结果仅供参考——模拟世界存在宏观反馈与新闻冲击，历史收益不代表未来
        </p>
      </div>
    </div>
  );
}
