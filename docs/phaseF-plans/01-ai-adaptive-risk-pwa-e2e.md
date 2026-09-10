# Phase F 方案 01：AI 对手盘在线自适应 + 风控/PWA/E2E 工程精修

> 方案设计师：AI（Phase F 方案组）｜基线：后端 327 例 / 前端 52 例全绿
> 覆盖：F-1 AI 在线自适应（REALISM #20 收官）/ F-2 风控与性能精修 / F-3 PWA 构建期 precache 收口 / F-4 E2E 冒烟入仓。
> 引用约定：`backend/src/` 与 `frontend/src/` 前缀省略，其余给全路径。所有结论基于源码实读（引用格式 `文件:行号`）。本方案只产出设计文档，不改任何源码/测试。
> 输出物：`docs/phaseF-plans/01-ai-adaptive-risk-pwa-e2e.md`（本文）。

---

> **状态：已交付（2026-09-10）**。本文档是施工前的方案与团队裁决记录，落地结果见 `CHANGELOG.md` 的「Phase F」段：
> 后端 368 例 / 前端 59 例全绿，`orders(status,type)` 索引实测 SCAN→SEARCH（`evidence/orders-status-type-index.txt`），
> PWA 预缓存清单门禁已串进 build（负向样例实测非零退出），E2E 冒烟脚本 `tests/e2e/smoke.mjs` 入仓（可选门禁）。
> 落地时相对本文档的偏差：① 波动档/regime 复用行情引擎既有 `marketRegime`(bull/bear/sideways) + 由当 tick features 聚合的波动档，不再新建 regime 检测；
> ② `AI_PARAM_BOUNDS` 采用「乘数 + 绝对值混合」口径（`activityMul/scaleMul/takeProfit/stopLoss/herdWeight/hotBias/momentumGain/restBudget`）；
> ③ 树权重生效门槛由 20 提到 **60**（R8）；④ 胜率项权重由 0.30 降到 **0.15** 并将差额并入收益项（R9 二选一）；
> ⑤ R7 横截面去均值未实现，按裁决登记 tech-debt + 长跑观察项。

## §0 本 Phase 目标与验收总账

| 块 | 目标 | 验收标准 | 预计新增测试 |
|---|---|---|---|
| F-1 | 10 个具名对手盘保留人设，市场参数按近 5 游戏日自身绩效 + 市场 regime 在线调整（RF 结构冻结、仅树权重重加权），全程零外部依赖、tick 不阻塞 | 20 游戏日长跑无 NaN/无越界；参数漂移有界；账本约束不破；固定种子逐点可复现；`/api/market/ai-opponents` 新增自适应档位字段并前端可见 | 后端 20 例（纯函数 12 + 服务行为 8） |
| F-2 | 风控/性能精修三项 | 无负债账户不再进持仓估值路径（N+1 计数断言）；orders 有 (status,type) 索引（元数据断言）；500 笔流水口径统一到 `sliceRecentAsc` | 后端 9 例 |
| F-3 | 构建期生成 precache manifest，消除发版后离线半白屏窗口 | dist/sw.js 的 CORE_ASSETS 与 dist 实际产物逐项一致（构建即门禁）；版本化缓存名含内容哈希 | 前端 5 例 + 1 构建门禁脚本 |
| F-4 | E2E 冒烟入仓（可选门禁，不被 CI 强依赖） | `node tests/e2e/smoke.mjs` 输出 PASS/FAIL + 截图/JSON 存证；6 条主链路断言语义化 | 非 jest：1 脚本 / 6 链路 |

**红线（不可违反）**：① AI 不得获得超人类信息或无限资源（现金/持仓账本真实约束，`market-data.service.ts:769-774/:785-786` 不得放宽）；② 不引入外部 API/网络依赖；③ 随机必须可种子化、确定性可测；④ 不得改弱资金安全逻辑；⑤ 临时方案当场登记 tech-debt。

**零回归强约束**：所有自适应参数的**默认值 = 当前硬编码值**，所有乘数默认 = 1.0，`decideDirection` 新增参数默认值不改变现有输出 → phase4/phase7/phase9 存量断言逐点不变（这是 F-1 的第一道验收）。

---

## §F-1 AI 对手盘在线自适应（核心）

### F-1.1 参数化现状（实读）

- 人设与固定参数：`core/market-data/ai-opponents.ts:8-19` `AI_OPPONENT_DEFS`——`activity` 0.20~0.70、`scale` 900~30000、`cash` 0.9M~24M；`type ∈ {机构,游资,散户}`；`strategy ∈ {trend,meanrev,momentum,herd,reversal,noise}`（:21-28 名称表）。
- RF 结构：`RF_TREES`（:36-45）8 棵树桩，阈值/叶值人工固定；`rfScore`（:47-54）= 8 树均值，钳 [-1,1]；`aiFeatures`（:57-67）产出 `{ret,vol,ofi,cycle,senti}`。
- 策略信号：`strategySignal`（:70-87）6 个 case，乘数硬编码（trend `ret*20`、meanrev `-ret*20`、momentum `ret*30+ofi加成0.2`、herd `0.6+senti*2`、reversal `-ret*25`、noise 0）。
- 方向融合：`decideDirection`（:90-100）`0.7*策略 + 0.3*RF`，阈值 ±0.12；**noise 分支调 `rand()` 两次**（:95，需改一次调用以保可复现）。
- 行为树硬编码：游资/散户止盈 +5% / 止损 -3%（`market-data.service.ts:757-761`）；机构持仓 > 现金 60% 再平衡卖出（:762-763，**本 Phase 不参数化**，属结构约束非策略偏好）。
- 随机直调 8 处：`market-data.service.ts:727`（activity 门）、`:736`（热点选股，两次 `Math.random`）、`:746`（随机选股）、`:768`（数量 `scale*(0.5+rand)`，即 0.5~1.5 倍 scale）、`:783`（限价/市价路由 0.67）、`:787-789`（挂单偏离按 type）、`:794`（TTL 8~30 tick），加 `decideDirection` 默认 `rand=Math.random`（:751 未传第 4 参）。
- 账本与绩效：`aiLedger`/`aiAgents` 构造初始化 `market-data.service.ts:79-88`（含 `equityHistory: []`）；`markAiEquityDaily`（:848-861，`slice(-60)` :858，由 `endOfDay:1348` 调用）；`getAiOpponents`（:863-896，`tierFor` :877）；`recordAiTrade`（ai-opponents.ts:114-120）、`winRateOf`（:122-126）、`clamp`（:128-130）。
- regime 单一来源：`marketRegime ∈ bull|bear|sideways`（`common/constants/index.ts:178-190`，`STATE_TRANSITIONS` :180-184 / `STATE_PARAMS` :186-190），由 `updateMarketRegime()`（market-data.service.ts:1356-1367）在日终推进（:1352）——**日内不变，日内读取零成本且确定**。

