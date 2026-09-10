# StockSim Pro — API 文档（量化/AI 接入指南）

模拟炒股平台的完整 HTTP + WebSocket 接口。任意语言/独立 AI 均可通过本 API 获取行情、执行交易、读取账户。

> 本文件由 phase10 测试 `backend/test/phase10-api-doc-routes.test.js` 做路由抽查（MUST_HAVE / MUST_NOT 清单），改动接口时必须同步更新本文件。

- Base URL: `http://localhost:8000/api`（全局前缀 `api`）
- 认证: 登录返回 `token`，后续请求带 `Authorization: Bearer <token>`
- 市场 `mode`: `CN`（A股）/ `HK`（港股）/ `US`（美股）。**缺省 `US`**（交易/账户类端点 `mode || 'US'`）
- 股票代码约定：`H` 前缀=港股，`U` 前缀=美股，其余=A股（如 `T1`/`C1`、`H001`、`U001`）
- Swagger 交互文档：**仅 development 环境**挂载 `GET /api/docs`
- 限流：`/api/auth/*` 每 IP 10 次/分；`/api/market/backtest` 每 IP 20 次/分。超限返回 `429 {"statusCode":429,"message":"请求过于频繁，请稍后再试"}`
- 错误约定：Nest 异常返回 `{statusCode, message, error}`；401=未认证/凭证错、403=越权、404、429=限流。多数业务拒绝以 HTTP 200 + `{success:false, error}` 返回（逐端点注明，注册重名亦走此约定）
- 请求体校验：ValidationPipe `whitelist+forbidNonWhitelisted`——未知字段直接 400

---

## 1. 认证

### POST /auth/register（公开）
```json
{ "username": "你的用户名(2-50字符)", "password": "你的密码(8-72字符)" }
```
注册即创建 CN/HK/US 三市场账户，各 100000 初始资金。返回 `{user:{id,username,role,isActive,createdAt,updatedAt}, token}`；重名返回 **HTTP 200 + `{success:false, error:'注册失败，请更换用户名'}`**（枚举面收口：状态码与文案均不区分「已存在/可注册」）。

### POST /auth/login（公开，HTTP 200）
```json
{ "username": "你的用户名", "password": "你的密码" }
```
返回 `{user:{...安全字段}, token}`。错误 401 `用户名或密码错误`（用户名不存在与密码错误同文案）。
**防爆破（REFACTOR-5 口径）**：计数键为「用户名 | 客户端 IP」，同键 5 次失败锁定 10 分钟，锁定期返回 401 `尝试次数过多，账号已锁定10分钟`（正确密码同样被拒）；登录成功只清「本键」，不影响该用户在其它 IP 上的失败计数。反向代理部署需设 `TRUST_PROXY>0`，否则 `req.ip` 恒为反代地址 → 退化成按用户名计数。

---

## 2. 用户（需 token）

### GET /user/profile
返回 `{id, username, role, createdAt}`。

### PUT /user/profile
Body `{"username":"新名字"}`（仅 username 可改）。返回完整安全档案 `{id,username,role,isActive,createdAt,updatedAt}`。

---

## 3. 账户（全部需 token；`mode` query 缺省 US）

### GET /account?mode=US — 账户与持仓
```json
{
  "account": { "cash": 88979.1, "leverage": 1, "borrowed": 0, "shortCollateral": 0, "marginUsed": 0,
    "totalEquity": 100023.4, "dayStartEquity": 100000, "initialEquity": 100000, "peakEquity": 100023.4,
    "dailyPnl": 23.4, "totalPnl": 23.4, "tier": "白银", "tierScore": 23, "currentDay": 3 },
  "positions": [{ "symbol": "T1", "longQty": 100, "shortQty": 0, "longCost": 45.3, "shortCost": 0, "boughtToday": 100, "lockDay": 0 }]
}
```

### GET /account/metrics?mode=US — 绩效指标
返回 `{account, metrics}`；metrics 含 `totalReturn/sharpeRatio/maxDrawdown/calmarRatio/winRate/volatility/totalTrades/pairedTrades/pairedWinRate/profitFactor/monthlyPnl`（胜率与盈亏因子为真实流水 FIFO 配对口径）。

