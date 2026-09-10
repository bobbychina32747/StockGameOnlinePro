# Changelog

本项目的所有重要变更都会记录在此文件中。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer）。

> **当前状态：BETA** — 核心功能完整，持续迭代中。行情为模拟数据，不构成投资建议。

## [Unreleased] - Phase F 对手盘智能 + 工程精修

### Added
- **AI 对手盘在线自适应（REALISM #20 收官，团队评审 C1-C16/R1-R13 定稿）**：10 个具名对手盘在保留人设的同时按自身战绩与市场状态调参——
  - 绩效反馈（`perfScoreOf`/`applyPerfFeedback`）：近窗口收益(±5% 打满, 权重 0.55) + 胜率(50%±25pt, 0.15) − 窗口回撤(12% 扣满, 0.30) → 分位 s ∈ [-1,1]；**单调性钉死「表现差 → 更保守」**（活跃/规模/止盈/羊群下调、止损收紧；s=0 恰好回默认，稳态无偏置）
  - 状态系数（`regimeCoef`/`volBucketOf`）：复用行情引擎既有 `marketRegime`(bull/bear/sideways) + 波动档(低/常态/高，由当 tick features 聚合)；**高波动档禁止任何更激进系数（activity/scale/tp/herd/hot 复合后一律 ≤1），止损只放宽不收紧（slK ≥ 1）**，高波动档追热点概率封顶 0.5
  - 本地 RF 在线学习（`treeVotes`/`rfScoreWeighted`/`adaptTreeWeights`）：每 5 游戏日按各树"决策方向命中率"重加权（带 [0.5,1.5]、样本门槛 60、树结构/阈值/叶值冻结）；**权重为 null / 全 1 时与 Phase E 的 `rfScore` 严格相等（零回归）**
  - 节奏与成本：全部在日终 `markAiEquityDaily` 内完成（O(10×8)），tick 路径零新增开销、每日仅一条 debug 日志；参数/绩效/树权重**全内存**（冷启原子复位为默认值）
  - 确定性与可回滚：8 处 `Math.random` 直调全部替换为 `agentRng(gameDay, tick, agentId, salt)` 种子随机（同盘面必然重放同一决策序列；noise 分支由两次随机数改一次，修复可复现性）；新增 `AI_ADAPTIVE_ENABLED` 应急开关（false → 参数回默认 + 系数全 1 + 树权重 null）
  - 风控红线：现金/持仓/挂单预算账本闸门保持硬约束、不参与参数化（买单恒 ≤ `floor(cash×0.8/price)`）；自适应只调行为倾向
- **`GET /market/ai-opponents` 新增 `adaptive` 聚合字段**（`enabled/regime/regimeLabel/level/activityMul/scaleMul`）——只给档位不给裸参数（防玩家反推套利）；前端 AI 助手面板显示「⚡激进 / ➖稳健 / 🛡收缩」档位标签 + 市场状态（一句话可解释）
- 新增测试 `phase12-ai-adaptive.test.js` 25 例（默认值=现状/钳制带/单调性/平滑漂移包络/regime×波动复合/RF 零回归/树权重门槛/种子确定性/20 游戏日长跑不变量/冷启复位/开关回滚/API 可见面）
- **E2E 冒烟脚本入仓（团队 C12）**：新增 `tests/e2e/smoke.mjs`（纯 Node 内置模块，零依赖）——
  - 6 条主链路：① 登录/注册（注册重名走 Phase E 的 200+`success:false` 语义回退登录）② 下单（购买力/持仓校验 + 后端 `GET /trading/orders/pending` 对账）③ 撤单 ④ 排行榜 ⑤ 赛季报名（区域缺失记 SKIP）⑥ **断线 → 横幅出现 → reload 后外壳非白屏**（`.ws-offline-tip` 文案断言）
  - 可选门禁：不进 CI 强依赖；`--strict` 时 SKIP 也返回 1；`--clean` 清理 7 天前产物；`--timeout=` 可调总超时
  - 安全红线：后端强制临时 SQLite（`%TEMP%\sgp-e2e-<pid>.db`）+ `SANDBOX_FAST=true`，**绝不触碰 `backend/data/stockgame.db`**（`result.json` 落 `realDbTouched:false` 声明）；退出（含异常/信号）杀净自己起的子进程并删临时库
  - 端口不写死：后端/preview/网关自动挑空闲端口；preview 的 `/api` 代理 target 固定 8000，端口不同源时脚本起同源内置网关（`/api` + `/socket.io`）兜底
  - 产物：`tests/e2e/artifacts/<runId>/`（`NN-<name>.png` 截图 + `result.json` + 各子进程日志），目录已 gitignore；**实测一轮 6 条链路全 PASS（exit 0）**
- **PWA 构建期 precache manifest（销 P2 债 #4，团队 C13/C14 定稿）**：新增 `frontend/scripts/build-sw.mjs`（零依赖，只用 node:fs/path/crypto）在 `vite build` 后扫描 dist 真实产物（`/assets/*.js|css` + 图标 + manifest + 壳）注入 `public/sw.js` 模板 → 产出 `dist/sw.js`；
  - 体积红线：单文件 >2MB **显式跳过并打日志**（禁止静默）、清单总量 >3MB **构建失败**、打印总字节与最大单文件
  - 缓存名 `VERSION = ${pkg.version}-${sha256(清单文件内容).slice(0,8)}`（同内容同缓存名、改内容必换名，配合既有 activate 清旧壳）
  - 新增 `frontend/scripts/check-sw-manifest.mjs` 双向差集门禁并串进 build（`tsc -b && vite build && build-sw && check-sw`）：① index.html 引用的每个 `/assets/*` 必须在清单内 ② 清单每项必须在 dist 存在 ③ 清单不得含 `/api/` 路径 ④ VERSION 含 8 位内容哈希
  - 新增 `frontend/src/pwa/precache-manifest.test.ts` 5 例（`dist` 缺失自动 skip，适配 jest 早于 vite build 的执行序）；负向验证实跑：缺项/幽灵项/超限三类样例均非零退出
  - 实测清单：9 项 / 1.41MB（echarts 1.01MB 为最大单文件，未触发 2MB 跳过线）

### Changed
- **强平候选裁剪（销 P2 债）**：`forceLiquidateMarginalAccounts` 先按 `borrowed/shortCollateral/marginUsed` 过滤无负债账户（零负债账户恒 safe，无需查持仓），候选账户持仓一次 `In` 批量预载，`checkMarginLevel` 新增可选第 3 参（缺省走原查询，存量调用零影响）；预载失败自动降级逐账户查询（风控不漏检）；配套"优化前后判定输入等价"断言
- **挂单扫描索引（销 P2 债）**：`orders` 新增 `(status, type)` 复合索引（`checkPendingOrders` 的等值+枚举过滤）；实测证据（3 万行、4% 挂单）查询计划 `SCAN orders` → `SEARCH ... USING INDEX IDX_orders_status_type`，2.191ms → 1.350ms（见 `docs/phaseF-plans/evidence/orders-status-type-index.txt`）
- **流水「最近 500 笔」口径单一来源（销 P2 债）**：新增 `perf.sliceRecentAsc`；修复 `account.service.getMetrics` 原「`order: ASC` + `take: 500`」在 SQLite 下实取**最旧** 500 笔（与注释/日终段位口径相反）→ 统一为最近 500 笔升序（`/account/metrics` 配对绩效口径与段位一致）