### F-1.2 自适应参数集（字段名 / 默认值 / 钳制带）

新增于 `ai-opponents.ts`（单一来源，所有钳制走既有 `clamp` :128，禁止再写 `Math.max/min` 三连）：

```ts
export const AI_PARAM_BOUNDS = {
  activityMul: [0.5, 1.5],      // 激进度乘数（乘 base activity）
  scaleMul:    [0.6, 1.4],      // 单笔规模乘数
  takeProfit:  [0.02, 0.10],    // 止盈线（游资/散户行为树）
  stopLoss:    [-0.06, -0.015], // 止损线（负值）
  herdWeight:  [0.3, 1.6],      // 羊群/热点权重
  hotBias:     [0.0, 0.6],      // 追热点偏置（热点选中概率加成）
  momentumGain:[0.8, 1.25],     // 策略信号增益（乘在 signal 上）
  restBudget:  [0.4, 0.7],      // 挂单预算比例（现值 0.6）
};
export const AI_PARAM_DEFAULTS = {
  activityMul: 1, scaleMul: 1, takeProfit: 0.05, stopLoss: -0.03,
  herdWeight: 1, hotBias: 0, momentumGain: 1, restBudget: 0.6,
};
export const AI_PERF_WINDOW = 5;   // 绩效反馈窗口（游戏日）
export const AI_RETRAIN_EVERY = 5; // 增量重训节奏
export const AI_ETA = 0.34;        // 平滑系数 → 单日最大步长 = ETA × 钳制带宽
```

| 字段 | 默认 | 下界 | 上界 | 上下界理由（具体） |
|---|---|---|---|---|
| `activityMul` | 1.0 | 0.5 | 1.5 | 生效值再钳 `[0,0.95]`：散户老王 base 0.70×1.5=1.05→截 0.95，避免"每 tick 必出手"退化成刷单机器人；下界 0.5 = 参与率砍半即"收敛激进" |
| `scaleMul` | 1.0 | 0.6 | 1.4 | 机构最大单笔 25000×1.4=35000 股；价格冲击仍走 `applyUserFill`+滑点 2% 上限（`core/trading-engine/slippage.ts:4`），不会凭空造量 |
| `takeProfit` | 0.05 | 0.02 | 0.10 | 下界 0.02 ≈ 覆盖双边手续费+滑点（否则止盈被成本吃掉）；上界 0.10 = 涨跌停幅度，再高等于取消止盈 |
| `stopLoss` | -0.03 | -0.06 | -0.015 | 上界 -0.015 比日内常规波动还小会天天砍仓；下界 -0.06 = 原值 2 倍，符合"宽严"可感知区间 |
| `herdWeight` | 1.0 | 0.3 | 1.6 | 上界 +60% 防单边自激（泡沫破灭已有概率熔断 `market-data.service.ts:590-601`），下界 0.3 保留基础羊群特征 |
| `hotBias` | 0.0 | 0.0 | 0.6 | 生效概率 `clamp(0.5*(1+hotBias),0.2,0.9)`：0 → 0.5（现行为），0.6 → 0.8（追热点），-0.5 侧不开放（不允许完全放弃热点，人设一致性） |
| `momentumGain` | 1.0 | 0.8 | 1.25 | 只微调信号增益，避免全部对手盘信号饱和到 ±1；最终仍钳 [-1,1] |
| `restBudget` | 0.6 | 0.4 | 0.7 | 挂单占用上限；>0.7 会与市价单现金约束（0.8）打架，不得越过红线 |

存储位置：`ledger.params`（**不落在 `aiAgents` 上**）——`aiAgents` 保持"纯人设定义"（`AI_OPPONENT_DEFS` 的浅拷贝 :80），展示层可同时给出 base 与当前生效值。

### F-1.3 绩效反馈公式（近 N 游戏日 → 参数乘数）

日终从 `markAiEquityDaily`（:848-861）取同一份 equity 计算，新增 `ledger.perfMarks`（环形，容量 `AI_PERF_WINDOW+1=6`）：`{day, equity, realizedPnl}`（与 `equityHistory` 同源，避免第二次遍历持仓）。

```ts
// perf.retW  = (mark[-1].equity - mark[-6].equity) / mark[-6].equity     近 5 日自身收益率
// perf.winW  = winRateOf(ledger)                                          复用 :122 终身胜率
// perf.ddW   = 窗口内 max(1 - equity/peak)                                窗口最大回撤
// perf.pnlW  = mark[-1].realizedPnl - mark[-6].realizedPnl                 窗口已实现盈亏
export function perfScoreOf(marks, winRate) {
  if (!marks || marks.length < 3) return 0;                 // 样本不足 → 不调整（保守）
  const a = marks[0], b = marks[marks.length - 1];
  const retW = a.equity > 0 ? (b.equity - a.equity) / a.equity : 0;
  let peak = a.equity, ddW = 0;
  for (const m of marks) { peak = Math.max(peak, m.equity); ddW = Math.max(ddW, peak > 0 ? (peak - m.equity) / peak : 0); }
  return clamp(clamp(retW / 0.05, -1, 1) * 0.5            // 收益：±5% 打满
             + clamp((winRate - 0.5) / 0.25, -1, 1) * 0.3  // 胜率：50%±25pt 打满
             - clamp(ddW / 0.12, 0, 1) * 0.2, -1, 1);       // 回撤：12% 扣满
}
// 目标参数（乘数型字段直接乘、绝对值字段按比例缩放）
export function applyPerfFeedback(p, s) {
  return {
    ...p,
    activityMul: 1 + 0.35 * s,          // s=+1 → 1.35；s=-1 → 0.65
    scaleMul:    1 + 0.25 * s,
    takeProfit:  0.05 * (1 - 0.25 * s), // 表现好 → 抬高止盈（让利润奔跑）
    stopLoss:   -0.03 * (1 - 0.30 * s), // 表现差 → 收窄止损
    herdWeight:  1 - 0.30 * s,          // 表现差 → 降低追热点
    hotBias:     p.hotBias, momentumGain: p.momentumGain, restBudget: p.restBudget, // 由 regime 驱动
  };
}
export function smoothParams(cur, target, eta = AI_ETA) {
  const out = { ...cur };
  for (const k of Object.keys(AI_PARAM_BOUNDS)) out[k] = clamp(cur[k] + eta * (target[k] - cur[k]), ...AI_PARAM_BOUNDS[k]);
  return out;
}
```

