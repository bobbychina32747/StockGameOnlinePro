# REFACTOR-1：反编译风格 TS 清理（零行为变更）+ 沿路发现的真实缺陷

> 背景：后端 56 个源文件是早期**反编译产物**（`var __decorate/__metadata/__param` 帮派、`import x_1 = require()`、
> `let X = class X { [key: string]: any }` + 底部 `__decorate([...], X)` 应用块、满屏隐式 any）。
> 本次把它们改写成地道 NestJS/TypeORM TypeScript，并**顺路做了一次全量代码审阅**（缺陷清单见 §5，未修复）。
> 日期：2026-09-10 ｜ 范围：`backend/src/**`（56 个文件）+ 1 处测试断言升级

---

## 1. 转换规则（施工标准）

| 维度 | 反编译产物 | 现代 TS |
|---|---|---|
| 装饰器 | 文件底部 `X = __decorate([...], X)` / `__decorate([...], X.prototype, "m", null)` | 类上方 `@Injectable()/@Controller()/@Entity()/@Module()`；成员上方 `@Get()/@Column()/@InjectRepository()` 等 |
| 元数据 | 手写 `__metadata("design:type", String)` / `design:paramtypes` | 由 `emitDecoratorMetadata` 从**显式类型注解**重新生成（因此构造函数参数必须写类型） |
| 导入 | `import common_1 = require('@nestjs/common')` + `common_1.X` | ESM 具名导入 `import { X } from '@nestjs/common'` |
| 类声明 | `let X = class X { [key: string]: any }` + `export { X }` | `export class X { … }`（含显式字段声明） |
| 类型 | 全隐式 any | 构造函数/方法参数、字段显式类型；动态结构保留 `any` |
| 注释 | Phase A/B/C/D/E/F 历史注记 | **逐字保留**（这些注记记录了每次资金安全修复的原因） |

**零行为变更**是硬约束：不改算法、阈值、字符串字面量、语句顺序、`try/catch`/`await` 结构；发现缺陷只登记不修改。

## 2. 改动规模

- 56 个源文件（17 实体 + 18 模块/守卫/调度器 + 20 服务/控制器 + 3 核心引擎…按文件计）改写为现代 TS
- 净变化：**+2376 / −3746 行（净 −1370）**——减少的全部是反编译样板与 `[key: string]: any` 逃生舱
- 反编译残留扫描：`__decorate|__metadata|__param|require(|[key: string]: any` 在 `backend/src/**` **0 命中**

## 3. 验证证据（7 层，全部实跑）

| # | 验证 | 结果 |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | **0 error** |
| 2 | `npm run build` | OK |
| 3 | 后端全量单测（读 dist） | **368/368 全绿**（含 phase7/8/9/10/11/12） |
| 4 | **DI 启动冒烟**（临时库 + SANDBOX_FAST） | 应用成功启动、`GET /api/market/prices` 200；**并当场抓出并修掉 1 处 DI 回归**（见 §4.1） |
| 5 | **API 形状等价**：重构前后各抓 35 个端点（公开 + 认证 + 下单）的状态码与响应结构对比 | **35/35 完全一致**（脚本：`api-shape-snapshot.mjs` / `api-shape-diff.mjs`） |
| 6 | **装饰器/元数据序列比对**：逐文件提取编译产物里的 `__decorate([...])` 调用序列对比 | 64/73 逐项一致；9 处差异全部可解释（§4）；**唯一功能性差异即 4.1 的 DI 回归** |
| 7 | **浏览器 E2E 冒烟**（`tests/e2e/smoke.mjs`，生产壳 + 真实后端） | **6/6 PASS**（登录/下单/撤单/排行/赛季/断线壳）；生产模式冒烟另测：`/api/market/prices` 200 且 `/api/docs` 404（Swagger 生产门保持） |