### 取舍说明
- AI 自适应状态不落库（重启按默认参数复位）：换取确定性可测与零迁移成本，登记 tech-debt（触发条件=玩家要求 AI 成长档案延续）- 绩效反馈未做横截面去均值（R7）：本 Phase 记为长跑观察项 + tech-debt（抑制 bull 期全体 AI 顺周期加码）
- 胜率项取"终身胜率 + 权重降至 0.15"方案（R9 二选一），窗口胜率口径登记 tech-debt
- 树权重重加权无时间衰减（R8 采纳"门槛 60"方案），登记 tech-debt
- 强平候选守卫未单独做"裸空头"体检查询（`shortQty>0` 且三项负债全 0 的存量脏数据；正常路径空头必有 `shortCollateral`），登记 tech-debt
- E2E 过程中实测到的三条产品/环境事实（未改码，写入 `tests/e2e/README.md` 与本文档备查）：① `vite preview` 默认只绑 `::1`，手工验收写 `http://127.0.0.1:<port>` 会 ECONNREFUSED（脚本已用 `--host 127.0.0.1` 规避）；② 休市时段下单默认被禁用，需管理员开启"全服休市交易"（脚本自动开启）；③ 撤单链路的挂单价需挂在涨跌停带内离现价更远的一侧，否则会被立即成交导致无单可撤

## [Unreleased] - Phase E 竞技化：模拟大赛 V2 + 债务清理

### Changed
- **seasonPoints 拆列**（销 P2 tierScore 双语义冲突）：account 新增 `seasonPoints` 荣誉积分列，赛季前三奖励由 tierScore 累加改为 seasonPoints（+300/200/100，该用户全部市场账户同额记账为 V1 兼容语义）；tierScore 归 computeTier 段位口径，两列互不隐式互算（phase9 断言改口径 + 锁 tierScore=0）
- **注册用户名枚举面收口**（teams 方案 B）：register 重名由 409 改为 HTTP 200 + `{success:false,error:'注册失败，请更换用户名'}`——状态码与文案均不区分「已存在/可注册」；前端 Login 显式 `success===false` 判错（已核验 api.client 拦截器仅特判 401 不吞 200 包裹）
- **红利税持有期修复**：lockDay 建仓时记 `currentDay`（此前恒 0 → 持有期恒 0 → CN 长线玩家恒按 20% 档错收）；加仓不刷新（保留最早建仓日）；resetAccount 不动 currentDay 已核验无漏税面

### Added
- **模拟大赛 V2**：seasons 加 `type`（weekly=5/月赛 monthly=20/双周 biweekly=10 游戏日；teams 定稿轮换 biweekly→monthly→weekly，首位兼容存量 10 日语义）；`GET /season/schedule`（赛程日历，合成未来届 + startDay 相对偏移估算值）；`GET /season/archive/:seasonId`（战绩档案：排名/奖牌/积分/报名起点→结算终点两点曲线/分市场明细/冠军对比，未结算返回 200+success:false）；`GET /season/points`（积分榜 max 口径防单场 ×3 失真 + 连续夺冠由 entries 推导）；前端报名横幅加赛季类型标签（teams 红线：类型与时长玩家可见）
- 新增测试 `phase11-season-v2.test.js` 23 例（拆列/轮换/赛程/档案/积分榜/注册/lockDay/API 防腐烂），后端 304→327、前端 52 例全绿

### 取舍说明
- 赛季类型轮换顺序采用产品定稿 biweekly→monthly→weekly（跨度变化可感知、避免连续短赛疲劳）；月赛 20 日等待由 daysLeft 可见性缓解
- archive 曲线为两点最小口径（season_entries 无逐日净值且 daily_snapshots 无 accountId 无法归属），逐日曲线裁到 V3
- 显式融券展期端点不做（隐式展期+券息日计，REALISM #15 裁剪注记）；除权日 T+1 经核验与真实规则一致（文档注记 + lockDay 相邻缺陷修复）
- Docker 端到端冒烟本机无 Docker 环境未执行 → tech-debt 登记 open（有 Docker/CI 后补跑）

## [Unreleased] - Phase D 工程化收口

### Security
- **Swagger 仅 development 挂载**：`/api/docs` 生产环境 404（不暴露接口清单与 schema）（`main.ts`）
- **backtest 限流**：`/api/market/backtest` 挂 express-rate-limit 20 次/分/IP（无认证公共计算接口防滥用）
- **登录账号级防爆破**：内存 Map 5 次失败锁 10 分钟（trim 规范化、成功清零、锁定前置短路省 bcrypt）；不存在用户名同样计数（锁定键为惰性键对真实用户无影响，枚举威胁由 IP 层 10 次/分限流兜底——teams 二档方案「锁 IP」需控制器传 req.ip 且 NAT 下误伤，故统一按名计数，取舍记录在案）
- **WS 握手校验 isActive**：JWT verify 后查 User repo，用户禁用后其存量 WS 立即断开（与 HTTP 侧 JwtStrategy 对称；`market.module` 补 `forFeature([User])`）
- **fill 广播脱敏**：`sanitizeFill` 剥离 counterFills 中对手方 accountId/orderId/mmId（保留 side/price/qty/virtual），顶层 filledQuantity/avgPrice 契约不变（`market-utils.ts`）

### Changed
- **API.md 按实现重写**：纠正漂移（撤单 `DELETE /trading/order/:id`、历史 `GET /trading/history`、fok/ioc/iceberg/stop-limit 语义、盘后固定价格 15:00-15:30、赛季四端点、真杠杆 cash×leverage/borrowed/维持担保比三级、红利税二档、基金费率三档、涨跌停昨收基准+新股首日 +44%/-36%、WS 事件真实形态）；新增 `phase10-api-doc-routes` 路由抽查（MUST_HAVE/MUST_NOT）防文档再腐烂
- **段位数据驱动**（销 tech-debt 主观 40/30/30 公式）：`tier.ts` 纯函数单一来源，权重 收益30/回撤20(peakEquity)/盈亏因子20/胜率20(perf.ts FIFO 配对)/活跃10(对数归一)；teams 定稿回撤保底 0.7 + 活跃保底 0.3（0 流水账户 23 分不掉出白银；副作用：最低分 17 → 青铜段仅表保留不可达）
- **settleAllAccounts 批量化**：纯读 N+1→3 次批量（账户/持仓 In/流水一次全局 ASC + JS 分组截最近 500），全部 try/catch 降级回退原路径；段位不再依赖内存历史（重启后口径一致）
- **checkPendingOrders 批量化**：预扫 willFill → 一次 `In` 预载账户 Map → dirty 标记延迟刷新（结算成功与回滚路径均标脏，读路径不容忍脏数据；`shouldFillNow` 纯函数抽离防两遍逻辑漂移）
- **实体索引**：orders(accountId,status)、transactions(accountId)（synchronize 首启自动落库）；positions 冗余索引按 teams 定稿砍除（Unique 左前缀已覆盖）