**漂移上界（可断言）**：单日单参数变化 ≤ `AI_ETA × (hi - lo)` = 0.34 × 带宽（如 activityMul ≤ 0.34、stopLoss ≤ 0.0153），20 游戏日最坏累计 ≤ 1.0×带宽（因终点恒在带内）。

### F-1.4 市场 regime 系数（整体系数切换）

```ts
export const AI_COEF_BASE = { activityK: 1, scaleK: 1, tpK: 1, slK: 1, herdK: 1, hotK: 1 };
export const AI_COEF_REGIME = {   // 复用 marketRegime（constants/index.ts:180-190）
  bull:     { activityK: 1.10, scaleK: 1.10, tpK: 1.15, slK: 1.00, herdK: 1.25, hotK: 1.15 },
  bear:     { activityK: 0.85, scaleK: 0.90, tpK: 0.85, slK: 0.75, herdK: 0.80, hotK: 0.85 },
  sideways: AI_COEF_BASE,
};
export const AI_COEF_VOL = {      // 五档波动率 regime，由 aiFeatures 输出聚合而来
  low:    { activityK: 1.05, scaleK: 1.05, tpK: 1.00, slK: 1.10, herdK: 1.00, hotK: 1.00 },
  normal: AI_COEF_BASE,
  high:   { activityK: 0.80, scaleK: 0.80, tpK: 0.90, slK: 0.90, herdK: 0.70, hotK: 0.70 },
};
// 波动档判定（用本 tick 已有的 features Map，零额外遍历）：
//   avgAbsRet = mean(|feats.ret|)，avgVol = mean(feats.vol)
//   high: avgAbsRet ≥ 0.030 或 avgVol ≥ 0.045   （≈全市场均值接近 1/3 涨停幅度，对应厚尾跳 5%/crashIntensity 0.0015，constants:196-203）
//   low : avgAbsRet ≤ 0.008 且 avgVol ≤ 0.020
export function effectiveParams(agent, p, coef) {
  return {
    activity: clamp(agent.activity * p.activityMul * coef.activityK, 0, 0.95),
    scale: Math.max(1, Math.round(agent.scale * p.scaleMul * coef.scaleK)),
    takeProfit: clamp(p.takeProfit * coef.tpK, ...AI_PARAM_BOUNDS.takeProfit),
    stopLoss: clamp(p.stopLoss * coef.slK, ...AI_PARAM_BOUNDS.stopLoss),
    herdWeight: clamp(p.herdWeight * coef.herdK, ...AI_PARAM_BOUNDS.herdWeight),
    hotProb: clamp(0.5 * (1 + p.hotBias) * coef.hotK, 0.2, 0.9),
    gain: clamp(p.momentumGain, ...AI_PARAM_BOUNDS.momentumGain),
    restBudget: clamp(p.restBudget, ...AI_PARAM_BOUNDS.restBudget),
  };
}
```

regime 只在**日终**切换（`updateMarketRegime` :1356 由 `endOfDay` :1352 调用），波动档每 tick 从 features 聚合但只影响系数 → 无逐 tick 状态漂移。

### F-1.5 重训节奏与成本

三选一，**推荐路径 A**：

| 路径 | 做法 | 成本/风险 |
|---|---|---|
| **A（推荐）** | 每 `AI_RETRAIN_EVERY=5` 游戏日、在日终 `markAiEquityDaily` 内做一次 O(10 agents × 8 trees) 的**树权重重加权**（树结构/阈值/叶值**冻结**）+ 参数平滑更新 | 10×8=80 次算术/日；`rfScore` 零回归（权重全 1 时严格等于现值）；无前视：权重只吃"决策当刻"的一致性统计 |
| B | 只做参数自适应，不动 RF | 成本最低，但"在线学习"叙事弱（roadmap 要求的"增量重训"缺位） |
| C | 全量重训（重搜阈值/叶值） | **不推荐**：合成市场无真标签，易过拟合噪声；不确定性最高，直接冲撞"确定性可测"红线 |

树权重重加权（无前视、零额外数据采集）：决策执行后立即累计一致性

```ts
// 在 applyAiTrading 决定 dir 之后（8 次比较，零 IO）
const votes = treeVotes(feats);                 // number[8]：每棵树当刻叶值
for (let k = 0; k < votes.length; k++)
  (Math.sign(votes[k]) === dir ? ledger.treeHit : ledger.treeMiss)[k] += 1;
// 重训时（样本 ≥ 20 才生效，否则保持 1）
ledger.treeWeights = ledger.treeHit.map((h, k) =>
  clamp(0.5 + h / Math.max(1, h + ledger.treeMiss[k]), 0.5, 1.5));
// rfScore 改造为带权版，默认权重全 1 → 与现值严格相等
export function rfScoreWeighted(features, weights = null) {
  const votes = treeVotes(features);
  if (!weights) return clamp(votes.reduce((a, b) => a + b, 0) / votes.length, -1, 1);
  let sw = 0, sv = 0;
  for (let k = 0; k < votes.length; k++) { const w = weights[k] ?? 1; sw += w; sv += votes[k] * w; }
  return clamp(sw > 0 ? sv / sw : 0, -1, 1);
}
export function rfScore(features) { return rfScoreWeighted(features, null); } // 签名与语义不变
```

