# StockSim Pro — Phase 级迭代方案与评估报告（E/F/G）

> 基线：Phase A–D 已全量推送 origin/main（后端 304 例、前端 52 例全绿，双路启动冒烟 + 索引落库实测通过）。
> 本文档用途：下一批迭代（Phase E 起）的范围决策与验收依据。由主 agent 汇总（评估证据来自各 Phase CHANGELOG/commit/tech-debt 台账/docs 方案）。

> **Phase E 已交付**（2026-09-08，backend 327 / frontend 52 全绿）。
> **Phase F 已交付**（2026-09-10，backend 368 / frontend 见 CI 结果）：AI 对手盘在线自适应（REALISM #20 收官，团队评审 C1-C16/R1-R13 定稿）、
> 强平候选裁剪 + `orders(status,type)` 索引（实测 SCAN→SEARCH，2.19ms→1.35ms，见 `docs/phaseF-plans/evidence/`）+ `sliceRecentAsc` 口径统一、
> PWA 构建期 precache manifest（双向差集门禁 + 体积红线）、E2E 冒烟脚本入仓（可选门禁）。
> 方案与裁决存档：`docs/phaseF-plans/01-ai-adaptive-risk-pwa-e2e.md`。下一批：Phase G（多语言 + 离线数据层 + v0.3.0 发布）。
>
> **Phase G-1 已交付**（2026-09-10，frontend 77→92 全绿，E2E 6→7 条链路）：i18n 基础设施（零依赖字典 + `useI18n` + localStorage 切换 + **覆盖面门禁**：已登记文件不得残留硬编码中文、用到的 key 必须三语齐备）
> ｜覆盖面 1/3：**导航 + 设置面**（交易/排行两面待续，`COVERED_FILES` 逐批登记即逐批收紧门禁）｜沿路修复真实 UI 缺陷：设置弹窗因 `.top-bar` 的 `backdrop-filter` 变成顶栏的固定包含块 → 遮罩只有 1440×72、无整屏遮罩与点外关闭，现 portal 到 `body`（1440×900），并把该几何不变量写成 E2E 永久断言。

---

## 一、截至 Phase D 的交付评估

### 1.1 质量维度评估（证据制）

| 维度 | 评级 | 证据 |
|---|---|---|
| 资金安全 | ★★★★★ | Phase A 5 个 P0 资金漏洞全部封堵并回归（重置防刷钱/止损限价提前成交/分红套利/强平吞单/市价丢量）；Phase B 幻影流动性双计、跨市场费率绕过、竞价永不结算等结构性缺陷修复；每批 phaseN 回归 + 结算互斥队列 + 幂等守卫 |
| 规则真实性 | ★★★★☆ | 涨跌停/竞价/盘后固定价格/真杠杆/红利税/基金费率/复权/IPO 均已落地；剩余差距集中在「竞技玩法与发布工程」而非基础规则（见 §2） |
| 工程化 | ★★★★☆ | Phase D 收口：Swagger dev-only、限流、防爆破、WS isActive、广播脱敏、Docker compose、索引、批量化 N+1→3、PWA；API.md 有路由抽查测试防再腐烂 |
| 前端体验 | ★★★★☆ | 同花顺式界面 + 移动端适配 + 性能四件套 + PWA 离线壳；缺口：无浏览器级 E2E 回归体系、多语言、部分发布级体验（断线横幅/离线数据） |
| 文档/发布 | ★★★☆☆ | API.md 已按实现重写；但 README 技术栈仍写 sql.js、测试数 166、持久化描述过时；版本停在 v0.2.0（Phase 6–D 均未打 tag） |

### 1.2 债务与开放项清点（来源：tech-debt 台账 + 各 phase 方案 P2 登记 + REALISM 未勾项）