### Added
- **Docker 修复与容器化**：Dockerfile.backend 两阶段补 package-lock.json + CMD 改 `dist/src/main.js`；新增 frontend/Dockerfile（node 构建 + nginx 托管）、frontend/nginx.conf（SPA fallback + /api、/socket.io 反代含 Upgrade 头）、backend/docker/docker-compose.yml（sgp-data 卷挂 /app/data、env_file、TRUST_PROXY=1、8000/3000 端口、healthcheck 用公开 `GET /api/market/prices`——teams 定稿，Swagger 仅 dev 挂载不可依赖）、前后端 .dockerignore
- **PWA 离线支持**：manifest.webmanifest（Standalone、主题色 #0e1013 与深色主题同值）、手写 sw.js（预缓存 5 项离线壳 + 静态 stale-while-revalidate + 导航 network-first；**/api 与 /socket.io 一律不缓存纯直连**——teams 最安全解释，行情陈旧=误导决策）、仅 `import.meta.env.PROD` 注册 SW（dev 零影响）、零依赖 gen-icons.mjs 生成 192/512/180 图标
- 新增测试 `phase10-security`(14) / `phase10-api-doc-routes`(56) / `phase10-tier`(11) / `phase10-docker`(6) / 前端 `pwa/offline-assets`(11)，后端 217→304、前端 41→52

### 取舍说明
- 防爆破「锁 IP」二档方案未采纳：需控制器传 req.ip + 每 IP Map，NAT 下误伤正常用户，且 express IP 限流（10 次/分）已承担该层——按名统一计数实现更简、无信息泄露差异
- 青铜段位在新公式下不可达（保底系数使最低分=17=白银门槛上方）：teams 定稿参数权衡，阈值表保留兼容
- 段位流水配对窗口截断 500 笔（与 /account/metrics UI 口径一致）；快照表无 accountId 维度故回撤不用快照批量方案
- PWA 升级边界（发版后新 hash 资产未被离线访问过）与 nginx TLS 记为 P2（见方案 02 §10）

## [Unreleased] - Phase C 规则补全 + 前端体验 + 模拟大赛 V1

### Added
- **红利税二档制**（teams 定稿）：A股持有 ≤7 交易日 20%、>7 交易日 0%（快照 lockDay 近似持有期）；HK 统一 20%、US 统一 30%；分红流水记税后净额、税额计入流水费用字段（UI 口径一致）（`dividendTaxRate` + `payDividends`）
- **基金/ETF 费率模型**：申购费（ETF 0.15%/货基 0）、赎回费三档（<7交易日 1.5% / 7-30日 0.5% / ≥30日 0，`fund_holdings.firstBuyDay` 持有期）、币种按账户市场实时汇率折算（NAV 以 CNY 计价）；NAV 保持稳健上涨（风控红线：不重开重置/赎回套利窗口）（`fund.service.ts`）
- **指数权重动态化**：自由流通市值加权（hash 稳定流通股本）+ 除数法点位连续 + 新股上市次日起 5 游戏日阶梯权重纳入（避免跳变）（`getIndices`）
- **数据驱动教训卡**：单日大赚 >10%、满仓单票集中度 >80%（真实持仓/日收益触发，日结算幂等）（`risk-manager`）
- **成就服务端化**：`achievements` 表（UNIQUE(userId,code) 幂等）+ `GET/POST /account/achievements` + 前端本地与服务端合并展示（跨设备持久）
- **模拟大赛 V1**（快照净值赛 MVP，teams 定稿）：10 游戏日滚动赛季（`seasons`/`season_entries` 两表）、一键报名三市场同时参赛（首位报名者开赛、anchorDay 定格）、快照净值合成收益率排序（本金差异免疫）、前三 tierScore +300/200/100 荣誉奖励、30s 调度任一市场跑满自动结算并开新赛季、**赛季中已报名账户禁重置/划转/基金**；`POST /season/enroll` + `GET /season/current|leaderboard|history`；Ranking 页赛季榜/全服榜切换 + 报名入口
- 新增测试 `phase9-season-rules.test.js`（红利税 4 例/基金费率 4 例/赛季报名结算幂等 5 例/涨跌停工具 1 例），后端 204→217

### Changed
- **前端性能四件套**：addTick 批量 set（一次 setState 处理整批 tick，消除每 tick O(n) 全拷）；AppLayout 顶栏行情条独立 memo 组件（整对象订阅 prices 不再带动全树重渲染）；实时周期盘口 15s 低频轮询（修复盘口整场冻结）；StockListPanel boards 依赖补 prices（板块涨跌实时）
- **前端体验修复**：盘后窗口价格输入框只读锁定收盘价（销债）；CSS 徽章块移出错误嵌套（桌面端恢复样式）；移动端 Tab 栏 safe-area-inset-bottom；AchievementBoard 裸 JSON.parse 加安全回退；Ranking dayReturn=-1 除零防护；401 统一走 store logout（不再整页硬刷新）；删除 4 个空/死文件；生产构建关闭 sourcemap + echarts 独立分包（主包 1.4MB→357KB）
- 分红快照实体新增 lockDay 列（红利税持有期口径，synchronize 自动迁移）

### 取舍说明
- 融券展期：裁剪为"无固定期限（已隐式展期）+ 日终利息已含券息"，不做展期端点（真实券商融券多为随借随还按日计息）
- 段位评分数据驱动：推迟 Phase D（记 tech-debt 台账）

## [Unreleased] - Phase B 交易规则补全与盘后交易（评审 P1 全量，teams 协商定稿）

### Fixed
- **幻影流动性双计**：合成盘口每 tick 合并真实挂单用于展示，市价/FOK/IOC 先吃真实挂单再吃含旧真实数量的合成档=同一挂单被吃两次（实测真实 100 股被买走 150）。改为"显示与撮合分离"——orderBooks 只存纯合成深度，getOrderBook 输出层动态合并真实档（≤10 档），整类 bug 结构性消除（`matching-engine.ts`）
- **跨市场费率/T+1 绕过**：费率与 T+1 按账户 marketMode 判定（US 账户买 A 股零佣金无 T+1）。现在下单校验账户与股票市场一致（禁止跨市场，服务层 400 + 引擎层兜底），settleFill 内部按 symbolMarket 路由费率（不信任调用方 mode）（`order.service.ts` + `trading-engine.service.ts`）
- **A股涨跌停未落地**：生成端只逐 tick ±10% 可累计突破当日带宽、委托价无涨跌停校验。现在统一基准=昨收（真实涨停价=昨收×1.1 全天固定，新股首日 +44%/-36%）：生成端全天钳制、委托价校验（含边界价浮点容差）、盘口封板与竞价共用 `cnPriceLimits` 单一实现（`market-utils.ts` + `market-data.service.ts` + `matching-engine.ts`）
- **中性新闻必涨**：`bullish = type!=='bearish'` 令 neutral/insider 全按利好；现在仅 bullish/insider 上涨、bearish 下跌、其余方向 0（`market-data.service.ts`）
- **集合竞价成交从未结算（参数错位）**：`settleCounterFills(market, realFills)` 参数错位令 mode=数组、counterFills=undefined → 竞价成交挂单从盘口消失而 DB 永留 PENDING。现在按 symbol 两阶段结算：全量预校验→队列内逐条结算+订单 FILLED，任一失败全部挂单放回盘口恢复 PENDING（`market.service.ts` + `settleAuctionFills`）
- **多头杠杆语义矛盾**：买入强制全额现金却按杠杆推导借入计息/强平。现在为真杠杆（teams 裁剪版）：购买力=cash×杠杆、`accounts.borrowed` 记账（买入借入/卖出按比例偿还/重置清零）、日终按 borrowed+shortCollateral 计息、维持担保比强平基于记账负债（存量账户 borrowed 默认 0，零成本迁移）

