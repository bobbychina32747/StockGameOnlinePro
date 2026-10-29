import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { LAB_DEFAULTS, exportLab } from '../../../packages/engine/lab';
import { LAB_POLICIES, LabConfig, LabPolicy, LabResult, LabRole } from '../../../packages/engine/lab-types';
import { translate as tr } from './localization';
import { useWorkspace } from './workspace';
import { money, Panel } from './ui';

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, DataZoomComponent, LegendComponent, CanvasRenderer]);
const policyNames: Record<LabPolicy, string> = { baseline: '无目标订单', lump: '一次性下单', twap: 'TWAP 等时拆单', vwap: 'VWAP 预设量曲线' };
const roleNames: Record<LabRole, string> = { maker: '做市商', noise: '噪声交易者', informed: '知情交易者', parent: '目标账户' };
const numericFields = [
  ['seed', '随机种子', 0, 4294967295], ['ticks', '实验步数', 60, 300], ['quantity', '目标股数', 1, 20000],
  ['quoteSize', '每档基础股数', 10, 400], ['replenishEvery', '补单间隔（步）', 3, 30],
  ['informationDelay', '公开信息延迟（步）', 1, 60], ['informedCount', '知情账户数', 0, 4],
  ['inventoryAversion', '库存风险系数', 0, 10], ['newsJumpBps', '消息冲击（bp）', -300, 300],
] as const;
const number = (value: number | null, digits = 2) => value === null ? '—' : value.toFixed(digits);
const bps = (value: number | null) => value === null ? '—' : number(value) + ' bp';
type View = 'paths' | 'liquidity' | 'flow' | 'impact';

