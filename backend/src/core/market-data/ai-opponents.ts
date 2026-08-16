// P4 AI 对手盘（完全本地运行，零外部 API）：
// - 10 个具名对手盘（机构/游资/散户），每人一个可切换的本地规则策略：
//   trend 趋势跟随 / meanrev 均值回归 / momentum 动量 / herd 羊群 / reversal 反转 / noise 噪声
// - 本地随机森林（RF）：8 棵固定决策树桩（特征子集随机、阈值人工调好），
//   对 {日内涨幅, 波动率, OFI, 行业周期, 市场情绪} 打分，融合进各策略信号。
//   无训练依赖、无网络、无 API——纯函数确定性可测。

export const AI_OPPONENT_DEFS = [
    { id: 'AI1', name: '算法一号', type: '机构', strategy: 'trend', activity: 0.25, scale: 25000, cash: 20000000, taunt: '我的趋势线，比你的直觉准。' },
    { id: 'AI2', name: '低波猎手', type: '机构', strategy: 'meanrev', activity: 0.20, scale: 30000, cash: 24000000, taunt: '涨多了我卖，跌多了我买，就这么简单。' },
    { id: 'AI3', name: '动量刺客', type: '游资', strategy: 'momentum', activity: 0.45, scale: 9000, cash: 8000000, taunt: '我只打最热的板块，追得比你快。' },
    { id: 'AI4', name: '龙虎老哥', type: '游资', strategy: 'herd', activity: 0.40, scale: 7000, cash: 7000000, taunt: '大家都在买，你还在犹豫？' },
    { id: 'AI5', name: '反向大师', type: '游资', strategy: 'reversal', activity: 0.35, scale: 6000, cash: 6000000, taunt: '你们追高我出货，你们割肉我接盘。' },
    { id: 'AI6', name: '散户老王', type: '散户', strategy: 'noise', activity: 0.70, scale: 2500, cash: 2000000, taunt: '跟着感觉走，亏了就当交学费。' },
    { id: 'AI7', name: '散户小张', type: '散户', strategy: 'momentum', activity: 0.60, scale: 1800, cash: 1500000, taunt: '涨停敢死队，冲！' },
    { id: 'AI8', name: '散户阿珍', type: '散户', strategy: 'herd', activity: 0.55, scale: 1500, cash: 1300000, taunt: '群里都说要涨，赶紧买！' },
    { id: 'AI9', name: '散户老李', type: '散户', strategy: 'meanrev', activity: 0.50, scale: 1200, cash: 1100000, taunt: '跌了补仓，总会回来的……吧？' },
    { id: 'AI10', name: '散户小美', type: '散户', strategy: 'reversal', activity: 0.45, scale: 900, cash: 900000, taunt: '别人恐惧我贪婪！' },
];

export const STRATEGY_NAMES = {
    trend: '趋势跟随',
    meanrev: '均值回归',
    momentum: '动量',
    herd: '羊群',
    reversal: '反转',
    noise: '噪声',
};

// 行业周期 → 数值特征
export const CYCLE_CODE = { expansion: 0, peak: 1, contraction: 2, trough: 3 };

// ─── 本地随机森林：8 棵决策树桩（axis-aligned，固定阈值与叶值） ───
// 每棵树只用一个特征；森林平均 = 稳健打分。树间方向大体一致（动量共识），
// 部分树做风险修正（高波动/过热/周期收缩时压分），整体输出 [-1,1]。
export const RF_TREES = [
    { f: 'ret', t: 0.010, left: -0.8, right: 0.8 },
    { f: 'ofi', t: 0.200, left: -0.6, right: 0.6 },
    { f: 'senti', t: 0.050, left: -0.5, right: 0.5 },
    { f: 'ret', t: 0.040, left: 0.3, right: -0.3 },
    { f: 'vol', t: 0.050, left: 0.2, right: -0.4 },
    { f: 'cycle', t: 1.5, left: 0.25, right: -0.35 },
    { f: 'ofi', t: -0.300, left: -0.5, right: 0.2 },
    { f: 'ret', t: 0.005, left: -0.4, right: 0.5 },
];