### Added
- **盘后固定价格交易（A股 15:00-15:30）**：仅限价单且价格=当日收盘价；独立盘后队列同价时间优先撮合（不互吃连续竞价遗留挂单）；15:30 未成交自动撤销（rejectReason）；`orders.postClose` 标记 + `state.isPostCloseTrading` + 前端窗口内强制限价/锁定收盘价；15:30 后 `cancelAfterHoursOrders` 按 gameDay 防重入（`constants.afterHoursStageFor` + `submitClosingOrder` + `order.service.ts` + `OrderPanel.tsx`）
- **滑点唯一实现**：`slippage.ts`（slipStepFor/liveFillPrice，实盘与回测共用）；回测改用滚动 20 根 bar 收益率标准差估波动率、OFI=0 保守口径、CN 成交价按昨收涨跌停带钳制；slippageBps 保留显式覆盖
- 新增测试 `phase8-trading-rules.test.js`（幻影流动性 4 例/跨市场与涨跌停 7 例/中性新闻/盘后交易 3 例/竞价两阶段 2 例/真杠杆 4 例/滑点 3 例共 23 例），后端 181→204

## [Unreleased] - Phase A 资金与正确性修复（评审 P0 全量）

### Fixed
- **账户重置无限刷钱**：重置仅检查股票持仓，基金份额是独立资产被绕过（申购零费率基金→重置→赎回=资金复制）。现在基金持仓>0、存在 PENDING 挂单均一票否决；新增 1 游戏日冷却（lastResetDay 持久化）、RESET_ENABLED 环境开关（大赛期关闭）、reset_audit_logs 审计表与 resetCount（`account.service.ts`）
- **止损限价单（STOP_LIMIT）触发前即成交**：带 price 的单立即入盘口交叉撮合，无视 triggerPrice。现在 STOP_LIMIT 提交不入盘口，仅由 checkPendingOrders 在触发价满足后转限价撮合（`trading-engine.service.ts`）
- **分红当日除权+当日持仓发息的无风险套利**：改为 A股式快照口径——财报日仅登记（dividend_events 落库防重启丢失），exDay 开盘除权（竞价前执行），exDay-1 收盘拍持仓快照（dividend_snapshots），exDay 盘后按快照发息；净空头按每股扣息（负 DIVIDEND 流水）；paid 幂等防重复发放（`market-data.service.ts` + `trading-engine.service.ts` + `market.service.ts`）
- **强平/追保吞对手挂单且并发丢写**：不走结算队列、不结算对手方、部分成交仍清零持仓。现在 forceLiquidate/forceLiquidateToTarget 进入 runExclusive 队列，队列内重读账户，settleCounterFillsInner 结算对手单（失败回滚盘口），自成交防护（excludeAccountId），持仓按实际成交量扣减、剩余保留，冻结保证金按平仓比例释放
- **市价单滑点触顶后剩余量静默丢弃**：触顶后剩余量按 2% 触顶价兜底成交（FOK/IOC 仍受限价约束），与强平修复联动杜绝资产蒸发（`matching-engine.ts`）

### Changed
- **行情档位默认真实分钟级**：TICK_INTERVAL_MS 默认 60000（.env.example 与代码常量同步）；<60000 必须显式 SANDBOX_FAST=true 否则拒绝启动（快档日息/IPO/分红按游戏日加速，须自知为沙盒演示）；新增 `start-fast.bat` 一键快档；CI 冒烟补 SANDBOX_FAST
- **开盘竞价按游戏日对齐**：lastAuctionDay 由真实日期改为 gameDay 键，修复快档下一天 60 个游戏日却只有一次竞价、竞价与游戏日脱节
- 前端账户重置加 window.confirm 确认 + 服务端拒绝原因分支提示（原无条件弹成功）

### Added
- 新实体：dividend_events / dividend_snapshots / reset_audit_logs；accounts 表新增 lastResetDay/resetCount（TypeORM synchronize 自动迁移）
- 新增测试 `phase7-money-safety.test.js`（止损限价触发语义/市价兜底/强平部分成交与对手结算/自成交防护/分红快照发息与幂等/空头扣息/重置防刷钱攻击链 15 例），后端 166→181

## [Unreleased] - Phase 6 回测平台升级

### Added
- **回测引擎独立成类（REALISM #24）**：`core/backtest/backtest-engine.ts` 纯逻辑零 Nest 依赖（同 MatchingEngine 可直接单测），market.service 委托调用
- **真实手续费模型**：回测费率与实盘 `calcFees` 同口径（A股佣金最低5元+印花税0.1%卖+过户费 / 港股佣金最低50+印花税0.13%卖+征费 / 美股零佣金+SEC费+TAF费），按股票所属市场自动路由
- **滑点模型**：单边滑点基点可配置（默认 A股·港股 5bp / 美股 3bp，`slippageBps` 查询参数覆盖），买卖双向计入成本并单独汇总滑点成本
- **多策略回测**：MA 金叉/死叉（fast/slow）之外新增 RSI 超卖30买超买70卖（period，首根即超卖/超买可触发）、N 日动量转正买转负卖（momentumN，窗口前动量视为 0）
- **基准对比**：等额买入持有同期收益（同样计费+滑点），策略跑赢基准才算真策略；资金曲线双线（策略/基准）同图
- **绩效指标**：年化收益（按周期折算 252 交易日）/ 最大回撤 / 夏普（年化）/ 盈亏因子 / 手续费总额 / 滑点成本
- **CLI 升级**：`node scripts/backtest.js [symbol] [strategy] [p1] [p2] [timeframe]` 输出年化/回撤/夏普/盈亏因子/基准对比与建议
- 新增测试 `phase6-backtest.test.js`（费率模型 3 例/滑点与费用拖累 2 例/策略信号 3 例/基准与指标 3 例），后端 155→166；前端 41 例