| # | 事项 | 类型 | 建议去处 |
|---|---|---|---|
| 1 | 盘后固定价格交易前端浏览器冒烟（需真实 15:00-15:30 窗口） | tech-debt[open] | Phase E 验证项（到窗口执行一次） |
| 2 | tierScore 双语义冲突：season 奖励累加 vs computeTier 每日覆盖共用一列 → 拆 `seasonPoints` | P2 债 | Phase E |
| 3 | register 409 用户名枚举面 | P2 债 | Phase E（注册统一响应或速率限制） |
| 4 | PWA 升级边界：构建期动态 precache-manifest（workbox/vite 插件） | P2 债 | Phase F |
| 5 | nginx TLS（PWA 非 localhost 生效前提） | P2 债 | 部署项（不排期，运维触发） |
| 6 | 数据层离线：IndexedDB 行情快照 + 断线横幅 | P2 债 | Phase G（或裁剪） |
| 7 | infra 旧 docker-compose 标注 deprecated（引用不存在的 frontend Dockerfile） | P2 债 | Phase E（文档一行） |
| 8 | checkPendingOrders (status,type) 索引（挂单量增长后） | P2 债 | Phase F（量变触发） |
| 9 | forceLiquidate 只对 borrowed>0/shortCollateral>0 账户估值 | P2 债 | Phase F |
| 10 | resetBoughtTodayInner 逐条 save → 批量 | P3 债 | 不做清单（收益过低） |
| 11 | perf.ts `sliceRecentAsc` 统一 500 笔截断口径 | P2 债 | Phase F（顺手） |
| 12 | AI 对手盘策略学习（在线自适应） | REALISM #20 最后一块 | Phase F |
| 13 | 模拟大赛深化：周赛赛季/多人同场/战绩档案 | README 未勾 | Phase E（主项） |
| 14 | 融券「显式展期」 | REALISM #15 最后一环 | 不做（已隐式展期+券息日计，裁剪注记进 README） |
| 15 | 券商通道/佣金分级差异 | REALISM #17 残余 | 不做清单（教育模拟盘收益为负） |
| 16 | 除权日 T+1 细节 | REALISM #19 残余 | Phase E（小项） |
| 17 | 多语言 EN/繁中 | README 未勾 | Phase G（主项） |
| 18 | 文档新鲜度：README 技术栈/测试数/持久化描述 | 文档债 | Phase E（附赠） |
| 19 | Docker 全链路真实 build 冒烟（本机 Docker 环境未验证） | 验收空白 | Phase E 验证项 |
| 20 | 浏览器级 E2E 体系化（playwright 冒烟脚本入仓） | 工程债 | Phase E（附赠或 F） |

---

## 二、Phase 迭代方案

### Phase E「竞技化：模拟大赛 V2 + 债务清理」—— 让玩家留下来

**目标**：把 Phase C 的赛季 V1（快照净值赛 MVP）升级为可长期运营的竞技体系；同时清掉 P2 债里与账户语义/文档相关的一批。

**范围（按验收块拆 commit）**
1. **seasonPoints 拆列**：account 新增独立 `seasonPoints`（赛季奖励不再污染 tierScore）；存量 tierScore 归位段位口径；赛季奖励改为写入 seasonPoints。后端回归（phase9 奖励断言改口径）。
2. **大赛 V2**：
   - 赛季类型：周赛（5 游戏日）/月赛（20 游戏日）/当前 10 日档改为「双周赛」；报名端点带 type，赛程日历端点 `GET /season/schedule`；
   - 战绩档案：`GET /season/archive/:seasonId`（个人净值曲线 vs 冠军合成曲线、逐日收益、分市场拆解、奖牌记录）；
   - 排行榜补「连续获奖」与赛季积分榜（sum(seasonPoints) 年度榜）。