### GET /account/history?mode=US — 净值曲线
`[{day, equity, return}]`（内存最近 365 天）。

### GET /account/transactions?mode=US&limit= — 交割单/流水（limit ≤300）
`[{id, orderId?, symbol, side, quantity, price, turnover, commission, stampDuty, transferFee, totalFees, createdAt}]`

### GET /account/reviews — 复盘教训卡（个人+全局 ≤20）

### POST /account/leverage?mode=US — 设置杠杆
Body `{"leverage": 2}`（1~3 整数，越界 400）。真杠杆口径见 §4 规则说明。

### POST /account/reset?mode=US — 重置账户
Body `{"preset":"散户|机构|日内交易者"}`（散户 10w/1x、机构 50w/2x、日内交易者 20w/3x）。
依次拒绝：`RESET_ENABLED=false`（大赛中）→ 赛季中已报名 → 有持仓 → 有基金份额 → 有未成交挂单 → 距上次重置 <1 游戏日。多数拒绝为 HTTP 200 + `{success:false,error}`。

### POST /account/transfer?fromMode=CN&toMode=US — 跨市场划转
Body `{"amount": 1000}`。动态汇率折算 + 0.1% 手续费，返回 `{success, received}`。赛季报名中禁划转。
非 CN/HK/US 的市场参数（含 `__proto__`/大小写变体等非法值）现返回 **400**（Phase 13 加固，防止原型链取值绕过）；同市场或空值仍是 200 + `{success:false,error}`。

### GET /account/achievements / POST /account/achievements — 成就
GET 返回成就列表；POST body `{"code":"..."}` 幂等解锁（UNIQUE(userId,code)），返回 `{success, duplicate?}`。

---

## 4. 交易（全部需 token；`mode` query 缺省 US）

### POST /trading/order?mode=US — 下单
Body：
```json
{
  "symbol": "T1",
  "type": "market",              // market | limit | stop | stop-limit | fok | ioc | iceberg
  "side": "buy",                 // buy | sell | short(非CN) | cover(非CN)
  "quantity": 100,               // 1~1000000 整数
  "price": 45.5,                 // limit/fok/ioc/iceberg/stop-limit 必填
  "triggerPrice": 46.0,          // stop/stop-limit 必填
  "displayQty": 30               // iceberg 显示量（1~总量-1 整数）
}
```

**幂等键 `clientOrderId`（REFACTOR-5 新增，可选，≤64 字符）**：客户端网络重试时携带同一键 → 服务端按 `(账户, clientOrderId)` 命中既有订单，直接返回该订单且 `duplicate:true`，**不再走引擎**（不会二次撮合/二次扣款/二次建仓）。未传或纯空白时行为与修复前完全一致。注意：① 只有 `limit/stop/stop-limit/iceberg/fok/ioc/盘后申报` 会落订单实体，**市价单 `market` 不落实体 → 幂等键对市价单不生效**；② 命中只按键，**不校验 payload 差异**（同键但改了参数仍返回旧订单），故重下不同参数的委托请换键。

**订单类型语义**：
| type | 语义 |
|---|---|
| `market` | 即时按盘口深度+滑点全量市价成交，不进盘口；深度不足报错 |
| `limit` | 挂真实盘口排队（价格-时间优先），触发后限价封顶撮合，支持部分成交续排 |
| `stop` | 止损单：价格穿越 `triggerPrice` 转市价；触发后无流动性重试 10 次后取消；**不挂盘口** |
| `stop-limit` | 止损限价：触发后才按 `price` 限价撮合，**触发前严禁入盘口**（防止无视触发价被提前成交） |
| `fok` | Fill-or-Kill：按限价立即撮合，必须全部成交否则整体撤销并回滚对手方 |
| `ioc` | Immediate-or-Cancel：按限价立即撮合，成交部分（订单落库状态为 `partial`，Phase 13 修复：原实现部分成交谎报 `filled`）、剩余撤销 |
| `iceberg` | 冰山单：`quantity` 为总量、`displayQty` 为盘口显示量，显示量吃尽后同价队尾补量 |