### Changed
- `/market/backtest` 新增 strategy/slippageBps/period/momentumN 查询参数（旧参数完全兼容）；前端回测页策略选择 + 指标卡 + 双线资金曲线
- docs/API.md 新增回测端点文档（参数/返回字段/CLI 用法）

## [Unreleased] - Phase 5 账户/风控/多市场

### Added
- **配对级绩效（REALISM #18）**：`core/risk-manager/perf.ts` FIFO 流水配对（多空各自配对）→ 真实胜率/盈亏因子/月度收益热力图；`/account/metrics` 返回 pairedWinRate/pairedTrades/profitFactor/monthlyPnl，Profile 绩效卡新增展示
- **融券券源池（REALISM #15）**：每只股票可融券数量与券源年化费率（哈希稳定 3~12.5 万股、4%~9.9%/年），做空校验券源、成交扣券、平空还券（上限=初始）；`/market/flow-signals` 返回 shortAvailable/shortFeeRate，盘口面板显示「可融券」
- **担保品折算率动态化**：shortMarginRateFor 增加波动率参数——高波动个股保证金率上浮（风险敏感），仍钳制 [0.5, 0.65]
- **动态汇率（REALISM #16）**：HK/US 汇率逐日随机游走（±3% 波动带），跨市场划转用实时汇率；`/market/state` 暴露 fxRates；账户面板新增「合并资产(¥)」三市场实时折合
- **A股新股首日规则（REALISM #19）**：挂牌当日涨跌幅放宽为 最高+44%/最低-36%（发行价口径，合成盘口与集合竞价同口径），次日自动恢复 ±10%
- **后复权 + 成本复权口径（REALISM #13）**：图表复权三档切换（前复权/后复权/不复权）；持仓「多仓成本」按前复权口径显示（`utils/adjust.ts` 纯函数 + 单测）
- 新增测试 `phase5-account-risk.test.js`（配对绩效 4 例/折算率/汇率钳带/券源池/新股带宽 9 例），后端 146→155；前端 41 例

### Changed
- account.service 划转改用 `getFxRates()` 实时汇率；engine 保证金计算 5 处接入波动率动态折算率

## [Unreleased] - Phase 4 AI 对手盘生态

### 工程化与代码质量（回应外部评审）
- **Swagger API 文档**：新增 @nestjs/swagger，`GET /api/docs` 交互式文档（全部路由自动列出 + Bearer 认证）
- **去重**：A股/港股/美股判定统一到 `common/market-utils.ts`（`symbolMarket`/`isCnSymbol`，替换 3 处复制粘贴的正则）；`isTradingTimeNow` 收敛为日历驱动的 `isTradingTimeFor('CN')` 兼容委托
- **类型安全**：MatchingEngine 新增 `BookEntry/Fill/OrderBook` 接口（盘口与成交结构告别裸 any）
- **性能（事件循环争抢修复）**：tick 流水线拆分——价格/K线生成后**立即广播 WS**，宏观反馈/行业传导/AI 对手盘/做市商/指数反馈移入 `postTickProcessing()` 在广播后串行执行；AI 下单的 CPU 与 DB 等待不再阻塞前端推送（实时档与 1s 高速回放均受益）
- **并发设计文档**：`docs/CONCURRENCY.md`——说明为何用串行结算队列而非 @VersionColumn（单进程内存盘口，队列=事实互斥，队列内二次复核资金/持仓/T+1）、为何不引入 BullMQ（本地内存世界、无跨进程任务，真实瓶颈用流水线拆分解决）、多实例部署的升级路径（盘口外置→DB 行锁/分布式锁→再加版本列）
- 新增测试：postTickProcessing 独立可执行；后端 145→146

### Fixed
- **调试模式（无视限制）休市期失效**：修复三处根因——① tick 循环动态节奏：调试开启且全市场休市时走 1s/tick 高速回放（原按配置 60s 才一格，市场看似"死"）；② 自适应调度：休眠期每 ≤5s 重算节奏，调试开关/开盘时刻切换后 5s 内生效（原要等满上一个 60s 定时器）；③ 启动预热：最新价/波动率/合成盘口在 onModuleInit 直接注入撮合引擎（原休市重启后引擎无价格无盘口，市价单报"市场深度不足"）
- 关闭调试模式时同步复位全服休市交易开关（与注释承诺一致）；前端 Profile 同步刷新两个开关状态；state 接口的 tickIntervalMs 反映实际生效节奏（休市调试=1000）
- 新增回归测试 tickDelayMs（调试休市→1000，交易时段→按配置）；实测：调试开启 7s 内 tickCount 0→6、市价单即时成交、盘口/AI 对手盘就绪
- 开发辅助脚本 `backend/scripts/dev-insert-debug-admin.mjs`（注入/清理临时管理员账号，用于休市期端到端复现）

### Added
- **AI 对手盘品牌化**：10 个具名对手盘——算法一号（趋势跟随）/ 低波猎手（均值回归）/ 动量刺客（动量）/ 龙虎老哥（羊群）/ 反向大师（反转）/ 散户老王·小张·阿珍·老李·小美（噪声/动量/羊群/均值回归/反转），每人一句嘲讽台词；README 新增嘲讽文案（"🤖 AI 都打不过还想炒股赚钱？"）
- **完全本地、零外部 API**：对手盘由规则策略（趋势/均值回归/动量/羊群/反转/噪声）+ **本地随机森林**（8 棵固定决策树桩，对 {日内涨幅, 波动率, OFI, 行业周期, 市场情绪} 打分）驱动，无训练依赖、无网络调用，纯函数确定性可测
- **羊群效应强化**：羊群/动量策略的对手盘集中追热点行业 → 资金正反馈 → 泡沫积累 → 与泡沫破灭机制闭环（AI 自己也会被套山顶）；均值回归策略专挑超跌股
- **AI 绩效记账**：每个对手盘实时净值/收益率/胜率/交易笔数/段位（收益 40%+胜率 30%+活跃 30%）/每日净值快照，新端点 `GET /api/market/ai-opponents`（三市场合并排名）
- **订单流信号公开化**：`GET /api/market/flow-signals?symbol=` 返回 OFI（买压/卖压/均衡）与机构/游资大单净流入（万股，逐日清零）；前端盘口面板实时显示，AI 资金动向成为玩家博弈信号
- **前端 AI 对手盘排行榜**：AI 助手面板展示 Top5（名称/策略/收益/段位）+ 榜首嘲讽台词 + 玩家收益 vs AI 中位数对比——跑不赢就显示"🤖 AI 都打不过还想炒股赚钱？"
- 新增测试 `phase4-ai-opponents.test.js`（RF 打分方向/策略信号/羊群增强/绩效记账/段位/集成 13 例），后端 130→143

### Changed
- applyAiTrading 重写：每 tick 行情特征缓存全对手盘共用；方向 = 策略信号 70% + 随机森林 30%；平仓按平均成本法记入已实现盈亏与胜率；机构/游资成交计入大单净流入

## [Unreleased] - Phase 3 基本面与新闻引擎

