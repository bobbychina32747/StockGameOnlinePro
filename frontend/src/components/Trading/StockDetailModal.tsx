import { useEffect, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useMarketStore, useUIStore } from '../../store';
import { PriceText } from './PriceText';

// 公司资料弹窗（F10 简化版）：代码/上市日期/行业/简介/模拟市值/交易数据
export function StockDetailModal() {
  const detailSymbol = useUIStore((s) => s.detailSymbol);
  const setDetailSymbol = useUIStore((s) => s.setDetailSymbol);
  const stocks = useMarketStore((s) => s.stocks);
  const prices = useMarketStore((s) => s.prices);

  if (!detailSymbol) return null;

  const s = stocks.find((x: any) => x.symbol === detailSymbol);
  if (!s) return null;

  // 真实财报（后端按财报季生成）
  const [reports, setReports] = useState<any[]>([]);
  useEffect(() => {
    if (!detailSymbol) return;
    let alive = true;
    marketApi.reports(detailSymbol).then((list) => {
      if (alive && Array.isArray(list)) setReports(list);
    }).catch(() => {});
    return () => { alive = false; };
  }, [detailSymbol]);

  const price = prices[s.symbol] ?? s.price;
  const changePct = s.changePct ?? 0;
  const up = changePct >= 0;
  // 模拟总股本（按代码哈希生成一个稳定的"流通股本"，亿股）
  const shares = (parseInt(s.code || '0', 10) % 90 + 10) / 10; // 1.0 ~ 9.9 亿股
  const marketCap = price * shares * 1e8; // 元

  // A5 模拟财报（由代码哈希稳定生成，不随行情变化）
  const seed = (n: number) => { let x = parseInt(s.code || '600000', 10); for (let i = 0; i < n; i++) x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const revenue = (5 + seed(1) * 15).toFixed(1); // 亿
  const netProfit = (0.5 + seed(2) * 4).toFixed(2); // 亿
  const roe = (6 + seed(3) * 14).toFixed(1); // %
  const pe = (12 + seed(4) * 35).toFixed(1); // 倍
  const yoy = (seed(5) > 0.4 ? 1 : -1) * (5 + seed(6) * 30); // 营收同比

  // A6 资金流向（模拟：主力净流入方向与当日涨跌一致）
  const mainNet = changePct >= 0 ? 1 : -1;
  const mainFlow = (mainNet * (0.5 + seed(7) * 0.9) * (price * (s.dayVolume || 0)) / 1e8).toFixed(2); // 亿
  const retailFlow = (-mainNet * (0.2 + seed(8) * 0.5) * (price * (s.dayVolume || 0)) / 1e8).toFixed(2);

  // A5 最新公告（确定性生成几条）
  const notices = [
    { d: '今日', t: changePct >= 0 ? '股价异动公告：不存在应披露而未披露事项' : '关于股价波动情况的说明公告' },
    { d: '本周', t: '关于回购进展暨股份变动公告' },
    { d: '本月', t: '与多家机构签订战略合作框架协议' },
    { d: '上月', t: '关于股东减持计划实施完毕的公告' },
  ];

  return (
    <div className="modal-overlay" onClick={() => setDetailSymbol(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">{s.name}</h2>
            <span className="chart-code">{s.code}</span>
            <span className="chart-industry" style={{ marginLeft: 8 }}>{s.industry}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setDetailSymbol(null)}>✕</button>
        </div>

        <div className={`modal-price ${up ? 'up' : 'down'}`}>
          <PriceText value={price} className="modal-price-num" />
          <span className="modal-change">
            {up ? '+' : ''}{changePct.toFixed(2)}%
          </span>
        </div>

        <div className="modal-stats">
          <div className="modal-stat">
            <span className="label">上市日期</span>
            <span className="value">{s.listDate || '-'}</span>
          </div>
          <div className="modal-stat">
            <span className="label">所属行业</span>
            <span className="value">{s.industry || '-'}</span>
          </div>
          <div className="modal-stat">
            <span className="label">模拟总市值</span>
            <span className="value">≈ {(marketCap / 1e8).toFixed(1)} 亿元</span>
          </div>
          <div className="modal-stat">
            <span className="label">流通股本</span>
            <span className="value">{shares.toFixed(1)} 亿股</span>
          </div>
          <div className="modal-stat">
            <span className="label">今日开盘</span>
            <span className="value">{Number(s.dayOpen ?? price).toFixed(2)}</span>
          </div>
          <div className="modal-stat">
            <span className="label">今日最高</span>
            <span className="value up">{Number(s.dayHigh ?? price).toFixed(2)}</span>
          </div>
          <div className="modal-stat">
            <span className="label">今日最低</span>
            <span className="value down">{Number(s.dayLow ?? price).toFixed(2)}</span>
          </div>
          <div className="modal-stat">
            <span className="label">成交额(模拟)</span>
            <span className="value">{(price * (s.dayVolume || 0) / 1e4).toFixed(2)} 万</span>
          </div>
        </div>

        <div className="modal-section">
          <h4>资金流向（模拟）</h4>
          <div className="modal-stats" style={{ borderTop: 'none', paddingTop: 0 }}>
            <div className="modal-stat"><span className="label">主力净流入</span><span className={`value ${mainNet >= 0 ? 'up' : 'down'}`}>{mainNet >= 0 ? '+' : ''}{mainFlow} 亿</span></div>
            <div className="modal-stat"><span className="label">散户净流入</span><span className={`value ${mainNet >= 0 ? 'down' : 'up'}`}>{mainNet >= 0 ? '-' : '+'}{Math.abs(Number(retailFlow))} 亿</span></div>
          </div>
        </div>

        <div className="modal-section">
          <h4>业绩速览{reports.length > 0 ? `（${reports[0].quarter} · 真实财报）` : '（模拟）'}</h4>
          {reports.length > 0 ? (
            <>
              <div className="modal-stats" style={{ borderTop: 'none', paddingTop: 0 }}>
                <div className="modal-stat"><span className="label">营业收入</span><span className="value">{reports[0].revenue} 亿</span></div>
                <div className="modal-stat"><span className="label">营收同比</span><span className={`value ${reports[0].revenueYoy >= 0 ? 'up' : 'down'}`}>{reports[0].revenueYoy >= 0 ? '+' : ''}{reports[0].revenueYoy}%</span></div>
                <div className="modal-stat"><span className="label">净利润</span><span className="value">{reports[0].netProfit} 亿</span></div>
                <div className="modal-stat"><span className="label">净利率</span><span className="value">{reports[0].netMargin}%</span></div>
              </div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                <span className={reports[0].surprise === 1 ? 'up' : reports[0].surprise === -1 ? 'down' : ''}>
                  {reports[0].surprise === 1 ? '✅ 业绩超预期（财报公布后股价上涨）' : reports[0].surprise === -1 ? '⚠️ 业绩不及预期（财报公布后股价承压）' : '➖ 业绩符合预期'}
                </span>
              </div>
              {reports.length > 1 && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  财报历史：
                  {reports.slice(0, 4).map((r, i) => (
                    <span key={i} style={{ marginRight: 10, fontFamily: 'var(--font-mono)' }}>
                      {r.quarter} {r.revenueYoy >= 0 ? '+' : ''}{r.revenueYoy}%
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="modal-stats" style={{ borderTop: 'none', paddingTop: 0 }}>
              <div className="modal-stat"><span className="label">营业收入</span><span className="value">{revenue} 亿</span></div>
              <div className="modal-stat"><span className="label">营收同比</span><span className={`value ${yoy >= 0 ? 'up' : 'down'}`}>{yoy >= 0 ? '+' : ''}{yoy.toFixed(1)}%</span></div>
              <div className="modal-stat"><span className="label">净利润</span><span className="value">{netProfit} 亿</span></div>
              <div className="modal-stat"><span className="label">ROE</span><span className="value">{roe}%</span></div>
              <div className="modal-stat"><span className="label">市盈率(动)</span><span className="value">{pe} 倍</span></div>
            </div>
          )}
        </div>

        <div className="modal-section">
          <h4>最新公告</h4>
          {notices.map((n, i) => (
            <div key={i} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.t}</span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontSize: 11 }}>{n.d}</span>
            </div>
          ))}
        </div>

        <div className="modal-section">
          <h4>公司简介</h4>
          <p className="modal-desc">{s.description || '暂无简介'}</p>
        </div>
      </div>
    </div>
  );
}