**side**：`buy/sell/short/cover`；CN 禁 `short/cover`（返回 `{success:false,error:'A股模式不支持做空/融券'}`）；CN 为 T+1（当日买入次日可卖）。

**市场闸门顺序**（业务拒绝均为 HTTP 200 + `{success:false,error}`，校验失败为 400 异常）：
休市拒单 → CN 集合竞价 9:25-9:30 撮合中禁申报 → 跨市场禁（symbol 前缀须与 mode 一致）→ **盘后固定价格交易**（CN 15:00-15:30：仅 `limit` 且 `price` 必须等于当日收盘价，见 §11）→ 购买力校验（买入：估算成本 ≤ `cash × leverage`）→ 做空保证金/券源 → 持仓/T+1 → CN 委托价涨跌停带宽（昨收基准 ±10%，新股首日 +44%/-36%）。

**返回**：
- `market`/`fok`/`ioc` 立即成交：`{success, fill:{symbol,side,quantity,price,totalCost,fees}, fees}`（HTTP 成交对象为 quantity/price 命名）
- `limit`/`stop`/`stop-limit`/`iceberg`：`{success, order:{id,status,quantity,filledQty,avgFillPrice,triggerLog,displayQty,hiddenQty,postClose,...}}`
- 幂等命中：`{success:true, order:{...既有订单}, duplicate:true}`
- 拒绝：`{success:false, error}`（HTTP 200）

### DELETE /trading/order/:id?mode=US — 撤单
仅 PENDING 挂单可撤（`postClose:true` 的盘后单从独立队列移除）；找不到返回 `{success:false}`。CN 集合竞价 9:20-9:25（申报锁定）与 9:25-9:30（撮合中）禁撤单（400）。

### GET /trading/orders/pending?mode=US — 未成交挂单
本账户全部 PENDING 列表（含盘后单 `postClose:true`）。

### GET /trading/history?mode=US — 成交历史
本账户最近 100 条交割单（Transaction[] 同 §3 transactions 格式）。

### 资金/成交规则说明（真杠杆口径）
- 购买力 = `cash × leverage`（1~3x）；买入时自有资金 = 总额/杠杆，借入部分记入 `borrowed` 负债
- 卖出按持仓负债比例偿还 `borrowed`；日终按 `borrowed + shortCollateral` 计息（0.02%/日）
- 维持担保比 = 总权益/借入：**<1.4 预警、<1.3 追保（部分平仓至 1.5）、<1.2 全仓强平**（日终结算后统一检查）
- 做空保证金率按个股 0.5~0.65 动态（波动率上浮）；做空借券扣券源池

---

## 5. 行情（全部**无需 token**；`/backtest` 限流 20 次/分/IP）

### GET /market/prices — 全部最新价
`{"T1":45.3,"T2":120.49,"H001":88.2,"U001":101.5,...}`（三市场合并）。

### GET /market/stocks — 全市场股票列表
三市场合并；元素含 `symbol/market/name/code/listDate/description/industry/price/changePct/dayOpen/dayHigh/dayLow/dayVolume/adjFactor/adjustmentSeries`。

### GET /market/indices — 大盘指数（市值加权+除数法）
`[{code,name,value,changePct,members}, ...]`

### GET /market/state — 市场状态（三市场）
```json
{
  "tickIntervalMs": 60000, "offHoursTrading": false,
  "markets": {
    "CN": { "gameDay": 12, "tickCount": 87, "marketRegime": "bull", "factors": {...}, "hotTopics": [],
      "macroHistory": [...], "industryCycles": {...}, "fxRates": {...},
      "isTradingTime": true, "isPostCloseTrading": false },
    "HK": {...}, "US": {...}
  }
}
```
`isPostCloseTrading`=true 表示 CN 盘后固定价格交易窗口（15:00-15:30，仅限价单且价格=收盘价）。