### Added
- **财报基本面模型**（替换哈希伪随机）：每家公司营收增速/净利率/ROE 按 AR 过程逐日演化（行业周期驱动中枢+噪声），分析师一致预期向实际增速缓慢收敛；按个股披露日历（nextReportDay 错峰、约 45 游戏日/季度）披露财报，surprise = 披露增速 vs 一致预期五档分级（大超/略超/符合/略低/大低）
- **财报后漂移（PEAD）**：披露日分级跳空（±2.2%~±5.5%），随后 5 个交易日同向漂移（日 0.07%/0.15%），披露后分析师修正一致预期——利好利空的定价过程真实持续数日
- **分红与盈利能力挂钩**：净利率>10% 的公司 50% 概率派现（>5% 为 30%），派现额随利润放大
- **宏观数据日历**：CPI/PMI/央行议息/非农就业 定时披露（20~30 游戏日周期），市场一致预期 + surprise 分级——市场因子立即冲击 + 行业敏感度传导（银行/地产对议息、制造业/半导体对 PMI 等）+ 4 日持久衰减；state 接口暴露 macroHistory（最近 30 条）
- **新闻因果链**：新闻不再是一次性冲击——首日 40% 即时定价 + 60% 按几何衰减（0.7^n）分摊到持续日数，个股/行业/因子三类持久影响档案逐日注入；纯因子新闻同样获得多日衰减
- **行业景气周期**：每行业扩张/顶峰/收缩/谷底四阶段马尔可夫链（每日转移），驱动营收增长中枢、估值中枢（mean-reversion 锚点 ±8%/−6%）与波动率（收缩期 ×1.25）；F10 财报弹窗显示「行业周期」阶段
- 前端 F10 业绩速览升级：营收同比/分析师一致预期/净利率/ROE/行业周期/预期差文案（含"披露后数日持续漂移"提示）
- 新增测试 `phase3-fundamentals.test.js`（周期转移矩阵/预期收敛/surprise 分级/PEAD 同向/宏观落地/衰减曲线/引擎集成 20 例），后端 115→130

### Changed
- `generateReports()` 由"每 7 游戏日随机 30% 股票"改为"个股披露日历驱动"（market.service 每日调用，按 dueDay 过滤）
- 行情生成接入周期效应（effMu/volMul）与 PEAD 逐 tick 漂移；endOfDay 新增每日基本面管线（周期演化→基本面演化→宏观日历→新闻衰减）

## [Unreleased] - Phase 2 撮合与订单系统

### Added
- **撮合引擎独立成类**：盘口/撮合/竞价纯逻辑整体抽取为 `backend/src/core/trading-engine/matching-engine.ts`（`MatchingEngine` 无 Nest/TypeORM 依赖，可直接单测），TradingEngineService 全部委托；maps 别名共享，旧代码与既有测试零改动
- **冰山单（ICE）**：显示量+隐藏量；显示量被吃尽后自动从隐藏量逐档补量（同价队尾，价格-时间优先）；首轮交叉撮合只针对显示量；撤单清除盘口全部补量切片；前端下单面板新增「冰山单」类型与显示量输入（1/5 快捷）
- **动态冲击成本**：市价/限价滑点由固定"每 500 股恶化 0.1%"改为 OFI（订单流不平衡）×波动率模型——逆风最高放大 3.2 倍、顺风收窄 50%，步长 [0.02%, 0.4%]，总滑点上限 2%（触顶后剩余不成交）；波动率由行情引擎每 tick 同步
- **做市商模型**：每市场 2 个做市商（MM1/MM2）双边报价——价差 = 0.12% + 波动率×8，库存偏斜报价中心（多头→下移主动卖/空头→上移主动买），仓位越重报量越窄（下限 20%），每 10 tick 撤换单 + TTL 兜底；成交经虚拟成交回调实时更新库存（`market-maker.ts` 纯函数可单测）
- **止损单簿记**：orders 表新增 triggerLog（JSON 审计：triggered/转换模式/converted-no-liquidity/filled/settle-failed-retry/cancelled）与 triggerRetries——触发后无流动性保留重试、结算失败回滚对手方并保活，10 次上限后取消；限价单保持原排队语义不受重试计数影响
- 新增测试 `phase2-matching.test.js`（MatchingEngine 行为保持 / 冰山补量队尾 / OFI 步长与上限 / mmQuote 库存偏斜 / 做市商回调 / 止损审计与重试取消共 21 例），后端 94→115；前端 36 例全绿
- orders 表自动迁移：displayQty/hiddenQty/triggerLog/triggerRetries 列（TypeORM synchronize 启动时 ALTER，实测真实库升级成功）

### Changed
- placeVirtualOrder 支持 orderId/mmId（做市商报价撤换与库存回调）；removeRestingOrder 支持清除同 orderId 的全部冰山切片
- checkPendingOrders 不再直拍冰山单（由盘口撮合驱动，避免隐藏量提前暴露）

## [Unreleased] - Phase 1 行情真实性

### Added
- **统一交易日历数据源**：`backend/src/common/data/trading-calendar.ts` 与 `frontend/src/data/trading-calendar.ts`（字节级一致，pre-commit 钩子防漂移）——CN/HK/US 节假日清单按年份组织（2026 权威在库，2025/2027 可整体替换）；新增 `isMarketHoliday` / `marketDateFor` / `isUsDaylightSaving` / `usSessionsFor`
- **美股夏令时**：北京时间开盘 21:30（EDT 夏令时）/ 22:30（EST 冬令时），随 3 月第二个周日/11 月第一个周日自动切换；跨午夜交易日（0:00-5:00）按美东日期判定节假日
- **隔夜跳空模型**：替代原 2% 概率均匀随机黑天鹅——每市场每夜一次市场级冲击（含 4% 概率崩盘夜）×个股 β + 个股级厚尾冲击；CN 缺口钳制 ±10%（涨停/跌停开盘打标），HK/US ±25%；昨收/今开语义修正（prevClose=真实昨收），缺口写入 GARCH lastReturn
- **厚尾跳跃（跳跃扩散升级）**：保留高频小跳，新增低频大跳（crashIntensity 0.0015，波动率升高时概率放大至 3 倍，负向偏斜 60%），大跳不受单 tick ±2% 连续项限幅
- **A股三阶段集合竞价**：9:15-9:20 可申报可撤单 / 9:20-9:25 可申报不可撤（服务端拒绝撤单）/ 9:25-9:30 撮合中不接受申报（服务端拒绝下单）；竞价由 9:15 移到 9:25 执行；前端下单按钮按阶段显示「竞价申报中/竞价撮合中」
- **盘后回放加速器**：分时图一键回放历史交易日（1x/4x/16x 倍速、暂停/续播、播放进度 HH:MM），纯逻辑抽入 `utils/replay.ts` 单测
- 新增测试：后端 `phase1-market.test.js`（夏令时/三阶段竞价/隔夜跳空/厚尾跳跃 17 例）+ 前端 `replay.test.ts` / `marketSessions` 夏令时与竞价用例；后端 94/94、前端 36/36
- 开发工具：`backend/scripts/phase1-integration-smoke.mjs`（null 依赖构造引擎，实测 generateTick/endOfDay 数值合理）

