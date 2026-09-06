import { useEffect, useState } from 'react';
import { rankingApi, seasonApi } from '../../services/api.client';
import { useUIStore } from '../../store';

interface RankingEntry {
  userId: string;
  username: string;
  totalEquity: number;
  totalReturn: number;
  dayReturn?: number;
  rank: number;
  tier?: string;
  market?: string;
}

type SortKey = 'totalReturn' | 'dayReturn' | 'equity';
const SORT_LABEL: Record<SortKey, string> = { totalReturn: '总收益', dayReturn: '今日', equity: '总资产' };

export default function Ranking() {
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('totalReturn');
  // 三服务器：跨服总榜 / 服内榜（CN/HK/US）
  const [market, setMarket] = useState('ALL');
  // Phase C: 模拟大赛 V1（快照净值赛季）
  const [view, setView] = useState<'season' | 'all'>('season');
  const [seasonInfo, setSeasonInfo] = useState<any>(null);
  const [seasonBoard, setSeasonBoard] = useState<any[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const addNotification = useUIStore((s) => s.addNotification);

  useEffect(() => {
    const fetchRankings = async () => {
      try {
        // A4 排序切换
        const data = await rankingApi.get(50, sort, market);
        setEntries(Array.isArray(data) ? data : []);
      } catch (e) {
        console.error('获取排行榜失败', e);
      } finally {
        setLoading(false);
      }
    };
    fetchRankings();
    const interval = setInterval(fetchRankings, 30000);
    return () => clearInterval(interval);
  }, [sort, market]);

  // Phase C: 赛季信息 + 赛季榜（30s 刷新）
  useEffect(() => {
    const loadSeason = async () => {
      try {
        const [info, board] = await Promise.all([
          seasonApi.current(),
          seasonApi.leaderboard('ALL', 50),
        ]);
        setSeasonInfo(info);
        setSeasonBoard(Array.isArray(board) ? board : []);
      } catch (e) { /* 未登录/无赛季时静默 */ }
    };
    loadSeason();
    const id = setInterval(loadSeason, 30000);
    return () => clearInterval(id);
  }, []);

  const doEnroll = async () => {
    setEnrolling(true);
    try {
      const r = await seasonApi.enroll();
      if (r && r.success) {
        addNotification(`🏆 报名成功！${r.season ? r.season.name : ''} 已开赛`, 'success');
        const info = await seasonApi.current();
        setSeasonInfo(info);
      } else {
        addNotification(`报名失败：${(r && r.error) || '未知错误'}`, 'error');
      }
    } catch (e) {
      addNotification('报名失败，请稍后再试', 'error');
    } finally {
      setEnrolling(false);
    }
  };

  if (loading) {
    return (
      <div className="ranking-page">
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  const champion = entries[0];
  const runnerUp = entries[1];
  const third = entries[2];

  return (
    <div className="ranking-page">
      {/* Phase C: 模拟大赛横幅（真实赛季数据 + 报名入口） */}
      <div className="tournament-banner">
        <div className="tournament-title">
          <b>🏆 {seasonInfo?.season?.name || '模拟炒股大赛'}</b>
          <span>
            {seasonInfo?.season?.status === 'enrolling' && '报名中 · 首位报名者开赛'}
            {seasonInfo?.season?.status === 'running' && `赛季进行中 · 剩余 ${seasonInfo.season.daysLeft} 个游戏日`}
            {seasonInfo?.season?.status === 'settled' && '赛季已结算 · 新赛季报名中'}
            {seasonInfo?.enrolled && ` · 我的赛季收益 ${seasonInfo.myReturn ?? '--'}%（第 ${seasonInfo.myRank ?? '--'} 名）`}
          </span>
        </div>
        {seasonInfo?.season?.status === 'enrolling' && !seasonInfo?.enrolled && (
          <button className="btn btn-primary" disabled={enrolling} onClick={doEnroll}>
            {enrolling ? '报名中…' : '📝 一键报名（三市场同时参赛）'}
          </button>
        )}
        <div className="tournament-podium">
          {third && <div className="podium-item third"><span>🥉</span><b>{third.username}</b><i>{((third.dayReturn ?? 0) * 100).toFixed(1)}%</i></div>}
          {champion && <div className="podium-item first"><span>🥇</span><b>{champion.username}</b><i>{((champion.totalReturn ?? 0) * 100).toFixed(1)}%</i></div>}
          {runnerUp && <div className="podium-item second"><span>🥈</span><b>{runnerUp.username}</b><i>{((runnerUp.dayReturn ?? 0) * 100).toFixed(1)}%</i></div>}
        </div>
      </div>

      {/* Phase C: 赛季榜 / 全服榜 Tab */}
      <div className="ranking-tabs" style={{ marginTop: 4 }}>
        <button className={view === 'season' ? 'active' : ''} onClick={() => setView('season')}>🏆 赛季榜</button>
        <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>🌐 全服榜</button>
      </div>

      {view === 'season' ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 50 }}>#</th>
                <th>玩家</th>
                <th style={{ textAlign: 'right' }}>赛季收益率</th>
                <th style={{ textAlign: 'right' }}>赛季盈亏</th>
              </tr>
            </thead>
            <tbody>
              {seasonBoard.map((e, i) => (
                <tr key={e.userId}>
                  <td>{i < 3 ? <span style={{ fontSize: 16 }}>{['🥇', '🥈', '🥉'][i]}</span> : i + 1}</td>
                  {/* 赛季榜服务端按 userId 输出（用户名脱敏口径与全服榜一致，展示 ID 前 6 位） */}
                  <td>玩家 {String(e.userId).slice(0, 6)}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: e.seasonReturn >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                    {Number(e.seasonReturn).toFixed(2)}%
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>¥{Number(e.seasonPnl).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
              {seasonBoard.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: 16 }}>赛季暂无选手，报名即开赛</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
      <h2>🌐 排行榜</h2>
      
        <div className="ranking-tabs" style={{ marginTop: 4 }}>
          {([['ALL', '🏆 跨服总榜'], ['CN', '🇨🇳 A股服'], ['HK', '🇭🇰 港股服'], ['US', '🇺🇸 美股服']] as const).map(([k, label]) => (
            <button key={k} className={market === k ? 'active' : ''} onClick={() => setMarket(k)}>{label}</button>
          ))}
        </div><div className="ranking-tabs">
        {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
          <button key={k} className={sort === k ? 'active' : ''} onClick={() => setSort(k)}>
            {SORT_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 50 }}>#</th>
              <th>用户</th>
              <th style={{ textAlign: 'right' }}>{sort === 'dayReturn' ? '今日盈亏' : '总资产'}</th>
              <th style={{ textAlign: 'right' }}>{sort === 'dayReturn' ? '今日收益率' : '总收益率'}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const dr = e.dayReturn ?? 0;
              const pct = sort === 'dayReturn' ? (dr * 100) : (e.totalReturn * 100);
              // Phase C: dayReturn=-1（-100%）时 1+dr=0 除零 → 分母兜底防 NaN/∞
              const val = sort === 'dayReturn' ? (e.totalEquity * dr / Math.max(1 + dr, 1e-6)) : e.totalEquity;
              const isPositive = pct >= 0;
              return (
                <tr key={e.userId}>
                  <td>
                    {e.rank >= 1 && e.rank <= 3 ? (
                      <span style={{ fontSize: 16 }}>{['🥇', '🥈', '🥉'][e.rank - 1]}</span>
                    ) : (
                      e.rank || '-'
                    )}
                  </td>
                  <td>{e.username} {e.tier && <span title={`段位 ${e.tier}`} style={{ fontSize: 12 }}>{({ 王者: '🐉', 大师: '👑', 钻石: '🔷', 铂金: '💎', 黄金: '🥇', 白银: '🥈', 青铜: '🥉' } as Record<string, string>)[e.tier] || ''}</span>}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>
                    ¥{(sort === 'dayReturn' ? val : e.totalEquity).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      color: isPositive ? 'var(--color-up)' : 'var(--color-down)',
                    }}
                  >
                    {isPositive ? '+' : ''}{pct.toFixed(2)}%
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
                  暂无排行数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
        </>
      )}
    </div>
  );
}