3. **注册枚举面收口**：POST /auth/register 对已存在用户名返回统一 200+`{success:false,error:'注册失败，请更换用户名'}`（前端按成功码判断；行为保持 409 的旧客户端由前端同批改）——或维持 409 + 注册端点限流降为 5/min。teams 裁决选一。
4. **除权日 T+1 细节**：除权日当日买入的股票按除权价入账、卖出仍受 T+1 约束（与 lockDay 红利税口径对齐，代码确认后小改）。
5. **验证项（不改码）**：盘后窗口浏览器冒烟（真实 15:00-15:30 执行，销 tech-debt 台账 #1）；`docker compose -f backend/docker/docker-compose.yml up --build` 端到端（前端 3000 → 反代 → 后端 8000 → WS 行情）。
6. **文档附赠**：README 技术栈改 better-sqlite3、测试数改 304/52、持久化描述改 WAL；REALISM 勾 #15（裁剪注记）；infra 旧 compose 标注 deprecated。

**验收**：后端 build + 全绿（预计 304+≥20 新 phase11 例：拆列迁移断言/赛季类型与积分/注册枚举/除权 T+1）；前端 build+tests；启动冒烟（SANDBOX_FAST 临时 DB）；两处人工验证项完成并销账。

**风险/成本**：低-中。赛季 V2 涉及两表结构（seasons 加 type 列 + 快照口径按赛季类型），但 V1 已证明快照净值框架；seasonPoints 拆列属同步自动迁移 + 一处累加改写。预估 2-3 个交易日（快档）。

---

### Phase F「对手盘智能 + 盘口/风控工程精修」——真实感最后一公里

**目标**：AI 对手盘从"固定策略"进化到"在线自适应"（REALISM #20 收官），补齐盘口压力路径与性能细项。

**范围**
1. **AI 策略学习（在线自适应）**：10 个具名对手盘保留人设，但市场参数（激进度/持仓偏好/止损宽严）按最近 N 日自身绩效 + 市场 regime 在线调整（胜率低→收敛激进/减少交易；热点期→提高羊群权重）；本地 RF 每 N 日增量重训（数据落库为内存缓存）。为防不确定性回归：随机种子确定性 + 参数钳制带 + phase12 行为断言（参数漂移有界、绩效不劣化单调性宽松断言）。
2. **风控精修**：forceLiquidate 先按 borrowed/shortCollateral 过滤无负债账户（N+1 查询裁剪）；checkPendingOrders 补 (status,type) 索引（挂单量回归数据支撑）；perf.ts 抽 `sliceRecentAsc` 统一 UI/段位 500 笔口径。
3. **PWA 升级边界收口**：构建期生成 precache-manifest（最小 vite 插件注入 /sw.js 或 build 后改写 sw.js 常量清单，二选一 teams 裁决），消除发版后离线半白屏窗口。
4. **验证项**：E2E 冒烟脚本体系化（playwright-cli 入仓：登录→下单→排行→断线横幅检查，作为 `npm run smoke:e2e` 可选门禁）。

**验收**：后端全绿（预计 +15~25 例）；AI 对手盘自适应跑满 20 游戏日无越界/无 NaN；前端冒烟脚本三端通过（桌面/移动视口）；PWA 升级窗口测试（v1→v2 离线重载）。

**风险**：中。在线自适应最易引入不可预期行情扰动 → 必须参数钳制 + 确定性种子 + 行为断言兜底（风控红线：AI 不得拥有超人类信息/资源，自学收敛仍受现金/持仓账本约束）。预算：3-5 个交易日。

---

### Phase G「发布工程：多语言 + 离线数据层 + v0.3.0」——对外的版本

**目标**：把积累的功能正式发布（v0.3.0 tag），并补齐"产品级"体验。