### GET /market/reports?symbol=T1 — 财报披露（惊喜分级 + 一致预期）

### GET /market/ai-opponents — AI 对手盘（按 pnlPct 排序）

10 个具名对手盘（机构/游资/散户 × 趋势/均值回归/动量/羊群/反转/噪声策略）+ 本地随机森林，零外部 API。
`[{id,name,type,strategy,strategyName,taunt,equity,pnlPct,winRate,trades,tier,score,positions,equityHistory,adaptive}]`

Phase F 新增 `adaptive` 字段（**只给聚合档位，不暴露 takeProfit/stopLoss 等裸参数**，防玩家反推套利）：

```json
{ "enabled": true, "regime": "bull", "regimeLabel": "多头市",
  "vol": "normal", "volLabel": "常态波动",
  "level": "aggressive", "activityMul": 1.18, "scaleMul": 1.09 }
```

- `enabled`：AI 自适应总开关（后端 `AI_ADAPTIVE_ENABLED=false` 时为 false → 参数保持默认）
- `regime`：市场状态 `bull|bear|sideways`（与行情引擎同一来源，日终切换）；`vol`：波动档 `low|normal|high`（按最近 tick 全市场平均 |涨跌幅| 与波动率聚合）
- `level`：心态档位 `aggressive`（活跃度 ≥1.15）/`normal`/`cautious`（≤0.85）
- `activityMul` / `scaleMul`：参与率与单笔规模乘数（钳制带 `[0.5,1.5]` / `[0.6,1.4]`）

> 自适应口径（团队定稿）：每 5 游戏日在日终按「近 5 日自身收益/胜率/回撤」平滑调参（表现差 → 更保守：活跃/规模/止盈/羊群下调、止损收紧），
> 并叠加市场状态系数（高波动档禁止任何更激进的系数，止损只放宽不收紧）。参数与绩效全内存、重启复位；
> 现金/持仓/挂单预算的账本闸门为硬约束，不参与参数化。

### GET /market/flow-signals?symbol=T1 — 资金流信号（OFI + 大单）

### GET /market/klines?symbol=T1&timeframe=1min — K线历史
timeframe: `1min`（默认）/ `5min` / `60min` / `daily` / `weekly` / `monthly`。
`[{time, open, high, low, close, volume}]`

### GET /market/orderbook?symbol=T1 — 盘口
`{asks:[{price,size}], bids:[{price,size}], spread}`（合成深度+真实挂单 ≤10 档合并显示）。

### GET /market/backtest?symbol=T1&strategy=ma_cross&fast=5&slow=20&timeframe=1min&slippageBps=0&period=14&momentumN=10 — 策略回测（20 次/分/IP）
- strategy: `ma_cross`（MA金叉/死叉，参数 fast/slow）/ `rsi_reversal`（RSI超卖30买超买70卖，参数 period）/ `momentum`（N日动量转正买转负卖，参数 momentumN）；非法值回退 `ma_cross`
- slippageBps: 单边滑点基点，0=按市场默认（A股·港股 5bp / 美股 3bp）
- 手续费与实盘同口径（佣金最低/印花税/征费），基准=买入持有
```json
{ "symbol":"T1","timeframe":"1min","strategy":"ma_cross","feeMode":"CN","slippageBps":5,
  "bars":720,"initialCash":100000,"finalEquity":102350.11,"totalReturn":2.35,"annualizedReturn":41.2,
  "maxDrawdown":3.4,"sharpe":1.25,"profitFactor":1.8,"trades":6,"winRate":66.7,"fees":156.2,
  "slippageCost":43.5,"benchmarkReturn":1.1,"equityCurve":[...],"equityCurveBench":[...] }
```
> CLI 版：`node backend/scripts/backtest.js T1 rsi_reversal 14 60min`（策略/参数/周期）

---

## 6. 基金（列表公开；申购/赎回需 token）