**数据落内存缓存（结论：不落库）**，理由：① AI 绩效/参数是演示生态状态，零玩家资产语义（不印钱、不入账户）；② 现 `aiLedger` 全内存（:79-88），落库需新建表 + 迁移 + 快照口径裁决，成本远超收益；③ 重启复位 = 可预期的"新赛季"语义，同时**消除"跨重启参数漂移不可复现"这一确定性风险**（F-1 验收最看重这点）；④ tech-debt 登记：触发条件 = "AI 成长档案/跨重启延续"成为玩家可见需求（Phase G 之后）。

tick 不阻塞：重训在日终一次性执行（`endOfDay` 已是重计算窗口，`market-data.service.ts:1237-1355`），不新增定时器；`applyAiTrading` 内只做 O(1) 计数。新增日志禁止逐 tick 输出（仅日终一条 `debug`）。

### F-1.6 确定性与可测性

**种子方案（替换 8 处 `Math.random` 直调）**：

```ts
export function hash32(str) { let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
// 从 gameDay+ tick + agentId + salt 派生确定性 RNG（mulberry32），salt 隔离不同用途
export function agentRng(gameDay, tick, agentId, salt) {
  let a = hash32(`${gameDay}|${tick}|${agentId}|${salt}`);
  return () => { a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
```

| 原 `Math.random` 位置 | 替换 salt | 说明 |
|---|---|---|
| `market-data.service.ts:727` activity 门 | `'act'` | 参与率判定 |
| `:736` 热点选股（两处调用） | `'pick'` | 同一 rng 顺序调用 |
| `:746` 随机选股 | `'pick'` | 同上，同 salt 可复现选择序列 |
| `:768` 数量抖动 | `'qty'` | `Math.round(eff.scale * (0.5 + rng()))` |
| `:783` 限价/市价路由 | `'route'` | 阈值 0.67 不变 |
| `:787-789` 挂单偏离 | `'offset'` | 按 type 分支不变 |
| `:794` TTL | `'ttl'` | 8 + floor(rng()*22) |
| `decideDirection` :751 默认 rand | `'dir'` | **复用已有第 4 参签名**（ai-opponents.ts:90 已支持注入），零 API 改动 |
| noise 分支双 `rand()`（:95） | `'dir'` | 改为**一次**调用 `const jitter=(rng()-0.5)*0.8;`（可复现性修复） |

调用形态：

```ts
const p = ledger.params, coef = regimeCoef(this.marketRegime, volBucket);
const eff = effectiveParams(agent, p, coef);
if (agentRng(this.gameDay, this.tickCount, agent.id, 'act')() > eff.activity) continue;
// …选股/下单各步骤各自取 salt 独立的 rng（不同 salt 互不干扰 → 修改调用顺序不改变其他决策）
const dir = decideDirection(agent.strategy, feats, hotFlag,
  agentRng(this.gameDay, this.tickCount, agent.id, 'dir'), eff.gain, ledger.treeWeights);
```

**作用域声明**：F-1 只保证 **AI 决策路径** 可种子化；行情生成/新闻/黑天鹅仍用 `Math.random`（全链种子化范围爆炸，列不做清单）。因此服务层验收采用"固定 feats + 固定 rng 注入 + fake engine 的逐点断言"与"20 日长跑的不变量断言"两层，不做全链数值复现。建议加环境开关 `AI_ADAPTIVE_ENABLED`（默认 `true`，测试/回滚可 `false` → 走 `AI_PARAM_DEFAULTS` 与 `Math.random` 旧路径），作为可回滚手段。

**phase12 行为断言清单**（新文件 `backend/test/phase12-ai-adaptive.test.js`，纯 jest + 手写 fake repo，复用 `phase4-ai-opponents.test.js:78-91 makeService()` 的构造方式与 `phase10-tier.test.js:72-99 countingRepo` 的 fake 风格）：

1. **参数漂移有界**：10 agents × 20 游戏日，每参数恒在 `AI_PARAM_BOUNDS` 内，且相邻两日 `|Δ| ≤ AI_ETA × 带宽`。
2. **无 NaN/Infinity**：`params`、`equityHistory[].equity`、`perfMarks`、`pnlPct`、`winRate`、`tierFor().score` 全部有限。
3. **账本约束不破**（红线）：任意 tick 后 `ledger.cash ≥ 0`、`positions.qty ≥ 0`、`restingValue ≤ cash × restBudget + ε`；买入量恒 ≤ `floor(cash*0.8/price)`。
4. **超人类信息红线**：把测试股票的 `intrinsic`/`nextReportDay` 改成极端值后，固定种子下的决策序列不变（证明输入仅来自 `aiFeatures` 的 5 个键）。
5. **绩效单调性（宽松）**：`perfScoreOf` 输入从 "-1 → +1" 递增时 `applyPerfFeedback().activityMul` 与 `scaleMul` 单调不减、`stopLoss` 绝对值单调不减；反向输入反向单调。
6. **RF 零回归**：`rfScoreWeighted(feats, null) === rfScore(feats)`（严格相等）；`treeVotes` 权重全 1 时 `rfScoreWeighted(feats,[1×8]) === rfScore(feats)`。
7. **树权重重加权节奏**：样本 < 20 时权重恒为 1；`AI_RETRAIN_EVERY` 内仅日终触发（调用计数 = 游戏日数/5）。
8. **确定性**：同种子跑 20 日两次 → `equityHistory`/`params`/`trades` 快照深等；换一个 gameDay 起点 → 至少一项不同（防"种子没生效"的假绿）。
9. **复位语义**：`resetAiAdaptation()` 后参数等于 `AI_PARAM_DEFAULTS`、`perfMarks=[]`、`treeWeights=[1×8]`。
10. **noise 单次随机**：`decideDirection('noise', feats, false, seqRng)` 对同一 rng 序列只消耗 1 个随机数（用计数 rng 断言）。

### F-1.7 对外可见面（推荐：加字段 + 前端最小展示）

**推荐：`GET /api/market/ai-opponents` 新增聚合字段（不暴露裸参数数值）**