### Changed
- `isTradingTimeFor` 未知市场回退 CN 且不再索引越界（前后端同步修复）
- 前端 `sessionLabel('US')` 与休市遮罩「下次开盘」文案随夏令时动态计算

## [Unreleased] - Phase 0 工程底座

### Added
- **CI（GitHub Actions）**：push/PR 触发后端（npm ci → tsc → 76 项测试 → 启动冒烟 /api/market/stocks）与前端（npm ci → eslint → tsc → jest → vite build）
- **前端测试基建**：Jest + babel-jest + jsdom + Testing Library（Vitest 因本地沙箱禁止 esbuild 子进程管道而改用进程内转译的 Jest，CI 不受影响）；新增 utils/quote、utils/marketSessions、store（行情 tick 合并 / UI 持久化）、PriceText 组件共 4 组测试
- **数据库迁移脚本**：`backend/scripts/migrate-sqljs-to-better-sqlite3.mjs`（备份 → integrity_check → 逐表行数核对 → 切换 WAL），npm 脚本 `db:migrate`
- **pre-commit 快速门禁**：`.githooks/pre-commit`（backend build+tests / frontend lint+tsc）

### Changed
- **数据库默认驱动 sql.js → better-sqlite3**：DB_TYPE=sqlite 时使用原生驱动（WAL 增量写盘 + busy_timeout，启动时 PRAGMA 初始化），消除 277MB 全库定时导出造成的秒级主线程阻塞；数据文件格式兼容，存量 `data/stockgame.db` 无需转换；DB_TYPE=sqljs 保留为兼容模式
- **lint 修复**：ESLint 配置移至 `frontend/.eslintrc.cjs`（解析器依赖在 frontend/node_modules，原仓库根配置无法解析）；frontend 补充 eslint/@typescript-eslint/@types/jest 等 devDependencies；`npm test` 脚本新增
- 仓库卫生：删除 9 个 3 字节空壳文件与 6 个百度云盘上传残留 `.cfg`

## [0.2.0] - 2026-08-14

### Fixed（体验）
- 跨市场划转：币种选择与金额输入框加宽（不再截断单位）
- 新闻错峰播报：开盘/收盘生成的新闻按 tick 逐条播出（不再同一时刻扎堆），日间新闻真正推送
- 设置/弹窗超高裁切修复（flex 居中溢出时顶部不可达）
- 亮色主题：调色板重做（灰阶/红绿/阴影适配浅色）+ 图表坐标轴/提示框/滑条/涨跌色随主题切换 + 错误边界颜色变量化

### Added
- **AI 行为树资金账户（P3）**：每个 AI 代理配备现金/持仓账本——买单受现金约束、卖单受持仓约束、未平挂单市值受预算约束（指数衰减近似 TTL 释放）；游资持仓止盈 +5%/止损 -3%，机构持仓超现金 60% 自动再平衡
- **两融细化（P3）**：做空保证金率按个股折算（0.50~0.65），维持担保比例三级阈值（<140% 预警 / <130% 追保部分平仓 / <120% 爆仓全平），追保按市值从大到小减仓至 150% 目标
- **跨市场资金划转（P3）**：CN/HK/US 账户间按汇率折算划转（CN=1 / HK≈0.92 / US≈7.12），服务端收取 0.1% 手续费，账户面板新增划转组件
- **FOK/IOC 指令（P2）**：FOK 全部成交否则撤销、IOC 立即成交剩余撤销，按限价即时撮合不排队，失败自动回滚对手方盘口；下单面板新增两种指令
- **市价滑点模型（P2）**：市价单吃穿盘口后剩余量按逐级恶化价格成交（每 500 股恶化 0.1%，上限 2%），涨跌停封板/无报价时不适用
- **盘前集合竞价申报窗口（P2）**：A 股 9:15-9:25 可挂单申报、窗口内不生成行情、9:25 竞价撮合（与开盘竞价共用最大成交量定价），每天仅一次
- **全生命周期日线历史（P1）**：按上市日补齐 2024-01-01 游戏纪元前的全部日线（随机游走+漂移校准无缝衔接游戏内历史，只落库一次，周/月线由日线聚合）——老股图表可回溯 30 年以上
- **绩效归因补齐（P2）**：个人中心新增盈利日占比与累计成交笔数（夏普/回撤/波动率/卡玛已有）
- **行情档位默认实时**：TICK_INTERVAL_MS 默认 60000（真实分钟级行情，全天约 4 小时），可改回 1000 高速回放
- **开盘集合竞价（P1）**：每日开盘按最大成交量原则形成开盘价（A 股限涨跌停区间），交叉挂单（用户+AI）以开盘价撮合、用户成交走真实结算，今开/日线开盘即竞价价；竞价先于连续竞价执行
- **复权因子（P1）**：分红除权记录累计前复权因子与事件序列，股票列表返回复权数据；图表支持「前复权/不复权」一键切换（按各 bar 时点因子折算历史价格，消除分红跳空，默认前复权）
- **AI 对手盘订单流化（P2）**：机构/游资/散户改为向真实盘口挂限价单（价格-时间优先排队、TTL 自动撤单）与发市价单（吃掉 AI 虚拟挂单 + 用户挂单），用户挂单可被 AI 触发真实成交，AI 成交计入价格冲击与成交量；修复用户成交方向判断 bug（大小写不匹配导致买单被当成卖单方向打价格）
- **各市场独立交易时段与节假日历（P1）**：A 股 9:30-11:30/13:00-15:00、港股 9:30-12:00/13:00-16:00、美股 21:30-次日 04:00（中国时间），各自节假日历（2026 近似清单）；行情生成、下单校验、前端休市遮罩/下单禁用均按市场判断
- **真实订单簿（P0）**：用户限价单常驻盘口队列（价格-时间优先），新单即时交叉撮合（对手价成交），市价/限价单先吃真实挂单再吃合成深度，部分成交后剩余继续排队，自成交防护，本方结算失败对手方订单回滚盘口，撤单/成交即时反映盘口
- **涨跌停封板排队（P0）**：A 股触及 ±10% 涨跌停时合成深度清空，市价单无法成交，限价单按价格-时间优先排队，开板自动释放
- **行情时间尺度可调（P0）**：TICK_INTERVAL_MS 配置（1000=高速回放 / 60000=真实分钟级行情），顶部状态栏自动标注「⏩ 高速回放」/「🕐 实时行情」
- 新增真实订单簿单元测试 10 例（价格-时间优先/限价封顶/自成交防护/封板排队/部分成交）
- **新手教程**：7 步引导（买入/周期/限价单/多市场/流水），右下角气泡不阻塞操作，localStorage 持久化
- **交易复盘（吃一堑长一智）**：泡沫破灭/强平/单日大亏 → 教训卡（事后解释 + 建议），个人复盘 + 全局教育卡，Profile 页展示
- **段位系统**：青铜→王者（收益40% + 风控30% + 活跃30% 综合评分），Profile/排行榜显示段位徽章

