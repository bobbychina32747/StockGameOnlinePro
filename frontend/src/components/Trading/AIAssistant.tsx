import { useEffect, useMemo, useRef, useState } from 'react';
import { marketApi } from '../../services/api.client';
import { useAccountStore, useMarketStore, useUIStore } from '../../store';
import { CollapsibleCard } from './CollapsibleCard';

// C4 AI 助手：基于行情/K线/新闻生成交易建议 + C2 语音涨跌提醒 + P4 AI 对手盘排行榜
export function AIAssistant() {
  const stocks = useMarketStore((s) => s.stocks);
  const prices = useMarketStore((s) => s.prices);
  const klines = useMarketStore((s) => s.klines);
  const latestNews = useUIStore((s) => s.latestNews);
  const selectedSymbol = useUIStore((s) => s.selectedSymbol);
  const account = useAccountStore((s) => s.account);
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem('ss.voice') === '1');
  // P4 AI 对手盘排行榜（完全本地：策略 + 随机森林，零外部 API）
  const [opponents, setOpponents] = useState<any[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      marketApi.aiOpponents().then((list) => {
        if (alive && Array.isArray(list)) setOpponents(list);
      }).catch(() => {});
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const price = prices[selectedSymbol];
  const stock = stocks.find((s: any) => s.symbol === selectedSymbol);
  const bars = (klines[selectedSymbol]?.['1min'] || []) as any[];

  // 指标计算
  const advice = useMemo(() => {
    const tips: string[] = [];
    const closes = bars.map((k) => Number(k.close));
    const changePct = stock?.changePct ?? 0;
    if (changePct >= 2) tips.push(`⚠️ 短线强势：今日涨幅 ${changePct.toFixed(2)}%，注意追高风险`);
    else if (changePct <= -2) tips.push(`📉 今日跌 ${Math.abs(changePct).toFixed(2)}%，关注支撑位是否企稳`);
    if (closes.length >= 15) {
      const ma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
      tips.push(ma5 >= ma10 ? '🟢 MA5 在 MA10 上方，短期多头排列' : '🔴 MA5 跌破 MA10，短期偏空');
      // RSI
      let g = 0, l = 0;
      for (let i = closes.length - 14; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
      }
      if (g + l > 0) {
        const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
        if (rsi > 70) tips.push(`🧯 RSI ${rsi.toFixed(0)} 超买区，谨慎追高`);
        else if (rsi < 30) tips.push(`💎 RSI ${rsi.toFixed(0)} 超卖区，留意反弹`);
      }
    }
    if (latestNews) {
      const up = latestNews.includes('涨') || latestNews.includes('利好') || latestNews.includes('放水');
      const down = latestNews.includes('跌') || latestNews.includes('利空') || latestNews.includes('制裁') || latestNews.includes('收紧');
      if (up) tips.push(`📰 近期消息面偏暖：「${latestNews.slice(0, 18)}…」`);
      if (down) tips.push(`📰 近期消息面偏冷：「${latestNews.slice(0, 18)}…」`);
    }
    if (tips.length === 0) tips.push('📊 行情平稳，建议观望，等待明确信号');
    return tips;
  }, [bars, stock, latestNews]);

  // P4 与 AI 对手盘对比（跑赢中位数才有资格说话）
  const userReturn = account?.initialEquity > 0 && account?.totalEquity != null
    ? ((Number(account.totalEquity) - Number(account.initialEquity)) / Number(account.initialEquity)) * 100
    : null;
  const medianAi = opponents.length ? opponents[Math.floor(opponents.length / 2)]?.pnlPct : null;
  const topAi = opponents[0];
  const beaten = userReturn != null && medianAi != null && userReturn > medianAi;

  // C2 语音提醒：价格相对昨收波动超 1% 播报
  const prevPriceRef = useRef(price);
  useEffect(() => {
    if (!voiceOn || price == null) { prevPriceRef.current = price; return; }
    const prev = prevPriceRef.current;
    if (prev != null && prev > 0) {
      const move = Math.abs((price - prev) / prev);
      if (move >= 0.01) {
        try {
          const u = new SpeechSynthesisUtterance(
            `${stock?.name || selectedSymbol} 当前价 ${price.toFixed(2)}，${price >= prev ? '上涨' : '下跌'} ${(move * 100).toFixed(1)}%`
          );
          u.lang = 'zh-CN';
          u.rate = 1;
          window.speechSynthesis.speak(u);
        } catch (e) { /* 语音不可用忽略 */ }
      }
    }
    prevPriceRef.current = price;
  }, [price, voiceOn, stock, selectedSymbol]);

  const toggleVoice = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    localStorage.setItem('ss.voice', next ? '1' : '0');
  };

  return (
    <CollapsibleCard
      title={`🤖 AI 助手 · ${stock?.name || selectedSymbol}`}
    >
      <div className="ai-advice">
        {advice.map((t, i) => (
          <div key={i} className="ai-tip">{t}</div>
        ))}
      </div>
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className={`btn btn-sm ${voiceOn ? 'btn-primary' : 'btn-ghost'}`} onClick={toggleVoice}>
          {voiceOn ? '🔊 语音提醒开' : '🔇 语音提醒关'}
        </button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>价格波动 ≥1% 自动播报</span>
      </div>
      {/* P4 AI 对手盘排行榜：本地策略 + 随机森林，零外部 API */}
      {opponents.length > 0 && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            🤖 AI 对手盘
            <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>
              （本地策略+随机森林，零 API）
            </span>
          </div>
          {opponents.slice(0, 5).map((o, i) => (
            <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
              <span>
                #{i + 1} {o.name}
                <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 10 }}>{o.strategyName}</span>
              </span>
              <span className={o.pnlPct >= 0 ? 'up' : 'down'} style={{ fontFamily: 'var(--font-mono)' }}>
                {o.pnlPct >= 0 ? '+' : ''}{o.pnlPct}% · {o.tier}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-warning)' }}>
            {beaten
              ? `🏆 你的收益 ${userReturn!.toFixed(2)}% 已跑赢 AI 中位数 ${medianAi!.toFixed(2)}%，继续保持！`
              : userReturn != null
                ? `🤖 你的收益 ${userReturn.toFixed(2)}%，连 AI 中位数 ${medianAi!.toFixed(2)}% 都没跑赢——AI 都打不过还想炒股赚钱？`
                : '🤖 AI 都打不过还想炒股赚钱？先跑赢 AI 中位数再说。'}
          </div>
          {topAi && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
              「{topAi.name}」：{topAi.taunt}
            </div>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}