辅助证据（脚本在 `E:\Files\.agent-work\sgp-iter\`，未入库）：`dist-equivalence.mjs`（归一化编译产物比对）、
`decorator-seq-diff.mjs`（元数据序列比对）、`member-order.cjs`（控制器方法注册顺序比对——**9 个控制器方法顺序全部一致**，路由优先级不变）。

## 4. 刻意偏离与说明

1. **`MarketDataService` 的 `market` 参数补 `@Optional()`**（`core/market-data/market-data.service.ts:95-99`）
   - 反编译版签名的 `design:paramtypes` 只有 4 项（第 5 参 Nest 不解析 → 走默认值 `'CN'`）；
   - 真装饰器写法会为第 5 参补一项 `Object` 元数据 → Nest 把它当令牌解析 → **启动失败**（已实测复现）；
   - 修法：`@Optional() market = 'CN'` → 解析不到时注入 `undefined` → 默认值生效，与重构前行为一致。**这是本次唯一的功能性修正**。
2. 实体 `nullable` 标量列写成 `price?: number`（纯类型层，`strict:false` 下零运行时影响）。
3. `@Index` 旁的 Phase D/F 注释由装饰器数组内移到 `@Index(...)` 上方（装饰器调用内无法放注释；文本一字未改）。
4. `database.module.ts` 的 `forFeature(entities)` 内联为 15 个实体的字面量数组（顺序逐字保留，运行时元数据比对一致）。
5. `ranking.controller.getRankings` 的 `design:paramtypes` 由 `[Number]` 补全为 `[Number, String, String]`（原先 `sort/market` 无元数据；Nest 对 String/undefined 元类型行为一致）。
6. 枚举字段（`OrderType/OrderStatus/SeasonType/EntryStatus`）现在有枚举类型；全仓无裸字符串赋值（tsc 已验证）。

## 5. 沿路发现的真实缺陷（**已在本文件 §7 分批修复**，行号为 Refactor-1 时的文件行号）

> Refactor-1 是零行为变更清理，所以下列缺陷当时只登记不修改。
> **Refactor-2/3（Phase 13）已修复其中 P0 ×5 与 P1 ×17**，见 §7；剩余项仍在 tech-debt 台账跟踪。

### P0 · 资金安全
1. **卖出偿还融资导致权益虚增、可无限套利** — `core/trading-engine/trading-engine.service.ts:550-557`（另 `:1216`、`:1322`）：
   SELL 分支 `cash += totalCost - fees` 与 `borrowed -= repay`（`repay = totalCost × (1 − 1/leverage)`）同时发生，**偿还部分没有从现金扣除**。
   杠杆 2、10 元买 100 股（cash 500 / borrowed 500）后同价卖出 → cash 1500、borrowed 0，权益凭空 +500；反复操作即刷钱，且维持担保比被抬高、强平被推迟。
   与 `:1258`（`recovered -= orphanDebt` 把负债当债权扣现金）口径自相矛盾——两处必有一处错。
2. **`settleCounterFills` 忽略结算返回值 → 单边坏账** — `:186-195`：`await this.settleFill(...)` 的 `{success:false}` 被丢弃，
   仍累加对手单 `filledQty` 并可能置 FILLED（订单"已成交"、盘口已消失，但账户资金/持仓未变且无回滚）；
   同文件 `settleCounterFillsInner`（`:1160-1195`）会检查 `r.success` 并回滚盘口——两套语义并存。
3. **AI 限价挂单成交后无任何账本回调** — `core/market-data/market-data.service.ts:852-871`（+`ai-opponents` 无 fill 侧记账）：
   `matching-engine` 只在 `entry.mmId` 存在时触发 `virtualFillHook`；AI 挂单也不冻结持仓 →
   `heldQty` 不减少，AI 可**跨日重复卖出同一批股票**、凭空向真实盘口供货；对手是用户挂单时用户真实结算而 AI 无对应账 → 股数/资金不守恒。
4. **分红 `perShare` 非数值 → 账户现金变 NaN（不可逆）** — `core/trading-engine/trading-engine.service.ts:815/821-822/833-836/856`：
   `Number(d.perShare)` 后守卫只判 `=== undefined`，**NaN 放行**；`Number(NaN.toFixed(2)) = NaN` → `cash = NaN` 落库，该账户后续全部算术/保证金率/UI 全 NaN；同段净空付息无下限校验。
5. **基金申购舍入套利 + 两次写库无事务** — `modules/fund/fund.service.ts:107-112`（扣款按 2 位半入、份额按未舍入 `amt` 算，`amt=0.014` 实扣 0.01 却拿 0.014 份额）与 `:113+123`/`:157+159`（cash 与 holdings 分两次写，中间崩溃 = 扣钱不记份额 / 加钱不减份额＝造钱）。

### P1 · 账本/幂等/风控
6. **回滚把 AI 虚拟挂单固化成无主真实单（幻影流动性）** — `trading-engine.service.ts:214/232/320/740`：回滚循环未过滤 `cf.virtual`，落库条目无 `virtual/mmId` → 不再被 `pruneExpiredVirtualOrders` 清理；`rollbackAuctionFills`（`:952-957`）有该过滤，说明是漏写。
7. **集合竞价两阶段结算非原子 + 失败吞异常** — `trading-engine.service.ts:977`（预校验在 `runExclusive` 之外，读队列外快照）、`:1014-1020`（catch 后仍 `return { success: true, settled }`）→ 并发/异常下"半套成交"且调用方无感。
8. **强平/追保不写交易流水** — `trading-engine.service.ts:1200-1253`、`:1286-1352`：直接改 `acc.cash`/`pos.*` 后 save，被强平者"钱变了但无成交记录"（对账断链、战绩漏计）。
9. **AI 市价单结算异常被吞 → 已成交未入账** — `market-data.service.ts:874-915`：结算抛错被 catch 吞掉，且跳过 `applyUserFill` 价格冲击。
10. **分红幂等窗口**：`recordDividend` 落库 fire-and-forget（`.catch(()=>undefined)`）、`ev.id` 未回填时不写 `applied:true` → 重启重载 `applied:false` → **重复除权 + 复权因子二次累计**（`market-data.service.ts:1988-1995`、`:155-165`）。
11. **日终结算幂等守卫只判相等不判先后** — `core/risk-manager/risk-manager.service.ts:103`：以更早的 day 重放 → 重复计息 + 重复写快照 + `currentDay` 回退 + 净值历史乱序。
12. **段位降级可被 DB 抖动覆盖写库** — `risk-manager.service.ts:173-197`：流水预载失败后静默按 0 流水口径（白银 23 分）计算并 `save` → 一次瞬时异常把全体账户段位刷成白银（仅 warn 日志）。
13. **集合竞价/挂单价格基准不一致** — `market-data.service.ts:848-851`（AI 报价区间用 `dayOpen ±10%`，撮合与委托校验用 `prevClose` 基准、首日 ±44%）。
14. **`applyUserFill` 改价不受涨跌停夹紧** — `market-data.service.ts:674-708`：单笔 ≤1% 但同 tick 多笔可叠加越带；越界成交价不写入 dayHigh/dayLow。
15. **隔夜跳空/除权不受涨跌停夹紧、`prevClose` 不复权** — `market-data.service.ts:1378-1392`、`:2011-2018`。
16. **`account.service` 原型链绕过**：`presets[preset]`（`:131`）与 `fx[fromMode]`（`:221`）可由 `__proto__/constructor` 命中 → `POST /account/reset {"preset":"constructor"}` 可把账户字段写成 `undefined`；`getTransactions` 的 `take: Math.min(limit||100,300)` 对 `limit=-1` 失效（返回全部流水）。
17. **用户级登录锁定可被用作 DoS** — `modules/auth/auth.service.ts:164`：对已知用户名连错 5 次即锁该用户 10 分钟（teams 二档取舍，注释已记录）。
18. **成就可伪造** — `modules/account/account.controller.ts:64`：成就 code 由客户端断言、幂等落库（评估在前端）。
19. **`GET /ranking?sort=equity` 失效** — `modules/ranking/ranking.service.ts:86,96`：条目字段是 `totalEquity`，比较取 `'equity'` → 恒 0，排序退化为原顺序。
20. **赛季结算重复发分窗口** — `modules/season/season.service.ts:213-229`：先发前三积分、最后才落 SETTLED，中断重放会重复发；`ensureSeason` 无锁（`:41-58`，并发插入同 seq 撞唯一约束报 500）。
21. **`market.gateway` 在线人数少计** — `modules/market/market.gateway.ts:93-97`：认证失败的连接不计数，但其断开仍 `clients--`。

### P2 · 体验/一致性/性能（摘要）
22. IOC 部分成交记为 `FILLED`（PARTIAL 枚举闲置）；FOK 回滚丢失同价排队优先级（`trading-engine.service.ts:232/252-265`）。
23. 做市商只有股数库存、无现金账与上下限；`setVirtualFillHook` 单槽位（`market-data.service.ts:1594-1631`）。
24. `getKlines` 未知 timeframe 返回 `undefined`；`reports` 只增不裁；`listedDay/nextIpoDay/macroEvents` 不落库（重启后首日带宽/指数阶梯/宏观日历失效）。
25. 除权只调 `price`、`prevClose` 不复权 → 当日涨跌幅含分红缺口；`divisor` 注释称每日重算、实际只初始化一次。
26. AI 账本不含手续费、买入量按 `priceNow` 估算 → 现金可为负、AI 净值/段位高估。
27. 基金 NAV 只在内存且只涨不跌，重启回初值 → 持仓者市值缩水；`totalInvested` 币种口径混杂。
28. 排行榜 ≤2 字符用户名不脱敏；`getUserRank` 返回含 `userId` 的内部对象。
29. `app.module.ts` 三个分支（含 postgres）全开 `synchronize: true`（生产自动改表结构风险）；`ranking.scheduler` 在构造函数里启动 30s 轮询（无开关）。
30. 下单无幂等键（网络重试产生第二笔真实委托）；WS 无每用户连接上限。

## 6. 后续建议（供排期）

- ~~**REFACTOR-2**：P0-1 → P0-5 逐项修复~~ → **已完成（Phase 13，见 §7）**
- ~~**REFACTOR-3**：P1 批量修复~~ → **已完成 17 项（见 §7）**，剩余 P1/P2 留在台账
- **REFACTOR-4**：`tsconfig` 开启 `strict`（需要先补 `Map<string, any>` 之类的真实类型，规模较大）
- ~~**REFACTOR-5（候选）**：① 赛季结算的"加分 + 打标记"改成单事务（需要按账户维度的发奖台账）；② 竞价 catch 回滚区分"已扣款/仅实体未同步"；③ 盘后固定价格交易的回滚目标修正（对手单应回 `closingBook` 而非连续竞价盘口）；④ 下单幂等键；⑤ WS 每用户连接上限；⑥ AI 账本手续费口径与挂单现金预留~~ → **本批已落地 11 项，见 §8**；仍留台账：① 赛季结算原子性（发奖台账）、⑥ 的「AI 手续费口径统一」、成就服务端判定
- E2E 环境提示：`~/.dsh/browser-profile` 这个持久 profile 一旦被强杀残留会锁住/损坏（表现为浏览器崩溃退出码 `0xC0000409`）；
  跑 E2E 时可用隔离 profile：`SGP_E2E_PLAYWRIGHT_CONFIG=<指向独立 userDataDir 的配置>`（本次即用此法复现 6/6 PASS）。

---

## 7. Phase 13（Refactor-2/3）修复记录

**已修复（P0 ×5 + P1 ×17 + 前端 ×5 hook 依赖）**：

| # | 缺陷（§5 编号） | 修复要点 | 回归测试 |
|---|---|---|---|
| P0-1 | 卖出偿还融资未扣现金（可刷钱） | 三处（`settleFillInner` SELL / `forceLiquidateInner` / `forceLiquidateToTargetInner`）改为"卖券所得先还债、净额进现金" | `phase13-money-safety` ①②③④ + `phase8` 口径更新 |
| P0-2 | `settleCounterFills` 吞结算失败 | 返回 `{ok, settled, failed}`；失败放回盘口 + warn，不置 FILLED | `phase13-money-safety` ⑥⑦⑧ |
| P0-3 | AI 限价挂单成交无账本回调（可重复卖出同一批股） | `virtualFillHook` 覆盖全部虚拟挂单（带 `tag/orderId`）；AI 账本 `restingOrders` 冻结（卖=持仓−活跃挂单，买=`cash×restBudget` 精确占用）；成交即入账 | `phase13-ai-ledger` ①②③④ |
| P0-4 | 分红 NaN 污染现金 | 非有限 `perShare`/金额整条跳过 + 写库前 `Number.isFinite` 防线 | `phase13-money-safety` ⑭ |
| P0-5 | 基金申购舍入套利 + 无事务 | 金额规范化到分、扣款与份额同源、赎回向下取整（<1 分拒绝）、两次写库进事务 | `phase13-fund-safety` 16 例 |
| P1-6 | 回滚固化虚拟挂单 | 4 处 cf 循环补 `if (cf.virtual \|\| !cf.orderId) continue` | `phase13-money-safety` ⑨⑩ |
| P1-7 | 竞价两阶段非原子/失败谎报成功 | 预校验移入 `runExclusive`；失败/异常返回 `success:false` | `phase13-money-safety` ⑬ |
| P1-8 | 强平/追保无流水 | 新增 `recordLiquidationTx`，4 个成交点接入 | `phase13-money-safety` ③④⑤ |
| P1-9 | AI 市价单结算异常被吞 | `{ok:false}` → 不入账、不计价格冲击、error 日志 | `phase13-ai-ledger` ⑤ |
| P1-10 | 分红事件幂等窗口 | 落库 `await` + 回填 `id` + 应用后 `applied:true` + 同 `(symbol, exDay)` 复用 | `phase13-price-band` |
| P1-11 | 日终幂等守卫只判相等 | 改为 `currentDay >= day` 跳过（重放保护） | `phase13-gateway-settlement` ⑤⑥⑦ |
| P1-12 | 流水预载失败刷段位 | `txPreloadOk` 标志，失败不调用 `computeTier`/不 save 段位 + error 日志 | `phase13-gateway-settlement` ⑧ |
| P1-13 | AI 报价基准不一致 | 复用 `cnPriceLimits`（昨收 + 首日 ±44%/-36%） | `phase13-ai-ledger` ⑥ |
| P1-14 | `applyUserFill` 越带 | 冲击价夹紧 + 写 `dayHigh/dayLow` | `phase13-price-band` |
| P1-15 | 跳空/除权口径 | 跳空写回前夹紧；除权同时下调 `prevClose` | `phase13-price-band` |
| P1-16 | 原型链绕过 / limit 负值 | `hasOwnProperty` 判定 + 汇率白名单 + `limit` 钳到 `[1,300]` | `phase13-input-guards` 12 例 |
| P1-18* | 成就可伪造 | **未修**（需产品定义服务端判定口径） | — 台账 |
| P1-19 | `sort=equity` 失效 | key 改为真实字段 `totalEquity` | `phase13-season-ranking` ⑧ |
| P1-20 | 赛季重复发分 / `ensureSeason` 并发 | `season_entries.rewarded` 列（用户级幂等发分）+ 唯一冲突幂等返回 | `phase13-season-ranking` ①-⑦ |
| P1-21 | WS 在线人数少计 | 连接打 `__counted` 标记，仅计数者自减 | `phase13-gateway-settlement` ①-④ |
| P2-22 | IOC 部分成交谎报 FILLED | 落 `PARTIAL` | `phase13-money-safety` ⑪⑫ |
| P2-24 | `recordDailyEquity` 除零 / NaN 权益 | 除零防护 + 非有限跳过保存 | `phase13-gateway-settlement` ⑨⑩ |
| 前端 | 5 条 `exhaustive-deps`（含 `MarketIndexBar` 切市场读旧值的真 bug） | 真修依赖（无 disable）：`useMemo` 稳定 `bars`、`applyAdjustmentPure` + `useCallback`、补 `marketMode`/zustand action 依赖 | `MarketIndexBar.test.tsx`、`ChartPanelAdjust.test.tsx` |

**仍未修（已在 tech-debt 台账登记，见 REFACTOR-5 候选）**：赛季结算的真正原子性（加分+打标记需事务与发奖台账）、成就服务端判定、`app.config` 的 `synchronize` 生产开关、AI 手续费口径统一。

---

## 8. REFACTOR-5 修复记录（Phase 14 加固批，11 项 + 1 项集成期新发现）

编号沿用 REFACTOR-5 任务清单（R5-①~⑬，其中 ①/⑤ 仍在台账）。**每项都有回归用例**，文件为 `backend/test/phase14-*.test.js`。

| # | 缺陷 | 修复要点 | 回归测试 |
|---|---|---|---|
| R5-⑪ | AI 账本挂单别名破坏（**集成期新发现**）：`refreshAiRestingValue` 重建 `ledger.restingOrders` → 调用点捕获的别名变孤儿，挂单挂出去不认账、现金占用恒 0 | `activeAiResting` 改**原地裁剪**；抽出只读 `aiRestingCash` 供市价闸门与 `restingValue` 复用 | `phase14-market-hardening`「服务自己挂出的限价买单必须留在账本」+「市价买单自动识别服务挂出的占用」 |
| R5-② | 竞价中断把**失败条目自己**也放回盘口（可重复结算：重复扣款/重复持仓变动） | `fills.slice(idx-1)` → `fills.slice(idx)`；失败条目保持 PENDING + `rejectReason='集合竞价结算中断，需人工核对'`（新 `markAuctionFillUnreconciled`），打标失败只 error 日志 | `phase14-order-hardening` R5-② ×3 + `phase13-money-safety` ⑬ 断言更新 |
| R5-③ | 盘后固定价格交易的对手单失败后回滚到**连续竞价盘口**（15:30 后申报变次日活单） | `settleCounterFills(..., opts.rollbackTo)`；`submitClosingOrder` 传 `'close'` → 回 `closingBook` 并按时间重排 | `phase14-order-hardening` R5-③ ×3（closingBook 回滚 / 默认连续盘口 / 方向映射） |
| R5-④ | 登录锁定按用户名计数 → 任意 IP 可锁死他人账号 | 计数键 `${正常化用户名}\|${ip \|\| 'local'}`；成功只清本键；查库仍用正常化用户名；NAT 残留风险记台账（`TRUST_PROXY`） | `phase14-auth-ws-config` ①~⑤（5 例） |
| R5-⑥ | 下单无幂等键（网络重试 = 第二笔真实委托） | `orders.clientOrderId` 列 + `(accountId, clientOrderId)` 索引；DTO 校验 ≤64；service 去重返回 `duplicate:true`；引擎三路径透传 + `backfillClientOrderId` 兜底；前端键复用仅限网络错误 | `phase14-order-hardening` ×5 + `orderIdempotency.test.ts` 13 例 |
| R5-⑦ | WS 无每用户连接上限 | `MAX_CONNECTIONS_PER_USER = 5`，超限挡新连接（不踢旧）；`__counted` 守护内清理集合 | `phase14-auth-ws-config` ⑥~⑧ |
| R5-⑧ | 做市商库存无上下限（单边行情退化为无限吸货/供货） | `MM_INVENTORY_LIMIT = ±60000`；报价值判「库存 ± 报量」收边，`onMmFill` clamp + 异常载荷拒绝 | `phase14-market-hardening` ×3 |
| R5-⑨ | 基金 NAV 只在内存（重启市值缩水） | `fund_navs` 实体 + `onModuleInit` 回填 + 定时 upsert + 首启补基线 | `phase14-fund-nav` 13 例 |
| R5-⑩ | `synchronize: true` 三处硬编码 | `DB_SYNCHRONIZE`（默认 true）+ 生产告警；`.env.example` 说明 | `phase14-auth-ws-config` ⑨~⑪ |
| R5-⑪ | AI 市价买单与挂单占用叠加破 `0.8×cash` | 先扣 `aiRestingCash`（跨标的活跃买单占用）再算量 | `phase14-market-hardening` R5-⑪ ×4 |
| R5-⑫ | 除权只调 `price/prevClose`，`dayHigh/dayLow/dayOpen` 仍是除权前值 | 按 `ratio = 新价/旧价` 同比例缩放 + `dayHigh ≥ price ≥ dayLow` 兜底 | `phase14-market-hardening` ×4 |
| R5-⑬ | 竞价成交不触发 `virtualFillHook`（冻结要等 TTL，AI 参与率被压制） | `runOpeningAuction` 收集虚拟挂单归属，返回前统一触发（载荷同 `matchAgainstBook`） | `phase14-market-hardening` ×4（含集成：库存 + 账本 + 冻结即时释放） |

**验证证据（6 层）**：`tsc` 0 error ｜ build OK ｜ 后端 **527/527** ｜ 前端 lint 0 error + `tsc` 0 error + **77/77** + 生产构建（PWA 门禁）｜ **API 形状 35 端点 PASS**（比对脚本放宽容许 `array<empty>` 运行期差异）｜ 全新临时库启动冒烟（新列/表/索引落库）+ **真实 HTTP 集成**（幂等同 `orderId`+`duplicate`、`fund_navs` 落库、登录锁 429/锁定文案）+ **E2E 6/6** + 生产冒烟（`/api/docs` 404、`DB_SYNCHRONIZE` 告警、`false` 时空库启动失败）。

**残留（台账）**：市价单幂等不生效（不落订单实体）、幂等不校验 payload 差异、前端未区分 `duplicate:true` 提示、竞价中断条目孤悬 PENDING 需人工对账、`DB_SYNCHRONIZE=false` 无迁移脚本、NAT + `TRUST_PROXY` 计数塌缩、WS 上限值与 `'error'` 事件名待前端对齐、三市场共享单钩子槽位。

