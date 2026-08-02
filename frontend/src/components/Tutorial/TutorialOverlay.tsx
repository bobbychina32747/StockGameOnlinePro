import { useUIStore } from '../../store';

// 新手教程：7 步引导气泡（不阻塞操作，右下角提示 + 完成检测）
const TUTORIAL_STEPS = [
  { key: 'welcome', title: '👋 欢迎来到 StockSim Pro', desc: '这是你的模拟交易室：左侧股票列表、中间图表、右侧盘口与交易面板。先逛逛界面。', action: '点击"下一步"开始学习' },
  { key: 'buy', title: '📈 买入第一只股票', desc: '在右侧"下单"面板用市价单买入你感兴趣的股票（建议先买价格适中的）。', action: '完成一次买入' },
  { key: 'timeframe', title: '⏱️ 切换 K 线周期', desc: '图表上方切换周期（1分/5分/60分/日线），不同时间尺度看到不同信号。', action: '切换到 5 分钟周期' },
  { key: 'limit', title: '🎯 限价单', desc: '限价单：设定目标价格，到了才成交，适合低吸高抛。', action: '在下单面板切到限价单' },
  { key: 'mode', title: '🌍 多市场与做空', desc: '右上角切换 A股/港股/美股。港美股支持做空（先卖后买博下跌）。', action: '切换到港股或美股模式' },
  { key: 'tx', title: '📒 交易流水', desc: '顶部导航"流水"页记录每一笔交易，定期回顾是提升的关键。', action: '打开流水页看一眼' },
  { key: 'done', title: '🏆 毕业啦', desc: '你已掌握基本操作。记住三条铁律：控制单笔仓位、永远设止损、警惕异常暴涨（泡沫）。吃一堑长一智！', action: '开始你的交易生涯' },
];

export function TutorialOverlay() {
  const tutorialStep = useUIStore((s) => s.tutorialStep);
  const tutorialDone = useUIStore((s) => s.tutorialDone);
  const skipTutorial = useUIStore((s) => s.skipTutorial);
  const tutorialEvent = useUIStore((s) => s.tutorialEvent);

  if (tutorialDone) return null;
  const step = TUTORIAL_STEPS[Math.min(tutorialStep, TUTORIAL_STEPS.length - 1)];

  const handleNext = () => {
    if (tutorialStep >= TUTORIAL_STEPS.length - 1) {
      skipTutorial(); // 完成
      return;
    }
    // welcome 步骤手动下一步；其他步骤等事件（也允许手动跳）
    tutorialEvent('_manual');
    const done = localStorage.getItem('ss.tutDone') === '1';
    if (!done && step.key === 'welcome') {
      // welcome 手动下一步
      const next = tutorialStep + 1;
      localStorage.setItem('ss.tut', String(next));
      useUIStore.setState({ tutorialStep: next });
    }
  };

  return (
    <div className="tutorial-overlay" onClick={(e) => e.stopPropagation()}>
      <div className="tutorial-bubble">
        <div className="tutorial-title">{step.title}</div>
        <div className="tutorial-desc">{step.desc}</div>
        <div className="tutorial-action">🎯 {step.action}</div>
        <div className="tutorial-btns">
          <span className="tutorial-progress">
            {TUTORIAL_STEPS.map((_, i) => (
              <i key={i} className={i <= tutorialStep ? 'on' : ''} />
            ))}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={skipTutorial}>跳过</button>
          <button className="btn btn-sm btn-primary" onClick={handleNext}>
            {step.key === 'done' ? '🎉 完成' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