```ts
// market-data.service.ts getAiOpponents() 返回体新增（:878-893 追加）
adaptive: {
  regime: this.marketRegime,                       // 'bull'|'bear'|'sideways'
  vol: volBucket,                                  // 'low'|'normal'|'high'
  level: activityMul >= 1.15 ? 'aggressive' : activityMul <= 0.85 ? 'cautious' : 'normal',
  activityMul: Number(effective.activityMul.toFixed(2)),  // 0.50~1.50
  scaleMul: Number(effective.scaleMul.toFixed(2)),        // 0.60~1.40
}
```

理由：① roadmap F-1 要求"在线自适应"这一真实感收益对玩家可见，否则等于零收益；② 前端改动面极小——`components/Trading/AIAssistant.tsx:126-136` 每行已渲染 `o.name / o.strategyName / o.pnlPct / o.tier`，追加一个 `o.adaptive?.level` 中文标签（三档映射）即可，复用现有 20s 轮询（:26）与列表渲染，零新请求；③ 只给**聚合档位 + 两个乘数**，不给 `takeProfit/stopLoss` 裸值——避免玩家反推参数套利（与"AI 不得获得超人类信息"对称：玩家也不该拿到 AI 的完整策略表）；④ 文档同步：`docs/API.md:164` 补字段说明 + `backend/test/phase10-api-doc-routes.test.js:28-35` 的 `MUST_HAVE_SEMANTIC` 加 `'adaptive'`（复用既有防腐烂机制，零新机制）。

### F-1.8 复用清单（尽量零重复实现）

| 复用对象 | 位置 | 用法 |
|---|---|---|
| `clamp` | ai-opponents.ts:128 | 所有钳制（含参数带、权重带、概率带） |
| `winRateOf` / `recordAiTrade` | :122 / :114 | 绩效反馈直接读账本，禁止重算胜率 |
| `tierFor` | :103 | 段位展示不改口径（与 risk-manager 的 `tier.ts` 是两套语义，本 Phase 不合并） |
| `rfScore` | :47 | 重构为 `rfScoreWeighted` 的薄封装，签名/语义不变 |
| `strategySignal` | :70 | 6 个 case 硬编码**不动**，增益在 `decideDirection` 内乘（默认 1.0） |
| `aiFeatures` | :57 | regime 的波动档由它的输出聚合，不重扫 stocks |
| `markAiEquityDaily` | market-data.service.ts:848 | 自适应唯一日终入口（已被 `endOfDay:1348` 调用），不新增调度器 |
| `getAiOpponents` | :863 | 只追加字段，排序/口径（pnlPct 降序）不动 |
| `updateMarketRegime` / `marketRegime` | :1356 / constants:178-190 | regime 单一来源，不自建检测 |
| `decideDirection` 第 4 参 `rand` | ai-opponents.ts:90 | 种子注入零 API 改动 |
| `makeService()` / `countingRepo` | phase4:78-91 / phase10-tier:72-99 | phase12 直接沿用同款 fake 构造 |
| `applyUserFill` / 现金约束 :769-774 / 挂单预算 :785-786 | market-data.service.ts | **原样保留**（红线：不得放宽） |

### F-1.9 改动清单（文件 : 函数 : 改什么 : 为什么）

| # | 文件 : 函数 | 改什么 | 为什么 |
|---|---|---|---|
| 1-1 | `core/market-data/ai-opponents.ts` : 新增常量与纯函数段（`AI_PARAM_BOUNDS`/`AI_PARAM_DEFAULTS`/`AI_PERF_WINDOW`/`AI_RETRAIN_EVERY`/`AI_ETA`/`defaultAiParams`/`clampParams`/`perfScoreOf`/`applyPerfFeedback`/`smoothParams`/`regimeCoef`/`effectiveParams`/`hash32`/`agentRng`/`treeVotes`/`rfScoreWeighted`/`adaptTreeWeights`） | 新增；`rfScore`（:47-54）改为薄封装；`decideDirection`（:90）加第 5/6 参 `gain=1, treeWeights=null`，噪声分支改单次 `rand()` | 单一来源纯函数，默认值=现状 ⇒ 零回归 |
| 1-2 | `core/market-data/market-data.service.ts` : 构造函数 :79-88 | `aiLedger.push` 增加 `params: defaultAiParams(), perfMarks: [], treeHit: [0×8], treeMiss: [0×8], treeWeights: null` | 自适应状态与账本同生命周期（内存） |
| 1-3 | 同上 : `applyAiTrading` :704-846 | 8 处 `Math.random` → `agentRng(...)`（salt 见表）；`:751` 传入 dir-rng/gain/treeWeights；`:757-761` 用 `eff.takeProfit/stopLoss`；`:768` 用 `eff.scale`；`:785` 用 `eff.restBudget`；`:736` 用 `eff.hotProb`；决策后累计 `treeHit/treeMiss` | 确定性 + 自适应生效；现金/持仓约束行不动 |
| 1-4 | 同上 : `markAiEquityDaily` :848-861 | push 快照后写 `perfMarks`（容量 6）；`day % AI_RETRAIN_EVERY === 0 && marks.length ≥ 3` 时执行 `smoothParams(applyPerfFeedback(...))` + 树权重重加权（样本 ≥ 20），末尾一条 `debug` 日志 | 重训节奏（每 5 游戏日）+ tick 不阻塞 |
| 1-5 | 同上 : `getAiOpponents` :863-896 | 返回体追加 `adaptive`（见 F-1.7） | 玩家可见面 |
| 1-6 | `frontend/src/components/Trading/AIAssistant.tsx` :126-136 | 每行追加自适应档位标签（`aggressive→⚡激进 / normal→➖稳健 / cautious→🛡谨慎`，缺失字段不渲染） | 复用现有渲染与 20s 轮询 |
| 1-7 | `docs/API.md:164` + `backend/test/phase10-api-doc-routes.test.js:28-35` | 补 `adaptive` 字段说明 + `MUST_HAVE_SEMANTIC` 加 `'adaptive'` | 文档与实现同步防腐烂 |
| 1-8 | `backend/test/phase12-ai-adaptive.test.js`（新建） | 20 例（F-1.6 清单） | 行为兜底 |

