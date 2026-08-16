import { useEffect, useMemo } from 'react';
import { useUIStore } from '../../store';

// 成就定义：基于绩效指标判定（B3）
interface Achievement {
  id: string;
  icon: string;
  name: string;
  desc: string;
  check: (perf: any) => boolean;
}

const ACHIEVEMENTS: Achievement[] = [
  { id: 'rookie', icon: '🌱', name: '新手上路', desc: '完成开户，开始你的交易生涯', check: () => true },
  { id: 'first-win', icon: '🍀', name: '小赚一笔', desc: '账户总收益为正', check: (p) => Number(p.totalReturn) > 0 },
  { id: 'money-machine', icon: '💰', name: '赚钱机器', desc: '总收益率超过 10%', check: (p) => Number(p.totalReturn) >= 0.1 },
  { id: 'quant-king', icon: '🧠', name: '量化圣手', desc: '夏普比率超过 1.0', check: (p) => Number(p.sharpeRatio) >= 1.0 },
  { id: 'risk-master', icon: '🛡️', name: '风控大师', desc: '正收益且最大回撤小于 10%', check: (p) => Number(p.totalReturn) > 0 && Number(p.maxDrawdown) > -0.1 },
  { id: 'rollercoaster', icon: '🎢', name: '过山车体验券', desc: '最大回撤超过 30%（这很勇敢）', check: (p) => Number(p.maxDrawdown) <= -0.3 },
  { id: 'stable', icon: '📈', name: '稳稳的幸福', desc: '年化波动率低于 20% 且收益为正', check: (p) => Number(p.volatility) < 0.2 && Number(p.totalReturn) > 0 },
  { id: 'high-roll', icon: '🔥', name: '高波动玩家', desc: '年化波动率超过 50%', check: (p) => Number(p.volatility) >= 0.5 },
];

// 成就面板（localStorage 记录解锁，首次解锁弹通知）
export function AchievementBoard({ perf }: { perf: any }) {
  const addNotification = useUIStore((s) => s.addNotification);

  const results = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const a of ACHIEVEMENTS) map[a.id] = a.check(perf);
    return map;
  }, [perf]);

  useEffect(() => {
    if (!perf) return;
    const saved = JSON.parse(localStorage.getItem('ss.achievements') || '{}');
    const next = { ...saved };
    let fresh = 0;
    for (const a of ACHIEVEMENTS) {
      if (results[a.id] && !saved[a.id]) {
        next[a.id] = true;
        fresh++;
        setTimeout(() => addNotification(`🏅 解锁成就：${a.name}`, 'success'), fresh * 600);
      }
    }
    if (fresh > 0) localStorage.setItem('ss.achievements', JSON.stringify(next));
  }, [results, perf, addNotification]);

  const unlockedCount = ACHIEVEMENTS.filter((a) => results[a.id]).length;

  return (
    <div className="card">
      <h3>🏅 成就 ({unlockedCount}/{ACHIEVEMENTS.length})</h3>
      <div className="achievement-grid">
        {ACHIEVEMENTS.map((a) => {
          const got = results[a.id];
          return (
            <div key={a.id} className={`achievement-item ${got ? 'unlocked' : 'locked'}`} title={a.desc}>
              <span className="achievement-icon">{got ? a.icon : '🔒'}</span>
              <b>{a.name}</b>
              <i>{a.desc}</i>
            </div>
          );
        })}
      </div>
    </div>
  );
}