export function rfScore(features) {
    let sum = 0;
    for (const tree of RF_TREES) {
        const v = Number(features[tree.f]) || 0;
        sum += v < tree.t ? tree.left : tree.right;
    }
    return clamp(sum / RF_TREES.length, -1, 1);
}

// 行情特征提取（量级与树阈值匹配）：ret 日内涨幅、vol 波动率、ofi 订单流不平衡、cycle 周期码、senti 市场情绪
export function aiFeatures(stock, ofi, cyclePhase, sentiment) {
    const base = Number(stock.dayOpen) || Number(stock.price) || 1;
    const ret = (Number(stock.price) - base) / base;
    return {
        ret: clamp(ret, -0.1, 0.1),
        vol: Number(stock.volatility) || 0.02,
        ofi: clamp(Number(ofi) || 0, -1, 1),
        cycle: CYCLE_CODE[cyclePhase] ?? 0,
        senti: clamp(Number(sentiment) || 0, -0.2, 0.2),
    };
}

// ─── 本地规则策略：返回方向强度 [-1, 1]，再与 RF 打分融合 ───
export function strategySignal(strategy, feats, hotFlag = false) {
    const ret = feats.ret;
    switch (strategy) {
        case 'trend':
            return clamp(ret * 20, -1, 1);
        case 'meanrev':
            return clamp(-ret * 20, -1, 1);
        case 'momentum':
            return clamp(ret * 30 + (feats.ofi > 0 ? 0.2 : 0), -1, 1);
        case 'herd':
            return hotFlag ? clamp(0.6 + feats.senti * 2, -1, 1) : clamp(feats.senti * 2, -1, 1);
        case 'reversal':
            return clamp(-ret * 25, -1, 1);
        case 'noise':
        default:
            return 0;
    }
}

// 最终方向：策略信号 70% + 随机森林 30%；|score| < 阈值 0.12 视为观望（0）
export function decideDirection(strategy, feats, hotFlag, rand = Math.random) {
    const s = strategySignal(strategy, feats, hotFlag);
    const rf = rfScore(feats);
    const blended = s * 0.7 + rf * 0.3;
    if (strategy === 'noise') {
        return blended + (rand() - 0.5) * 0.8 >= 0.12 ? 1 : blended + (rand() - 0.5) * 0.8 <= -0.12 ? -1 : 0;
    }
    if (blended >= 0.12) return 1;
    if (blended <= -0.12) return -1;
    return 0;
}

// ─── 绩效记账：段位（收益 40% + 胜率 30% + 活跃 30%） ───
export function tierFor(equityReturn, winRate, trades) {
    const score = equityReturn * 40 + winRate * 30 + Math.min(1, trades / 100) * 30;
    if (score >= 85) return { tier: '王者', score };
    if (score >= 70) return { tier: '星耀', score };
    if (score >= 55) return { tier: '钻石', score };
    if (score >= 40) return { tier: '黄金', score };
    if (score >= 25) return { tier: '白银', score };
    return { tier: '青铜', score };
}

// 结算一笔平仓：更新已实现盈亏/胜率/交易数
export function recordAiTrade(ledger, pnl) {
    ledger.trades = (Number(ledger.trades) || 0) + 1;
    ledger.realizedPnl = (Number(ledger.realizedPnl) || 0) + pnl;
    if (pnl >= 0) ledger.wins = (Number(ledger.wins) || 0) + 1;
    else ledger.losses = (Number(ledger.losses) || 0) + 1;
    return ledger;
}

export function winRateOf(ledger) {
    const w = Number(ledger.wins) || 0;
    const l = Number(ledger.losses) || 0;
    return w + l > 0 ? w / (w + l) : 0;
}

export function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}