---

## §F-2 风控/性能精修（剩余项）

> 说明：`forceLiquidate` / `forceLiquidateToTarget` / `checkPendingOrders` 实体位于 `core/trading-engine/trading-engine.service.ts`（**不是** risk-manager），risk-manager 只提供 `tier.ts` / `perf.ts` 纯函数。

1. **负债过滤 + 批量持仓**（`trading-engine.service.ts:1340-1367 forceLiquidateMarginalAccounts`）：现 `accountRepo.find()`（:1341）全表 → 逐账户 `checkMarginLevel`（:1349）内部 `positionRepo.find({accountId})`（:1116）= N+1。改法：`accountRepo.find({ where: [{ borrowed: MoreThan(0) }, { shortCollateral: MoreThan(0) }] })` 预过滤（`MoreThan` 与已有 `In`（:620）同源 import）+ 一次 `positionRepo.find({ where: { accountId: In(ids) } })` 批量预载，`checkMarginLevel(account, prices, preloadedPositions?)` 新增第 3 参（缺省 undefined 走原查询 → 存量调用零影响，复用 risk-manager `getPositionsValue(account, preloaded)` :217 的双参先例）；对**遗留空头**（`shortQty>0` 但 `shortCollateral=0`）保留一次 `positionRepo.find({ where: { shortQty: MoreThan(0) } })` 体检并入候选集（安全网），是否砍掉该体检 = 裁决点。
2. **N+1 计数断言写法**（沿用 `phase10-tier.test.js:72-99 countingRepo`）：3 账户（AC1 零负债零持仓 / AC2 有短期持仓 / AC3 有 `borrowed`），断言 `positionRepo.calls.find === 1`、其 `where.accountId._type === 'in'`、且**不存在** `where.accountId === 'AC1'` 的按账户查询记录；`accountRepo.calls.lastFindWhere` 为数组且元素 `_type === 'moreThan'`（FindOperator 序列化约定与 phase10 的 `_type === 'in'` 一致）。
3. **(status,type) 复合索引**（`infrastructure/database/entities/order.entity.ts:131-138`）：底部装饰块追加 `(0, typeorm_1.Index)(['status','type'])`（与既有 `(['accountId','status'])` :135 并列；synchronize 首启自动建索引）。理由：`checkPendingOrders` 的 where（trading-engine.service.ts:601-607）三分支均为 `status+type+postClose=false`，(status,type) 左前缀全覆盖；`postClose` 选择性极低不入索引（是否纳入 = 可议）。元数据断言：`idxOf(Order, ['status','type'])` 为真且 `idxOf(Order, ['accountId','status'])` 仍为真（防误删），`idxOf` 复用 phase10 的 6 行本地 helper（建议提到 `backend/test/helpers/typeorm-meta.js` 后两文件共用）。量变触发证据（roadmap:31）：一次性执行 `EXPLAIN QUERY PLAN SELECT * FROM orders WHERE status='pending' AND type='limit' AND postClose=0` + `COUNT(*)`，输出落 `docs/phaseF-plans/evidence/`。
4. **`sliceRecentAsc` 统一 500 笔口径**（`core/risk-manager/perf.ts`，新建导出）：`export const RECENT_TX_WINDOW = 500; export function sliceRecentAsc(txs, n = RECENT_TX_WINDOW) { const a = Array.isArray(txs) ? txs : []; return a.length > n ? a.slice(-n) : a; }`。调用点两处且**口径当前不一致**：(a) `risk-manager.service.ts:192` 内联三元 → 改调用（行为不变）；(b) `modules/account/account.service.ts:107-111` 现用 `order ASC + take: 500` = **最旧** 500 笔（与日终段位"最近 500 笔"相反）→ 改为全量 ASC 拉取后 `sliceRecentAsc(rows)`（单账户流水量级可接受；若需保 LIMIT，则 `DESC+take(500)+reverse()` 语义等价，二选一 = 可议）。不动 `risk-manager.service.ts:59-60`（365 天）与 `market-data.service.ts:858`（60 天）——按天不按流水，语义不同。
5. **回归方式**：F-2 新增 9 例（负债过滤/N+1 计数 4 + 索引元数据 2 + `sliceRecentAsc` 边界与 metrics 口径 3）；先跑 `npm test -- --runInBand` 对比 327 例是否仍绿（`account.service.getMetrics` 的 SQL 形态变化是本块唯一存量涟漪风险）。

---

## §F-3 PWA 构建期 precache manifest