**范围**
1. **i18n V1（zh-CN / en / zh-Hant）**：文案集中化（前端抽 `src/i18n/` + 轻量字典，先覆盖导航/交易/排行三大高频面，配置 localStorage 切换）；后端错误文案保持中文（文档注明），仅前端层本地化 + 模板参数。倾向不引 i18next（体积），自研 30 行 useI18n hook + 字典分片。
2. **数据层离线 V1（PWA 债 #6 收口）**：IndexedDB 缓存最近报价/持仓快照，断线横幅 + 只读模式（禁交易动作），恢复自动同步——teams 需要裁决缓存 TTL 与「陈旧即误导」边界（Phase D 已定 /api 不缓存原则，此处是**应用态**快照而非 HTTP 缓存，语义不同）。
3. **发布工程**：CHANGELOG 归拢 + tag v0.3.0 + GitHub Release notes（含 Docker 一键部署段落）；README 快速开始补 compose 路径；lint 全量告警清零与否裁决（96 warnings 现值，至少修 react-hooks 真实缺陷类）。
4. **验证项**：全量手动回归清单（按 browser-smoke-tester SOP 的映射表跑一遍主链路并截图存证）。

**验收**：前端 tests 全绿（+i18n 字典完整性测试：无缺 key）；离线模式手动冒烟（DevTools offline 下壳可开、只读横幅、恢复同步）；Release v0.3.0 发布。

**风险**：中。i18n 覆盖面容易膨胀（dict 未收词→漏译），用"完整性测试：抽取源文案集合 vs 字典 key 差集"门禁；离线数据层与现有 axios 错误路径交互需 teams 定夺。预算：4-6 个交易日。

---

### 远期（不排期，触发条件另行立项）

| 事项 | 触发条件 |
|---|---|
| 真实行情源接入（模拟→真实数据可选） | 有真实数据授权/合规需求 |
| 用户社区/交易对战 | 赛季 V2 留存数据证明玩法成立 |
| 移动端原生 App | 需要推送/离线记账等原生能力 |
| 真实财报数据与宏观日历联动 | 数据源成本可控 |
| nginx TLS | 有公网域名部署需求 |

### 不做清单（明确裁剪，避免范围膨胀）

- 显式融券展期端点（已隐式展期 + 日终计息含券息，README 注记裁剪即可）
- 券商通道/佣金分级差异（教育模拟盘无收益）
- resetBoughtTodayInner 批量 save（P3，收益过低）
- 后端错误文案多语言化（成本高，文档注明中英边界）

---

## 三、优先级矩阵与依赖

| Phase | 价值 | 成本 | 风险 | 依赖 | 建议 |
|---|---|---|---|---|---|
| E 竞技化+债务清理 | 高（留存机制） | 低-中 | 低 | 无 | **下一批立即执行** |
| F 对手盘智能+工程精修 | 中-高（真实感） | 中 | 中（自适应收敛） | E 的 seasonPoints 拆列与 E2E 脚本 | E 之后 |
| G 多语言+发布 | 中（面广） | 中-高 | 中（i18n 漏译/离线语义） | F 的 PWA 收口 | v0.3.0 发布前完成 |
| 远期/不做 | — | — | — | 触发条件 | 台账跟踪 |

**依赖链**：Phase D 已清空阻塞项（文档/安全/Docker/PWA 壳），E/F/G 相互独立度较高，可按顺序单 phase 交付，每 phase 沿用既有流程（子代理方案 → teams 五角色带立场卡审核 → 主 agent 对账 → 分块 commit → 全绿验收 → [AI] 推送）。

## 四、每 Phase 收尾动作（不变式）

1. 后端 build + 全量测试（含新增 phaseN 回归）绿；前端 build + tests 绿
2. SANDBOX_FAST=true + 临时 DB 启动冒烟（dev/production 双环境抽查 Swagger 门）
3. CHANGELOG Unreleased 顶部按块追加 + 涉及外部行为的 API.md 同步（phaseN 路由抽查防腐烂）
4. tech-debt 台账：本批销账 + 新开项登记
5. [AI] 前缀 commit 分块推送 origin/main；涉及前端用户可见状态的功能过 browser-smoke-tester（截图存证）
