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

// Phase F: rfScore 改为 rfScoreWeighted 的薄封装（等权），签名与语义不变 → 零回归
export function rfScore(features) {
    return rfScoreWeighted(features, null);
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
// Phase F: herdBias —— 自适应羊群偏置（热点时放大/收缩追涨强度），缺省 1 保持原行为
export function strategySignal(strategy, feats, hotFlag = false, herdBias = 1) {
    const ret = feats.ret;
    switch (strategy) {
        case 'trend':
            return clamp(ret * 20, -1, 1);
        case 'meanrev':
            return clamp(-ret * 20, -1, 1);
        case 'momentum':
            return clamp(ret * 30 + (feats.ofi > 0 ? 0.2 : 0), -1, 1);
        case 'herd':
            return hotFlag ? clamp((0.6 + feats.senti * 2) * (Number(herdBias) || 1), -1, 1) : clamp(feats.senti * 2, -1, 1);
        case 'reversal':
            return clamp(-ret * 25, -1, 1);
        case 'noise':
        default:
            return 0;
    }
}

// 最终方向：策略信号 70% + 随机森林 30%；|score| < 阈值 0.12 视为观望（0）
// Phase F: opts = { gain 策略增益(默认1), treeWeights RF 树权重(默认 null=等权), herdBias 羊群偏置(默认1) }；
// rand 可注入确定性 PRNG。noise 分支固定消耗 **1 个**随机数（可复现性：原实现调用两次）
export function decideDirection(strategy, feats, hotFlag, rand = Math.random, opts: any = {}) {
    const gain = Number.isFinite(Number(opts.gain)) ? Number(opts.gain) : 1;
    const s = clamp(strategySignal(strategy, feats, hotFlag, Number(opts.herdBias) || 1) * gain, -1, 1);
    const rf = rfScoreWeighted(feats, opts.treeWeights || null);
    const blended = s * 0.7 + rf * 0.3;
    if (strategy === 'noise') {
        const jitter = (rand() - 0.5) * 0.8;
        return blended + jitter >= 0.12 ? 1 : blended + jitter <= -0.12 ? -1 : 0;
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

// ═══════════════════════════════════════════════════════════════════════════
// Phase F：在线自适应（策略学习）——把"固定参数对手盘"升级为"按自身绩效 + 市场 regime 调参"。
// 团队定稿（Phase F 评审 C1-C16 / R1-R13）四条硬约束：
//  ① 默认值 = 现状（AI_PARAM_DEFAULTS 即 Phase E 前的硬编码值；所有乘数默认 1.0）
//  ② 全部自适应参数带钳制带，输出恒有限、恒在带内
//  ③ 只调"行为倾向"（活跃度/规模/止盈止损/羊群/追热点/挂单预算/信号增益），
//     绝不触碰现金/持仓/挂单预算的账本闸门（服务层硬校验，不参与参数化）
//  ④ 确定性：决策随机数由 (gameDay, tick, agentId, salt) 派生，可逐点重放
// ═══════════════════════════════════════════════════════════════════════════

// 参数钳制带（团队定稿中带宽：activity ±50% / scale ±40%）
export const AI_PARAM_BOUNDS = {
    activityMul: [0.5, 1.5],      // 参与率乘数（× 人设 base activity）
    scaleMul: [0.6, 1.4],         // 单笔规模乘数
    takeProfit: [0.02, 0.10],     // 止盈线（绝对值；下界≈覆盖双边成本，上界=涨跌停）
    stopLoss: [-0.06, -0.015],    // 止损线（绝对值，负）
    herdWeight: [0.3, 1.6],       // 羊群/热点信号权重
    hotBias: [0.0, 0.6],          // 追热点偏置（0 = 现状 50% 概率）
    momentumGain: [0.8, 1.25],    // 策略信号增益
    restBudget: [0.4, 0.7],       // 挂单占用上限（占现金；硬闸门 0.8 不可越）
};

// 默认值 = Phase E 前的现状（零回归基线）
export const AI_PARAM_DEFAULTS = {
    activityMul: 1, scaleMul: 1, takeProfit: 0.05, stopLoss: -0.03,
    herdWeight: 1, hotBias: 0, momentumGain: 1, restBudget: 0.6,
};

export const AI_PERF_WINDOW = 5;    // 绩效反馈窗口（游戏日）
export const AI_RETRAIN_EVERY = 5;  // 自适应（平滑 + 树权重重加权）节奏
export const AI_ETA = 0.34;         // 平滑系数：单日最大步长 = ETA × 钳制带宽
export const AI_TREE_SAMPLE_MIN = 60; // R8：树权重生效门槛（n=20 时标准误≈0.11，噪声过大）
export const AI_ACTIVITY_CAP = 0.95;  // 参与率上限：任何对手盘都不允许"每 tick 必出手"

export const REGIME_LABELS = { bull: '多头市', bear: '空头市', sideways: '震荡市' };
export const VOL_BUCKET_LABELS = { low: '低波动', normal: '常态波动', high: '高波动' };

export function defaultAiParams() {
    return { ...AI_PARAM_DEFAULTS };
}

// 脏数据兜底 + 钳制：任何输入（缺键/NaN/null/空串/越界）都收敛到带内有限值。
// 注意 null/'' 视为"缺失"（回落默认值），而不是 Number(null)=0 被贴下界——JSON 缺字段不得改变人设语义
export function clampParams(p) {
    const out: any = {};
    for (const key of Object.keys(AI_PARAM_BOUNDS)) {
        const [lo, hi] = AI_PARAM_BOUNDS[key];
        const raw = (p || {})[key];
        const v = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
        out[key] = clamp(Number.isFinite(v) ? v : AI_PARAM_DEFAULTS[key], lo, hi);
    }
    return out;
}

// 绩效分 s ∈ [-1,1]（团队 R1/R9 定稿）：窗口收益 ±5% 打满(0.55) + 胜率 50%±25pt(0.15) − 窗口回撤 12% 扣满(0.30)
// 稳态偏置：三项中性输入（ret 0 / 胜率 0.5 / 无回撤）→ s = 0 → 参数保持默认（不漂移）
export function perfScoreOf(marks, winRate) {
    const m = Array.isArray(marks) ? marks : [];
    if (m.length < 3)
        return 0; // 样本不足 → 不调整（保守）
    const a = m[0], b = m[m.length - 1];
    const eqA = Number(a.equity) || 0;
    const retW = eqA > 0 ? (Number(b.equity) - eqA) / eqA : 0;
    let peak = eqA, ddW = 0;
    for (const it of m) {
        const e = Number(it.equity) || 0;
        peak = Math.max(peak, e);
        ddW = Math.max(ddW, peak > 0 ? (peak - e) / peak : 0);
    }
    const wrRaw = Number(winRate);
    const wr = Number.isFinite(wrRaw) ? wrRaw : 0.5;
    return clamp(clamp(retW / 0.05, -1, 1) * 0.55
        + clamp((wr - 0.5) / 0.25, -1, 1) * 0.15
        - clamp(ddW / 0.12, 0, 1) * 0.30, -1, 1);
}

// 绩效分 → 目标参数：单调性钉死为「表现差 → 更保守」（团队 R1 红线）：
// s=-1 → activityMul 0.65 / scaleMul 0.75 / takeProfit 0.0375 / stopLoss -0.021(收紧) / herdWeight 0.70
// s=+1 → activityMul 1.35 / scaleMul 1.25 / takeProfit 0.0625 / stopLoss -0.039(放宽) / herdWeight 1.30
export function applyPerfFeedback(p, s) {
    const base = clampParams(p);
    const k = clamp(Number(s) || 0, -1, 1);
    return clampParams({
        ...base,
        activityMul: 1 + 0.35 * k,
        scaleMul: 1 + 0.25 * k,
        takeProfit: AI_PARAM_DEFAULTS.takeProfit * (1 + 0.25 * k),
        stopLoss: AI_PARAM_DEFAULTS.stopLoss * (1 + 0.30 * k),
        herdWeight: 1 + 0.30 * k,
        // hotBias / momentumGain / restBudget 由 regime 驱动，不由绩效驱动（避免双重顺周期）
    });
}

// 平滑：单日变化 ≤ eta × 带宽（漂移包络可断言）
export function smoothParams(cur, target, eta = AI_ETA) {
    const c = clampParams(cur);
    const t = clampParams(target);
    const e = Number.isFinite(Number(eta)) ? clamp(Number(eta), 0, 1) : AI_ETA;
    const out: any = {};
    for (const key of Object.keys(AI_PARAM_BOUNDS)) {
        out[key] = clamp(c[key] + e * (t[key] - c[key]), AI_PARAM_BOUNDS[key][0], AI_PARAM_BOUNDS[key][1]);
    }
    return out;
}

// 市场状态系数：bull/bear/sideways（复用行情引擎既有 marketRegime，单一来源）+ 波动档（由 aiFeatures 聚合）
export const AI_COEF_BASE = { activityK: 1, scaleK: 1, tpK: 1, slK: 1, herdK: 1, hotK: 1, hotProbCap: 0.9 };
export const AI_COEF_REGIME = {
    bull: { activityK: 1.10, scaleK: 1.10, tpK: 1.15, slK: 1.00, herdK: 1.25, hotK: 1.15 },
    // bear: 收缩参与与规模，但止损只放宽（slK≥1）——高波动期收紧止损会加剧 AI 止损抛售（团队 C8）
    bear: { activityK: 0.85, scaleK: 0.90, tpK: 0.85, slK: 1.15, herdK: 0.80, hotK: 0.85 },
    sideways: AI_COEF_BASE,
};
export const AI_COEF_VOL = {
    low: { activityK: 1.05, scaleK: 1.05, tpK: 1.00, slK: 1.10, herdK: 1.00, hotK: 1.00 },
    normal: AI_COEF_BASE,
    high: { activityK: 0.80, scaleK: 0.80, tpK: 0.90, slK: 1.10, herdK: 0.70, hotK: 0.70, hotProbCap: 0.5 },
};

// 复合规则（团队 C8）：逐项相乘 → 高波动档禁止任何"更激进"系数（activity/scale/tp/herd/hot 一律 ≤1）；
// slK 相反：只放宽或持平（≥1），高波动期不得收紧止损
export function regimeCoef(marketRegime, volBucket) {
    const r = AI_COEF_REGIME[marketRegime] || AI_COEF_BASE;
    const v = AI_COEF_VOL[volBucket] || AI_COEF_BASE;
    const prod = (k) => (Number(r[k]) || 1) * (Number(v[k]) || 1);
    const capHigh = volBucket === 'high';
    const cap = (x) => (capHigh ? Math.min(x, 1) : x);
    return {
        activityK: cap(prod('activityK')),
        scaleK: cap(prod('scaleK')),
        tpK: cap(prod('tpK')),
        herdK: cap(prod('herdK')),
        hotK: cap(prod('hotK')),
        slK: Math.max(1, prod('slK')),
        hotProbCap: Math.min(Number(v.hotProbCap) || 0.9, 0.9),
    };
}

// 生效参数：人设基准 × 自适应参数 × 状态系数，出口再钳制（层数再多也不越界）
export function effectiveParams(agent, p, coef) {
    const c = coef || AI_COEF_BASE;
    const q = clampParams(p);
    return {
        activity: clamp(Number((agent || {}).activity) * q.activityMul * c.activityK, 0, AI_ACTIVITY_CAP),
        scale: Math.max(1, Math.round(Number((agent || {}).scale) * q.scaleMul * c.scaleK)),
        takeProfit: clamp(q.takeProfit * c.tpK, AI_PARAM_BOUNDS.takeProfit[0], AI_PARAM_BOUNDS.takeProfit[1]),
        stopLoss: clamp(q.stopLoss * c.slK, AI_PARAM_BOUNDS.stopLoss[0], AI_PARAM_BOUNDS.stopLoss[1]),
        herdWeight: clamp(q.herdWeight * c.herdK, AI_PARAM_BOUNDS.herdWeight[0], AI_PARAM_BOUNDS.herdWeight[1]),
        gain: clamp(q.momentumGain, AI_PARAM_BOUNDS.momentumGain[0], AI_PARAM_BOUNDS.momentumGain[1]),
        hotProb: clamp(0.5 * (1 + q.hotBias) * c.hotK, 0.2, Number.isFinite(c.hotProbCap) ? c.hotProbCap : 0.9),
        restBudget: clamp(q.restBudget, AI_PARAM_BOUNDS.restBudget[0], AI_PARAM_BOUNDS.restBudget[1]),
    };
}

// 波动档：由当 tick 已有 features 聚合（零额外扫描）；阈值对齐厚尾跳参数（constants OU_PARAMS）
export function volBucketOf(featsList) {
    const list = Array.isArray(featsList) ? featsList : [];
    if (list.length === 0)
        return 'normal';
    let sumAbsRet = 0, sumVol = 0;
    for (const f of list) {
        sumAbsRet += Math.abs(Number(f && f.ret) || 0);
        sumVol += Number(f && f.vol) || 0;
    }
    const absRet = sumAbsRet / list.length;
    const vol = sumVol / list.length;
    if (absRet >= 0.030 || vol >= 0.045)
        return 'high';
    if (absRet <= 0.008 && vol <= 0.020)
        return 'low';
    return 'normal';
}

// 心态档位（对外可见面，团队 C1：只露聚合档位 + 两个乘数，不露裸参数）
export function mindsetOf(activityMul) {
    const v = Number(activityMul);
    if (!Number.isFinite(v))
        return 'normal';
    if (v >= 1.15)
        return 'aggressive';
    if (v <= 0.85)
        return 'cautious';
    return 'normal';
}

// ─── 本地随机森林：带权版（团队 C3/R8）───
// 每棵树的当刻叶值投票；权重为 null 时与 Phase E 的 rfScore **严格相等**（零回归）
export function treeVotes(features) {
    return RF_TREES.map((tree) => {
        const v = Number(features[tree.f]) || 0;
        return v < tree.t ? tree.left : tree.right;
    });
}

export function rfScoreWeighted(features, weights = null) {
    const votes = treeVotes(features);
    if (!weights)
        return clamp(votes.reduce((a, b) => a + b, 0) / votes.length, -1, 1);
    let sw = 0, sv = 0;
    for (let k = 0; k < votes.length; k++) {
        const w = Number(weights[k]);
        const ww = Number.isFinite(w) && w > 0 ? w : 1;
        sw += ww;
        sv += votes[k] * ww;
    }
    return clamp(sw > 0 ? sv / sw : 0, -1, 1);
}

// 树权重重加权：命中率 → 权重带 [0.5,1.5]；样本不足恒 1（禁止小样本噪声驱动）
export function adaptTreeWeights(hit, miss, minSamples = AI_TREE_SAMPLE_MIN) {
    const h = Array.isArray(hit) ? hit : [];
    const m = Array.isArray(miss) ? miss : [];
    const need = Number.isFinite(Number(minSamples)) ? Number(minSamples) : AI_TREE_SAMPLE_MIN;
    return RF_TREES.map((_, k) => {
        const hh = Number(h[k]) || 0, mm = Number(m[k]) || 0;
        if (hh + mm < need)
            return 1;
        return clamp(0.5 + hh / Math.max(1, hh + mm), 0.5, 1.5);
    });
}

// ─── 确定性随机：种子 = (gameDay, tick, agentId, salt) ───
// FNV-1a 32 位散列（含分隔符，防 ("a","bc") 与 ("ab","c") 撞种子）
export function hash32(str) {
    let h = 2166136261 >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

// mulberry32：小巧高质量 PRNG，返回 [0,1)
export function mulberry32(seed) {
    let a = Number(seed) >>> 0;
    return function rand() {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// salt 隔离不同用途：修改某一步骤的调用顺序不会影响其他步骤的随机序列
export function agentRng(gameDay, tick, agentId, salt) {
    return mulberry32(hash32(`${gameDay}|${tick}|${agentId}|${salt}`));
}