### GET /fund（公开）/ GET /fund/:id（公开）
```json
[{ "id":"fund-1","name":"沪深300 ETF","type":"ETF","nav":4.5,"dailyReturn":0.001,"subscribeFeeRate":0.0015 },
 { "id":"fund-2","name":"货币基金 A","type":"货币基金","nav":1.0,"dailyReturn":0.0001,"subscribeFeeRate":0 }]
```

### POST /fund/:id/subscribe?amount=1000&mode=CN（**参数在 Query**，需 token）
申购费：ETF 0.15% / 货基 0；份额按扣费后净额计算。返回 `{success, shares, nav, fee}`；余额不足/赛季报名中/未知基金 → `{success:false,error}`。NAV 以 CNY 计价，非 CN 账户按实时汇率折算。

### POST /fund/:id/redeem?shares=100&mode=CN（需 token）
赎回费按持有游戏日三档：**<7 日 1.5% / 7-30 日 0.5% / ≥30 日 0**。返回 `{success, amount, nav, holdDays, feeRate}`。

---

## 7. 赛季（模拟大赛 V2，全部需 token）

快照净值赛；报名即三市场同时参赛（首个报名者触发开赛，anchorDay 定格）；赛季自动结算并轮换开新赛季。
**赛季类型轮换**（Phase E）：`biweekly` 双周赛 10 游戏日 → `monthly` 月赛 20 游戏日 → `weekly` 周赛 5 游戏日，循环。

### POST /season/enroll — 报名
成功 `{success, season:{id,seq,name,type,status,anchorDay,durationDays}, entries[], created}`；重复报名/已开赛 → `{success:false,error:'当前赛季已开赛，报名已截止'}`。

### GET /season/current — 我的状态
`{season:{id,seq,name,type,status,anchorDay,durationDays,daysLeft}, enrolled, myReturn, myRank}`

### GET /season/leaderboard?market=ALL&limit=20 — 赛季榜
合成收益率口径（Σ净值-Σ起点）/Σ起点（本金差异免疫）；market=ALL|CN|HK|US，limit 1~100。返回 `[{userId, seasonReturn, seasonPnl}]`（此表返回 userId 原值，与 /ranking 的脱敏口径不同）。

### GET /season/history — 已结算赛季（最近 5 届）
`[{seq,name,type,settledAt,champions[]}]`

### GET /season/schedule?count=6 — 赛程日历（Phase E）
当前赛季（enrolling/running）+ 合成未来届（不落库；`startDay` 为相对今日的游戏日偏移，**估算值**，快档下游戏日与真实日历解耦）。返回 `{today:{CN,HK,US}, seasons:[{seq,name,type,status,startDay,durationDays,daysLeft,anchorDay?}]}`，count 钳制 1~100。

### GET /season/archive/:seasonId — 战绩档案（Phase E）
已结算赛季：`{success, season:{seq,name,type,settledAt,entriesCount,champion}, mine:{rank,ret,medal,points,curve,entries}|null, championCurve}`。curve 为**两点最小口径**（报名起点→结算终点；逐日净值需赛季快照结构升级，裁到 V3）。未结算/不存在 → `{success:false,error:'赛季不存在或未结算'}`。

### GET /season/points?limit=20 — 赛季积分榜（Phase E）
`[{rank, userId, points, consecutiveWins}]`。points 为**用户级口径 = max(该用户各市场账户 seasonPoints)**（三市场账户同额记账为 V1 兼容语义，sum 会把单场胜利 ×3 失真）；consecutiveWins = 从最近一届往回数连续冠军届数（未参赛届跳过）。

### 赛季积分说明（Phase E 拆列）
- `seasonPoints`：荣誉积分，仅赛季结算前三名 +300/200/100 累加（该用户全部市场账户同额）
- `tierScore`：段位分，由日终 computeTier 按绩效公式**覆盖**（两列互不隐式互算）

**赛季冻结**：赛季 RUNNING 中、有 ACTIVE 报名的用户——账户重置、跨市场划转、基金申购/赎回全部关闭（返回 `{success:false,error}`）。

---

## 8. 排行与管理（需 token；管理端点需 ADMIN role，否则 403）

