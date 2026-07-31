import { useEffect, useState } from 'react';
import { rankingApi } from '../../services/api.client';

interface RankingEntry {
  userId: string;
  username: string;
  totalEquity: number;
  totalReturn: number;
  dayReturn?: number;
  rank: number;
}

type SortKey = 'totalReturn' | 'dayReturn' | 'equity';
const SORT_LABEL: Record<SortKey, string> = { totalReturn: '总收益', dayReturn: '今日', equity: '总资产' };

export default function Ranking() {
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('totalReturn');

  useEffect(() => {
    const fetchRankings = async () => {
      try {
        // A4 排序切换
        const data = await rankingApi.get(50, sort);
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
  }, [sort]);

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
      {/* B4 模拟大赛横幅 */}
      <div className="tournament-banner">
        <div className="tournament-title">
          <b>🏆 第 12 赛季 · 模拟炒股大赛</b>
          <span>赛季还剩 8 个交易日 · 赛季末前三名瓜分奖池</span>
        </div>
        <div className="tournament-podium">
          {third && <div className="podium-item third"><span>🥉</span><b>{third.username}</b><i>{((third.dayReturn ?? 0) * 100).toFixed(1)}%</i></div>}
          {champion && <div className="podium-item first"><span>🥇</span><b>{champion.username}</b><i>{((champion.totalReturn ?? 0) * 100).toFixed(1)}%</i></div>}
          {runnerUp && <div className="podium-item second"><span>🥈</span><b>{runnerUp.username}</b><i>{((runnerUp.dayReturn ?? 0) * 100).toFixed(1)}%</i></div>}
        </div>
      </div>

      <h2>🏆 排行榜</h2>
      <div className="ranking-tabs">
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
              const pct = sort === 'dayReturn' ? ((e.dayReturn ?? 0) * 100) : (e.totalReturn * 100);
              const val = sort === 'dayReturn' ? (e.totalEquity * (e.dayReturn ?? 0) / (1 + (e.dayReturn ?? 0))) : e.totalEquity;
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
                  <td>{e.username}</td>
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
    </div>
  );
}