1. **现状实证**：`frontend/public/sw.js:15-21` `CORE_ASSETS` 仅 5 项（`/`、`/index.html`、manifest、2 icons）——**不含 Vite hash 产物**；实测 `frontend/dist/assets` 三件共 1,455,704 B（`echarts-B6oUQ_nH.js` 1,060,163 / `index-Prl3XKkl.js` 364,182 / `index-85KbUKlW.css` 31,359）。sw.js:52-65 导航 network-first 回退预缓存 `index.html`，:68-82 静态资源 stale-while-revalidate ⇒ 发版后新 hash 资产未被访问过时离线导航 = 壳在、入口 JS 缺 → **半白屏窗口**。
2. **候选 A（推荐）**：build 后改写 sw.js 常量清单。新增 `frontend/scripts/build-sw.mjs`（零依赖，Node crypto）在 `vite build` 之后执行：读 `dist/assets/**`（构建产物真源）+ 图标/manifest → 替换 `public/sw.js` 模板中的占位块 `/* __PRECACHE_ASSETS__ */` → 产出 `dist/sw.js`；`dist/index.html` 引用的 `/assets/*` 必须全部在清单内。代价：`frontend/package.json:9` build 脚本多一步；源模板与产物两态需注释说明 + 测试防漂移。
3. **候选 B**：最小 vite 插件注入。`vite.config.ts`（现 37 行）内联 ~40 行插件，用 `generateBundle` 的文件名列表 + `emitFile({type:'asset',fileName:'sw.js'})` 产出。代价：配置承担构建逻辑；`emitFile` 的 sw.js 与 `public/sw.js` 同名冲突 → 必须把模板搬到 `src/pwa/sw.template.js`，直接打断 `offline-assets.test.ts:32` 的 `read('public/sw.js')` 断言（需同批改 52 例中的相关用例）。⇒ **推荐 A**（改动面最小、零插件 API 依赖、测试可读，B 的唯一优势"清单来自 bundle 真源"用 dist 目录扫描等价获得）。
4. **版本化缓存失效**：`VERSION = ${pkg.version}+${sha256(全部预缓存文件内容).slice(0,8)}`——同内容同版本、改内容必换缓存名，配合既有 `activate` 清理（sw.js:34-40）天然失效；`install` 用 `addAll`（:28）保证壳与资产原子性（任一失败则 install 失败，不自相矛盾）。
5. **一致性断言（离线壳不得半白屏）**：新增 `frontend/src/pwa/precache-manifest.test.ts`——**若 `frontend/dist` 不存在则 `describe.skip`**（CLAUDE 约束：jest 在 vite build 之前跑，CHANGELOG Phase D 已记录），断言：dist/index.html 每个 `/assets/*` ∈ dist/sw.js `CORE_ASSETS`；`CORE_ASSETS` 每项在 dist 中 `existsSync`；`VERSION` 含 8 位内容哈希；清单总量 ≤ 阈值（现全量 1.42MB，建议上限 3MB；是否把 1.06MB 的 echarts 入壳 = 裁决点）。更硬的门禁：`node frontend/scripts/check-sw-manifest.mjs` 失败即 `exit 1`，串进 build（`tsc -b && vite build && node scripts/build-sw.mjs && node scripts/check-sw-manifest.mjs`）→ CI 无需额外步骤。
6. **发版错配窗口（第二条路径）**：navigate 的 network-first（:52-66）在网络恢复瞬间可能拉到新版 index.html 而资产未缓存。补法二选一：① 在 navigate 内解析新 index.html 的 `/assets` 列表并 `cache.addAll(...).catch(noop)` 预热（best-effort，不阻塞响应）；② navigate 改 cache-first（壳自洽，代价=发版可见延迟一次导航）。二选一 = 裁决点。

---

## §F-4 E2E 冒烟入仓

1. **脚本位置**：`tests/e2e/smoke.mjs`（仓库根 `tests/e2e/` 目录已存在且为空）；产物落 `tests/e2e/artifacts/<runId>/`（runId = `YYYYMMDD-HHmmss`）：每链路 `NN-<name>.png` 截图 + `result.json`（步骤名/状态/耗时/断言值，**不含密码等敏感值**）+ `server.log`。
2. **驱动**：本机 playwright-cli（`D:\npm-global\playwright-cli.cmd`，配置 `C:\Users\lenovo\.dsh\scripts\playwright-cli.json`：Thorium executablePath + headless + persistent profile）。脚本用 `child_process.spawnSync(cli, args, { stdio: ['ignore', fdOut, fdErr] })`——**必须用文件描述符重定向，禁止默认管道**（沙箱下管道捕获输出会 EPERM，见 `~/.dsh/AGENTS.md` run-to-file 规则）；`--config` 只在 `open` 生效，其余命令 cwd 须为 `C:\Users\lenovo\.dsh\scripts` 且恒带 `-s=<会话名>`。
3. **起服务**：后端 `SANDBOX_FAST=true` + `TICK_INTERVAL_MS=1000` + **临时库** `SQLITE_PATH=./data/phaseF-smoke.db`（`node backend/dist/src/main.js`），轮询 `GET http://localhost:8000/api/market/prices` 就绪（复用 `start.bat` 的 netstat+curl 判定逻辑，Node 内实现）；前端为覆盖生产壳走 `npm run preview -- --port 3000`，需在 `vite.config.ts` 增 `preview: { port: 3000, proxy: <与 server.proxy 同款 /api + /socket.io> }`（现仅 `server.proxy` :12-23）。**红线**：不得触碰真实 `backend/data/stockgame.db`；退出时只删临时库文件。
4. **主链路（6 条，断言锚点已实读）**：① 登录（注册若重名走"200+success:false → 转登录"，Phase E 语义）→ 断言进入主界面；② 下单（选股→数量→买入）→ 断言提示文案 + `GET /api/trading/orders/pending` 含该单；③ 撤单 → 断言挂单列表消失且 pending 为空；④ 排行（`/ranking`）→ 断言表格行数 > 0 与赛季/全服切换存在；⑤ 赛季报名 → 断言状态文案 ∈ 白名单（`ENROLLING` 缺失时 skip 并记录，避免周赛日历依赖）；⑥ 断线横幅 → `eval "window.__wsSocket.disconnect()"`（`services/ws.client.ts:22` 已挂 `window.__wsSocket`）→ 等 ≤6s（`Dashboard.tsx:66-84` 5s 轮询）断言 `.ws-offline-tip` 出现且文案含"断开"（:176-178）→ `eval "window.__wsSocket.connect()"` → 断言横幅消失。
5. **门禁接入（可选，不被 CI 强依赖）**：`frontend/package.json` 或根级脚本加 `"smoke:e2e": "node tests/e2e/smoke.mjs"`，**不**串入 `npm test`；CI/本地按需手动触发，失败仅产出 artifacts 与退出码，不阻断 build/test 通道（PWA manifest 的构建期校验才进 build 门禁）。
6. **沙箱约束**：所有外部命令输出 `cmd /c "... > <file> 2>&1"` 落盘再读（PS 的 `>`=`UTF-16LE` 会污染日志）；ps1 脚本若含中文必须转 UTF-8 with BOM；`tests/e2e/**/artifacts/` 入 `.gitignore` 或仅提交 `result.json` 摘要（二选一 = 可议）。

---

## §团队裁决点（teams 议题，均未定稿）