### GET /ranking?limit=&sort=totalReturn&market=ALL — 全服排行榜
sort: `totalReturn|dayReturn|equity`（`equity`＝按**总权益 `totalEquity`** 排序，Phase 13 修复：原实现取不到该字段导致退化为 totalReturn 序）；limit 1~50。输出 `{market, tier, username(脱敏:前2字符+*), totalEquity, totalReturn, dayReturn, rank}`——**无 userId**。每 30s + 启动 10s 后重算缓存。

### GET /admin/stats、GET /admin/users?page&limit — 管理统计/用户列表（ADMIN）

### POST /admin/users/:id/toggle — 禁用/启用用户（ADMIN）
Body `{"isActive": false}`。禁自己/最后一个活跃管理员 400，目标不存在 404。**禁用后：HTTP 下一请求 401，WS 握手立即断开（§9）**。

### GET /admin/debug、POST /admin/debug、POST /admin/debug/global — 调试模式（ADMIN）
调试模式（休市期行情/下单，仅开启它的管理员 bypass）+ 全服休市交易开关。Body `{"on": true|false}`。

---

## 9. WebSocket 实时流

地址: `ws://host:8000/market`（命名空间 /market，socket.io 握手路径 /socket.io）

**认证（必填）**：handshake auth 携带 JWT；缺 token / 载荷无效 / **用户不存在或被禁用（isActive=false）** → 服务端立即断开。

**连接数上限（REFACTOR-5）**：每用户最多 **5** 条并发连接。超限时服务端拒绝**新连接**：先 `emit('error', {message:'连接数超限'})` 再断开（在线人数与既有连接不受影响；断开后名额立即释放，可重连）。多标签页/多设备正常使用够用；若前端存在"切页重连但旧连接未及时回收"的模式，撞上限即表现为第 6 个连接被拒。

```js
import { io } from 'socket.io-client';
const socket = io('/market', {
  transports: ['websocket'],
  auth: { token: '登录接口返回的 token' },
});
```

**事件**：
- `tick`：行情推送 `{ticks:[{symbol,price,volume,timestamp}], timestamp}`（三市场 tick 合并推送）
- `fill`：成交推送 `{symbol, side, filledQuantity, avgPrice, totalCost, fees, counterFills:[{side,price,qty,virtual}]}`——counterFills 为**脱敏后**形态（只含展示字段，不含对手方账户/订单标识）
- `news`：新闻 `{title, description, type:bullish|bearish|neutral|insider|night, impact, duration}`（部分新闻带 targetedSymbol）

---

## 10. 量化接入示例

**Node.js**（完整策略示例见 `backend/scripts/quant-bot.js`）：

```js
// 1. 登录拿 token（返回体含 user+token）
const { token } = await api('POST', '/auth/login', { username, password });

// 2. 拉全市场 + K 线算指标
const stocks = await api('GET', '/market/stocks');           // 无需 token
for (const s of stocks) {
  const k = await api('GET', `/market/klines?symbol=${s.symbol}&timeframe=1min`);
  const closes = k.map(x => Number(x.close));
  // ... 计算 MA/RSI/布林 等，产生买卖信号
}

// 3. 下单（三市场 mode=CN/HK/US）
await api('POST', '/trading/order?mode=CN', { symbol: 'T1', type: 'limit', side: 'buy', quantity: 100, price: 45.0 }, token);

// 4. 撤单（DELETE）
await api('DELETE', '/trading/order/<orderId>?mode=CN', null, token);

// 5. 读持仓/资金，管理风险
const acct = await api('GET', '/account?mode=CN', null, token);
```

**Python**（依赖 `requests`）：

```python
import requests
BASE = 'http://localhost:8000/api'
login = requests.post(f'{BASE}/auth/login', json={'username': 'Bobbychina', 'password': '...'}).json()
H = {'Authorization': f"Bearer {login['token']}"}
stocks = requests.get(f'{BASE}/market/stocks').json()                    # 行情公开，无需认证
r = requests.post(f'{BASE}/trading/order', params={'mode': 'US'}, headers=H,
                  json={'symbol': 'U001', 'type': 'limit', 'side': 'buy', 'quantity': 100, 'price': 101.5})
pending = requests.get(f'{BASE}/trading/orders/pending', params={'mode': 'US'}, headers=H).json()
history = requests.get(f'{BASE}/trading/history', params={'mode': 'US'}, headers=H).json()
```

