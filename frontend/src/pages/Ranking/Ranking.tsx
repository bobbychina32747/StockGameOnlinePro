import { useEffect, useState } from 'react';
import { rankingApi } from '../../services/api.client';

interface RankingEntry {
  userId: string;
  username: string;
  totalEquity: number;
  totalReturn: number;
  rank: number;
}

export default function Ranking() {
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRankings = async () => {
      try {
        const data = await rankingApi.get(50);
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
  }, []);

  if (loading) {
    return (
      <div className="ranking-page">
        <div style={{ textAlign: 'center', padding: 40 }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="ranking-page">
      <h2>🏆 排行榜</h2>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 50 }}>#</th>
              <th>用户</th>
              <th style={{ textAlign: 'right' }}>总资产</th>
              <th style={{ textAlign: 'right' }}>收益率</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const returnPct = (e.totalReturn * 100).toFixed(2);
              const isPositive = e.totalReturn >= 0;
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
                    ¥{e.totalEquity.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontFamily: 'var(--font-mono)',
                      color: isPositive ? 'var(--color-up)' : 'var(--color-down)',
                    }}
                  >
                    {isPositive ? '+' : ''}{returnPct}%
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