### Fixed（运行时修复）
- 全生命周期日线分批落库（2000 行/批）：修复 40 万行一次性 save 触发 Maximum call stack size exceeded
- AccountService 补 logger 初始化：修复跨市场划转 500（Cannot read properties of undefined）
- 实测验证：全新库启动成功（24.8 万根全生命周期日线落库、二次启动幂等跳过）、注册/登录/账户/跨市场划转（1000 CNY → 140.31 USD）端到端通过

### Fixed（安全与资金修复）
- 结算队列补充持仓/T+1 复核：封堵并发双卖/双平空导致的刷钱漏洞
- 基金申购赎回、杠杆设置增加 Number.isFinite 校验并纳入串行队列：封堵 NaN 注入损坏账户与并发双花
- 账户重置改为有持仓/挂单时禁止，杜绝免费套利棘轮；强平正确归还冻结保证金并按标准计费
- 平空增加资金校验防止现金为负；限价单成交价严格受限价约束
- 日终结算幂等化（currentDay 检查 + counter 于 finally 推进），杜绝重复计息/分红/快照
- 杠杆 1 账户不再被错误收取保证金利息（统一按 市值×(1-1/杠杆) 计息）
- 管理员默认密码仅限开发环境回退 admin123；其余环境必须配置强 ADMIN_PASSWORD，seed 脚本同理
- WebSocket 网关强制 JWT 认证（握手 auth.token），未认证连接直接断开
- 调试模式改为仅对开启它的管理员生效，普通用户休市仍不可下单
- 排行榜要求登录、limit 钳制、用户名脱敏、移除 userId 暴露；定时计算加容错与资源清理
- sql.js 持久化改为定时导出 + 原子替换（60s + 进程退出前落盘），消除每笔写入全库序列化
- 订单/基金/杠杆输入增加有限性与上限校验（Infinity/NaN/超大数量）
- 管理端加固：isActive 严格布尔、禁止禁用最后一名管理员、分页钳制、未知用户 404
- K 线启动去重 + 落库前存在性检查 + 保存失败重试告警；历史加载按市场过滤
- 夜间事件价格写回行情引擎；IPO 创建失败不再导致进程崩溃；日初先重置 T+1 再撮合挂单
- 前端修复：股票详情弹窗 Hooks 违规崩溃、WS 负载校验、无限重连、同源连接、401 拦截器误伤登录、登出残留、下单面板校验、Dashboard 兜底价格轮询与拖拽宽度持久化
- build 脚本跨平台（Windows cmd 可直接 npm run build）
- 新增 docs/REALISM.md：模拟真实性不足清单与"第二个同花顺"路线图

---

## [Unreleased]

### 计划中
- 分阶段集合竞价申报（9:15-9:20 可撤单）与盘后固定价格交易
- 后复权与复权口径盈亏联动
- 汇率动态波动与多币种合并资产视图
- AI 策略学习与羊群效应建模
- 接入真实行情源（模拟 → 真实数据可选）
- 用户社区 / 交易对战 / 模拟大赛深化
- 移动端打包（PWA / App）
- 多语言（EN / 繁中）
- 真实财报数据与宏观日历联动

---

## [0.1.0] - 2026-08-03

**首个正式版本（BETA）**：三服务器架构 + AI 对手盘 + 经济泡沫周期，具备同花顺级别的完整模拟交易体验。

### Added（新增）
- **三服务器架构**：A股 / 港股 / 美股独立行情引擎（各自独立的交易日、宏观因子、热点板块、黑天鹅），账户隔离，**跨服总榜 + 服内排行**一键切换
- **AI 对手盘**：每服务器 10 个市场参与者（机构低频大单价值投资 / 游资追热点快进快出 / 散户追涨杀跌），真实买卖影响价格与成交量
- **经济泡沫周期（隐形）**：行业价格偏离内在价值 → 泡沫积累（无提示）→ 细小抛售戳破（用户/AI 卖出高泡沫板块可能引发连锁恐慌）→ 股价向内在价值剧烈回归（崩盘），完整经济周期
- **指数影响全局**：跨市场指数（上证/恒生/纳指/道指等 8 个）平均变化反馈市场情绪因子
- **行业复合传导**：32 行业关联矩阵，行业动量按关联度传导（半导体涨 → 消费电子/软件跟涨）；事件驱动 LoD（平稳期 5 分钟传导，剧烈波动立即传导）
- **用户交易计入行情**：每笔成交产生价格冲击 + 成交量并入当前 tick K 线
- **休市超大遮罩**：非交易时段图表显示"已休市 + 下次开盘时间"
- **管理员调试模式**：个人中心开关，休市期间也生成行情、可下单
- **历史持久化**：K 线落库，重启恢复玩家历史并补齐 30 天
- **真实交易时段同步**：9:30-11:30 / 13:00-15:00，周末休市，休市禁下单

### Changed（变更）
- 股票池扩充至 68 只（A股 28 / 港股 20 / 美股 20，数量持平），各市场体现本土特色
- 排行榜支持市场维度（跨服 / 服内）

### Fixed（修复）
- 修复 tick 循环递归断裂：try 内 return 跳过 finally 后的 setTimeout（休市启动后行情永不恢复的严重 bug）
- 修复三服务器 IPO 重复上市崩溃（IPO 池仅 A 股服务器持有 + 已上市 IPO 内存加载）
- 修复价格正反馈自激爆炸（指数反馈单位错误、AI 追涨限制、行业传导上限、单 tick ±10% 安全网）
- 修复 init 重复创建 UNIQUE（inactive 池内股票自动重新激活）
- 主应用启动自动确保 admin 账号存在
- 修复 PriceText 空值崩溃（黑屏）、ErrorBoundary 错误边界、成交量直方图比例
- 修复 WS 连接断开（socket.io 只走 websocket）

---

## 历史背景（0.1.0 之前的开发里程碑）

以下功能为 0.1.0 之前迭代积累，合并入首个版本：

- **行情引擎**：GARCH 波动率 + OU 均值回归 + 宏观因子双向反馈 + 趋势状态机，分时/1分/5分/60分/日线/周线/月线 K 线，MA/BOLL/RSI 指标
- **玩法系统**：热点板块轮动、黑天鹅事件（利空/利好）、IPO 新股、财报季 + 分红除权、新闻系统（190+ 模板三阶段、100 天零重复）
- **交易体验**：市价/限价/止损/止损限价、部分成交、做空保证金（港美股 T+0）、A 股 T+1 涨跌停、真实盘口（用户挂单进盘口）、三市场差异化费率
- **同花顺式前端**：三栏拖拽布局、分时/K线分层切换、数字滚动动画、涨跌闪烁、搜索/自选/板块榜、F10 公司资料、通知中心、AI 助手、快捷键
- **量化接入**：完整 REST + WebSocket API 文档、MA 交叉回测、可运行量化机器人
- **其他**：移动端适配、排行榜、成就系统、模拟大赛、净值曲线、多主题/密度/动画设置