export function Laboratory() {
  const { language } = useWorkspace();
  const t = (text: string) => tr(text, language);
  const [config, setConfig] = useState<LabConfig>({ ...LAB_DEFAULTS });
  const [result, setResult] = useState<LabResult | null>(null);
  const [policy, setPolicy] = useState<LabPolicy>('twap');
  const [view, setView] = useState<View>('liquidity');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const epoch = useRef(0), worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const input = useRef<HTMLInputElement>(null);
  const stop = () => { worker.current?.terminate(); worker.current = null; clearTimeout(timer.current); };
  useEffect(() => () => { epoch.current++; stop(); }, []);
  async function start(kind: 'run' | 'replay', file?: File) {
    const generation = ++epoch.current;
    stop(); setBusy(true); setError(''); setStatus('');
    try {
      if (file && file.size > 8 * 1024 * 1024) throw new Error('LAB_FILE_SIZE');
      const payload = kind === 'run' ? config : JSON.parse(await file!.text());
      if (generation !== epoch.current) return;
      const job = new Worker(new URL('./lab-worker.ts', import.meta.url), { type: 'module' });
      worker.current = job;
      const fail = (message: string) => {
        if (generation !== epoch.current) return;
        stop(); setBusy(false); setError(message);
      };
      job.onmessage = event => {
        if (generation !== epoch.current) return;
        if (!event.data?.ok) { fail(event.data?.error ?? 'LAB_FAILED'); return; }
        stop(); setBusy(false);
        setResult(event.data.result); setConfig(event.data.result.config);
        setStatus(kind === 'replay' ? '事件重放完成，全部校验值一致。' : '实验完成。');
      };
      job.onerror = () => fail('LAB_FAILED');
      timer.current = setTimeout(() => fail('LAB_TIMEOUT'), 30000);
      job.postMessage({ kind, input: payload });
    } catch (failure) {
      if (generation === epoch.current) { stop(); setBusy(false); setError(failure instanceof Error ? failure.message : 'LAB_FAILED'); }
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportLab(result))], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `stockgame-lab-${result.config.seed}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function field(entry: typeof numericFields[number]) {
    const [key, label, min, max] = entry;
    return <label key={key}>{t(label)}<input name={key} aria-label={t(label)} type="number" required min={min} max={max} step="1"
      disabled={busy} value={config[key]} onChange={e => setConfig(c => ({ ...c, [key]: Number(e.target.value) }))}/></label>;
  }
  const report = result?.reports[policy];
  const errorText = error === 'LAB_FILE_SIZE' ? '文件超过 8 MB。'
    : error === 'LAB_TIMEOUT' ? '实验超时，请减少步数后重试。'
    : error.startsWith('LAB_RANGE:') ? '参数超出范围，请检查输入。'
    : error === 'LAB_FAILED' ? '实验未完成，请重试。' : '实验文件无效，版本或校验值不匹配。';
  return <div className="laboratory" data-testid="laboratory">
    <Panel title={t('市场微观结构实验室')}>
      <p className="muted small lab-note">{t('独立合成账户 · 有限订单簿 · 不影响正式资产')}</p>
      <form onSubmit={e => { e.preventDefault(); void start('run'); }}>
        <div className="form-grid lab-fields">{numericFields.slice(0, 3).map(field)}<label>{t('方向')}<select aria-label={t('实验方向')} disabled={busy} value={config.side} onChange={e => setConfig(c => ({ ...c, side: e.target.value as 'buy' | 'sell' }))}><option value="buy">{t('买入')}</option><option value="sell">{t('卖出')}</option></select></label></div>
        <details className="lab-settings"><summary>{t('流动性与信息设置')}</summary><div className="form-grid lab-fields">{numericFields.slice(3).map(field)}</div></details>
        <div className="lab-actions"><button className="primary-button" data-testid="lab-run" disabled={busy}>{t(busy ? '计算中…' : '运行对照实验')}</button>
          {busy && <button type="button" className="outline-button" onClick={() => { epoch.current++; stop(); setBusy(false); setStatus('实验已取消。'); }}>{t('取消实验')}</button>}
          <button type="button" className="outline-button" disabled={!result || busy} onClick={download}>{t('导出事件日志')}</button>
          <button type="button" className="outline-button" disabled={busy} onClick={() => input.current?.click()}>{t('导入并校验重放')}</button>
          <input ref={input} hidden type="file" accept=".json,application/json" aria-label={t('导入实验文件')} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void start('replay', file); }}/>
        </div>
      </form>
      <div aria-live="polite">{error ? <p className="inline-error" role="alert">{t(errorText)}</p> : status && <p className="small lab-note" role="status">{t(status)}</p>}</div>
      <details className="lab-settings"><summary>{t('模型假设与指标')}</summary><ul className="lab-assumptions">
        <li>{t('单标的、连续交易、T+0、只做多；三家做市商和六个噪声账户使用有限资金与持仓。每笔成交双边各收 5 bp 手续费，按分向上取整。')}</li>
        <li>{t('潜在价值影响交易者判断；成交价只由挂单撮合产生。知情账户先看到价值变化，其他账户只看到延迟公开的信号。做市商按库存调整报价。')}</li>
        <li>{t('VWAP 按预设的 U 型预期成交量曲线拆单，不读取未来成交量。市价单未成交部分取消；拆单策略不会额外补追未成交数量。')}</li>
        <li>{t('四组共享相同外部随机信号。正的执行成本表示更贵；总短缺计入费用和未成交的期末机会成本。成交率不同的结果不能只比较均价。')}</li>
        <li>{t('OFI 累加逐次最优报价的数量变化；静态盘口失衡另算。5 步成交后变动是未扣费的方向收益，不是账户收益率。')}</li>
        <li>{t('实验步不是现实分钟。配对冲击与恢复只描述本模型；单次结果不是统计证明，也没有用真实 Level 2 数据校准。')}</li>
      </ul></details>
    </Panel>
    {result && <>
      <Panel title={t('执行成本对照')} action={<span className="mono small">{t('种子')} {result.config.seed} · {result.config.ticks} {t('步')}</span>}>
        <div className="table-scroll"><table data-testid="lab-costs"><thead><tr>{['策略', '成交 / 目标', '成交率', '成交均价', '手续费', '执行成本', '机会成本', '总执行短缺'].map(x => <th key={x}>{t(x)}</th>)}</tr></thead><tbody>
          {(['lump', 'twap', 'vwap'] as const).map(key => { const m = result.reports[key].metrics; return <tr key={key}><td>{t(policyNames[key])}</td><td className="mono">{m.filled} / {m.requested}</td><td className="mono">{number(m.fillRatio * 100)}%</td><td className="mono">{money(m.averagePrice)}</td><td className="mono">{money(m.fees)}</td><td className="mono">{bps(m.executionCostBps)}</td><td className="mono">{bps(m.opportunityCostBps)}</td><td className="mono">{bps(m.implementationShortfallBps)}</td></tr>; })}
        </tbody></table></div>
        <p className="small muted lab-note">{t('总执行短缺 = 成交率 × 执行成本 + 机会成本；1 bp = 0.01%。')}</p>
      </Panel>
      <Panel title={t('价格发现与信息延迟')}><LabChart result={result} policy={policy} view="paths"/></Panel>
      <Panel title={t('流动性与冲击')} action={<div className="lab-selectors"><select aria-label={t('观察策略')} value={policy} onChange={e => setPolicy(e.target.value as LabPolicy)}>{LAB_POLICIES.map(p => <option key={p} value={p}>{t(policyNames[p])}</option>)}</select><select aria-label={t('观察指标')} value={view} onChange={e => setView(e.target.value as View)}>{(['liquidity', 'flow', 'impact'] as const).map(v => <option key={v} value={v}>{t({ liquidity: '深度与价差', flow: '订单流与成交量', impact: '相对基线冲击' }[v])}</option>)}</select></div>}>
        <LabChart result={result} policy={policy} view={view}/>
        {report && <div className="lab-stats">{[
          ['平均价差', bps(report.metrics.averageSpreadBps)], ['平均单边深度', number(report.metrics.averageDepth, 0)],
          ['缺少双边报价', `${report.metrics.illiquidTicks} / ${result.config.ticks}`], ['OFI / 收益相关', number(report.metrics.ofiReturnCorrelation, 3)],
          ['绝对收益自相关', number(report.metrics.absoluteReturnAutocorrelation, 3)],
          ['期末队列失衡 QI', number(report.points[report.points.length - 1]?.imbalance ?? null, 3)],
        ].map(([label, value]) => <div key={label}><span>{t(label)}</span><strong className="mono">{value}</strong></div>)}</div>}
        <div className="table-scroll"><table><thead><tr>{['策略', '峰值冲击', '期末冲击', '尾段恢复半衰期（步）'].map(x => <th key={x}>{t(x)}</th>)}</tr></thead><tbody>{result.comparisons.map(c => <tr key={c.policy}><td>{t(policyNames[c.policy])}</td><td className="mono">{bps(c.peakImpactBps)}</td><td className="mono">{bps(c.terminalImpactBps)}</td><td className="mono">{c.recoveryHalfLifeTicks === null ? t('未观测到') : c.recoveryHalfLifeTicks}</td></tr>)}</tbody></table></div>
      </Panel>
      {report && <Panel title={t('策略生态与账本')} action={<span className="small">{t(policyNames[policy])}</span>}>
        <div className="table-scroll"><table data-testid="lab-ledger"><thead><tr>{['角色', '5 步有效观测', '5 步成交后变动', '期末库存', '期末盯市损益'].map(x => <th key={x}>{t(x)}</th>)}</tr></thead><tbody>{report.metrics.roleMarkouts.map(mark => {
          const accounts = report.accounts.filter(a => a.role === mark.role);
          const inventory = accounts.reduce((sum, a) => sum + a.inventory, 0);
          const pnl = accounts.reduce((sum, a) => sum + a.cash + a.inventory * report.metrics.terminalPrice - a.initialCash - a.initialInventory * 10000, 0);
          return <tr key={mark.role}><td>{t(roleNames[mark.role])}</td><td className="mono">{mark.trades}</td><td className="mono">{bps(mark.fiveTickMarkoutBps)}</td><td className="mono">{inventory}</td><td className="mono">{money(pnl)}</td></tr>;
        })}</tbody></table></div>
        <details className="lab-settings"><summary>{t('重放校验值（SHA-256）')}</summary><div className="lab-digests">{LAB_POLICIES.map(p => <p key={p}><span>{t(policyNames[p])}</span><code data-policy={p}>{result.reports[p].digest}</code></p>)}</div></details>
      </Panel>}
    </>}
  </div>;
}

function LabChart({ result, policy, view }: { result: LabResult; policy: LabPolicy; view: View }) {
  const { theme, language } = useWorkspace();
  const node = useRef<HTMLDivElement>(null), instance = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!node.current) return;
    const chart = echarts.init(node.current); instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(node.current);
    return () => { observer.disconnect(); chart.dispose(); instance.current = null; };
  }, []);
  useEffect(() => {
    if (!instance.current) return;
    const t = (text: string) => tr(text, language), points = result.reports[policy].points;
    const colors = ['#8493a4', '#fa7670', '#e5af4b', '#58c9a0', '#b99cf1', '#8faee3'];
    const series: any[] = [];
    const line = (name: string, data: (number | null)[], index: number, axis = 0, dashed = false) => ({
      name: t(name), type: 'line', showSymbol: false, connectNulls: false, data, yAxisIndex: axis,
      lineStyle: { width: 1.6, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color: colors[index] },
    });
    if (view === 'paths') {
      LAB_POLICIES.forEach((p, i) => series.push(line(policyNames[p], result.reports[p].points.map(v => v.twoSided ? v.mid / 100 : null), i)));
      series.push(line('潜在价值', points.map(p => p.fundamental / 100), 4, 0, true));
      series.push(line('公开信号', points.map(p => p.publicValue / 100), 5, 0, true));
    } else if (view === 'liquidity') {
      series.push(line('买方挂单深度', points.map(p => p.bidDepth), 3));
      series.push(line('卖方挂单深度', points.map(p => p.askDepth), 1));
      series.push(line('价差（bp）', points.map(p => p.twoSided && p.spread !== null ? p.spread / p.mid * 10000 : null), 2, 1));
    } else if (view === 'flow') {
      series.push({ name: t('成交量'), type: 'bar', data: points.map(p => p.volume), itemStyle: { color: '#8493a4', opacity: .35 } });
      series.push(line('事件 OFI', points.map(p => p.ofi), 2));
    } else {
      (['lump', 'twap', 'vwap'] as const).forEach((p, i) => series.push(line(policyNames[p], result.reports[p].points.map((point, index) => {
        const ref = result.reports.baseline.points[index];
        return point.twoSided && ref?.twoSided ? (result.config.side === 'buy' ? 1 : -1) * (point.mid - ref.mid) / ref.mid * 10000 : null;
      }), i + 1)));
    }
    const muted = theme === 'dark' ? '#8493a4' : '#647383', border = theme === 'dark' ? '#29333f' : '#d8dfe6';
    const previous = (instance.current.getOption()?.dataZoom as { start?: number; end?: number }[] | undefined)?.[0];
    instance.current.setOption({
      animation: false, backgroundColor: 'transparent',
      legend: { type: 'scroll', top: 0, textStyle: { color: muted, fontSize: 11 }, pageTextStyle: { color: muted } },
      tooltip: { trigger: 'axis', valueFormatter: (value: unknown) => typeof value === 'number' ? number(value, view === 'paths' || view === 'impact' ? 2 : 1) : '—', backgroundColor: theme === 'dark' ? '#18212b' : '#fff', borderColor: border, textStyle: { color: theme === 'dark' ? '#e8edf3' : '#172331' } },
      grid: { left: 58, right: view === 'liquidity' ? 55 : 20, top: 50, bottom: 48 },
      xAxis: { type: 'category', data: points.map(p => p.tick), name: t('步'), nameGap: 5, axisLabel: { color: muted }, axisLine: { lineStyle: { color: border } } },
      yAxis: [{ type: 'value', scale: true, axisLabel: { color: muted }, splitLine: { lineStyle: { color: border, type: 'dashed' } } }, ...(view === 'liquidity' ? [{ type: 'value', name: 'bp', axisLabel: { color: muted }, splitLine: { show: false } }] : [])],
      dataZoom: [{ type: 'inside', start: previous?.start ?? 0, end: previous?.end ?? 100 }, { type: 'slider', height: 14, bottom: 1, showDetail: false, borderColor: border, start: previous?.start ?? 0, end: previous?.end ?? 100 }], series,
    }, true);
  }, [result, policy, view, theme, language]);
  return <div className="lab-chart" ref={node} role="img" aria-label={tr(view === 'paths' ? '实验价格路径' : '实验流动性图表', language)} data-testid={`lab-chart-${view}`}/>;
}