---

## 11. 通用规则速查（给量化 AI）

- **红涨绿跌**（A 股惯例）：`changePct > 0` 为涨
- **费率**（代码单一来源 `constants/index.ts`）：
  - CN：佣金 0.025%（最低 5）+ 卖出印花税 0.1% + 过户费 0.002%；T+1；不可做空；涨跌停 ±10%
  - HK：佣金 0.03%（最低 50）+ 卖出印花税 0.13% + 交易费 0.005% + 交易征费 0.0027%；无涨跌停；可做空；T+0
  - US：SEC 费 0.00229% + TAF 费 $0.000119/股；可做空；T+0；无涨跌停
- **A股涨跌停**：基准=昨收（涨停价=昨收×1.1 全天固定）；新股首日 **+44%/-36%**（发行价口径）；委托价越界 400
- **红利税二档**：CN 持有 ≤7 交易日 20%、>7 交易日 0%；HK 统一 20%；US 统一 30%（分红流水记税后净额）
- **真杠杆**：购买力 = cash × leverage（1~3x，POST /account/leverage 设置）；borrowed 负债日终计息 0.02%/日；维持担保比 <1.4 预警 / <1.3 追保至 1.5 / <1.2 全仓强平
- **盘后固定价格交易**（仅 CN 15:00-15:30）：仅限价单、价格必须=当日收盘价；同价时间优先撮合；15:30 未成交自动撤销（rejectReason）；`state.isPostCloseTrading` 标记窗口
- **集合竞价**（仅 CN 9:15-9:30）：9:15-9:20 可申报可撤 / 9:20-9:25 可申报不可撤 / 9:25-9:30 撮合中禁申报
- **交易时段**：按本地时钟+节假日历判断（CN 9:30-11:30/13:00-15:00；HK 9:30-12:00/13:00-16:00；US 按美东时段含夏令时）；休市下单被拒（管理员调试模式除外）
- **跨市场划转**：动态汇率（HK/US 逐日 ±3% 随机游走）+ 0.1% 手续费；赛季报名中禁划转
- **重置**：需无持仓/无基金份额/无挂单 + 冷却 1 游戏日；RESET_ENABLED=false（大赛中）与赛季报名中禁重置
- **赛季**：类型轮换（双周10日/月赛20日/周赛5日）；赛季中已报名账户禁重置/划转/基金；前三名 seasonPoints +300/200/100（与段位 tierScore 分离）
- **基金净值**：内存实时刷新（只涨不跌：`nav += nav × dailyReturn × rand[0,2)`，每 60s），并落库 `fund_navs`（重启后回填，不再复位到初值）
- **服务端配置**：`DB_SYNCHRONIZE`（默认 `true`）控制 TypeORM 自动同步表结构，生产建议 `false` + 自建表/迁移（开启时启动打 WARN）；`TRUST_PROXY` 影响登录锁定计数键；`TICK_INTERVAL_MS < 60000` 需同时 `SANDBOX_FAST=true` 才允许启动
- 模拟世界：宏观因子（宏观经济/行业景气/市场情绪/政策风险等）受股票表现反馈影响，新闻定向冲击个股/行业——策略可结合 `news` 事件与 `/market/flow-signals` 资金流信号

---

## 12. 附录：文档与实现一致性

`backend/test/phase10-api-doc-routes.test.js` 对本文件做静态抽查：实现中存在的全部路由（§1-§9 的 MUST_HAVE 清单）必须出现在本文档中，旧版文档中的漂移写法（撤单的 POST cancel 形式、历史单的 orders/history 路径）不得残留。新增/修改端点时，请同步更新本文档与测试清单，否则 CI 红。