| # | 分歧（利益冲突双方） | 选项 A | 选项 B/C |
|---|---|---|---|
| 1 | **自适应对玩家可见性**（产品/真实感 vs 风控/反套利） | A：只露聚合档位 + `activityMul/scaleMul`（本方案推荐；代价=信息量有限，玩家可能"看不懂"档位） | B：完整暴露 `takeProfit/stopLoss` 等全部参数（代价=玩家可反推策略套利、且与"AI 不得有超人类信息"的对称性被打破）；C：完全不露（代价=自适应真实感收益归零，REALISM #20 白做） |
| 2 | **状态存储：内存 vs 落库**（确定性/成本 vs 跨重启延续） | A：纯内存、重启复位（推荐；代价=AI"记忆"每次重启清空，长跑叙事弱） | B：落库持久化参数与绩效（代价=新建表 + 迁移 + 跨重启参数不可复现，直接加重 F-1 确定性验收负担） |
| 3 | **重训节奏与深度**（真实感 vs 确定性与成本） | A：每 5 游戏日"参数平滑 + RF 树权重重加权"、树结构冻结（推荐；代价=学习表征能力有限，玩家可能感知不到差异） | B：只做参数自适应、不动 RF（代价=ROADMAP"增量重训"缺位）；C：全量重训阈值/叶值（代价=易过拟合噪声、确定性风险最高） |
| 4 | **参数钳制带宽**（真实感 vs 行情稳定性） | A：中带（activity ±50% / scale ±40%，推荐；代价=极端行情下对手盘"性格"变化幅度有限） | B：窄带（±20%：代价=自适应接近装饰、玩家无感）；C：宽带（±100%：代价=AI 行为扰动大，可能冲击已有行情/风控假设与 phase4/7/9 隐含基线） |
| 5 | **发布门禁强度 + 离线壳边界**（交付节奏/运维 vs 质量） | A：E2E 仅可选脚本 + 只有 PWA manifest 进 build 门禁（推荐；代价=E2E 回归靠自觉，可能"长期不跑"） | B：E2E 入门禁（代价=浏览器/端口/临时库环境依赖，CI 易假红，交付节奏被拖）；C：壳跳过 >2MB 单文件（echarts 1.06MB 不入壳，代价=离线打开图表页缺块） |

---

## §提交切块与验证命令

| 切块 | 内容 | 验证命令（PowerShell，输出落盘再读） |
|---|---|---|
| F-1a | `ai-opponents.ts` 常量 + 全部纯函数（不接线） | `cmd /c "cd /d E:\Files\Games\stockGameOnlinePro\backend && npm run build && npm test -- --runInBand > E:\Files\Games\stockGameOnlinePro\tests\e2e\artifacts\f1a.log 2>&1"` |
| F-1b | `market-data.service.ts` 接线（rng 替换 + effectiveParams + 日终反馈 + ledger 字段） | 同上 → `f1b.log`（重点：phase4/7/9 是否仍绿） |
| F-1c | `getAiOpponents` 字段 + 前端标签 + API.md + 路由语义断言 | `cmd /c "cd /d E:\Files\Games\stockGameOnlinePro\backend && npm test -- --runInBand > ...\f1c-backend.log 2>&1"` + `cmd /c "cd /d ...\frontend && npx tsc -b && npm test > ...\f1c-frontend.log 2>&1"` |
| F-2 | 负债过滤 + 批量持仓 + (status,type) 索引 + `sliceRecentAsc` 统一 | 后端 build + test → `f2.log` |
| F-3 | `scripts/build-sw.mjs` + `check-sw-manifest.mjs` + `vite.config.ts` preview 代理 + dist 断言 | `cmd /c "cd /d ...\frontend && npm run build > ...\f3.log 2>&1 && npm test >> ...\f3.log 2>&1"` |
| F-4 | `tests/e2e/smoke.mjs` + artifacts 规范 + 文档一行 | `cmd /c "cd /d E:\Files\Games\stockGameOnlinePro && node tests\e2e\smoke.mjs > tests\e2e\artifacts\smoke-console.log 2>&1"` |
| 收尾 | CHANGELOG Unreleased + tech-debt 登记（AI 参数不落库 / 空头体检查询 / 流水窗口 SQL 化 / E2E 未入门禁）+ README 测试数 | 全量验收清单 |

**全量验收清单**：① 后端 `npm run build` + 327+29≈356 例全绿；② 前端 `npx tsc -b` + `npm run build` + 52+5=57 例全绿（含 dist 断言非 skip）；③ `SANDBOX_FAST=true` + 临时库启动冒烟（`GET /api/market/prices` 200，且 `/api/market/ai-opponents` 返回含 `adaptive`）；④ 浏览器冒烟：桌面 + 移动视口各跑 6 链路，截图 + `result.json` 落 `tests/e2e/artifacts/`，截图过 `ocr_vision` 复查无白屏/无 NaN；⑤ 20 游戏日 AI 长跑不变量脚本产出摘要（无 NaN/无越界/漂移有界）；⑥ tech-debt 与本 Phase 销账项对齐。

---

## §风险与不做清单

**风险**：R1（最大）**在线自适应改变 AI 成交与价格冲击分布**，可能动摇 phase4/订单流/泡沫破灭等既有统计假设，且属"统计性回归"——单测难捕获；缓解 = 默认值即现状 + 钳制带 + `AI_ADAPTIVE_ENABLED` 开关可回滚 + 20 日不变量长跑 + 固定种子逐点断言。R2 导航 network-first 与预缓存壳的错配只能靠 cache-first 或预热消除，两者各带代价（裁决点 5）。R3 E2E 脆弱性（DOM 漂移、赛季日历依赖）→ 断言语义化 + 允许 skip 并记录。R4 前端 jest 早于 vite build → dist 断言必须 skip-if-missing。R5 沙箱 EPERM → 全部子进程 fd 重定向。R6 `account.service.getMetrics` SQL 形态变化引发的存量涟漪（先跑 327 例确认）。

**不做清单（避免范围膨胀）**：RF 全量重训/阈值搜索；AI 参数与绩效落库（除非裁决 B）；行情生成/新闻/黑天鹅链路种子化；AI 强平/破产重置（AI 无杠杆）；AI 交易税费差异化（账本为近似口径）；`tierFor`（AI）与 `tier.ts`（玩家段位）合并统一；PWA 离线数据层（IndexedDB + 只读模式，Phase G）；i18n；nginx TLS；Docker 端到端冒烟（本机无 Docker，tech-debt 已 open）；引入 workbox 等外部依赖（红线：零外部依赖）；E2E 纳入 `npm test` 强门禁（除非裁决 B）。
