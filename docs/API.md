# StockSim Pro — API 文档（量化/AI 接入指南）

模拟炒股平台的完整 HTTP + WebSocket 接口。任意语言/独立 AI 均可通过本 API 获取行情、执行交易、读取账户。

- Base URL: `http://localhost:8000/api`
- 认证: 登录返回 `token`，后续请求带 `Authorization: Bearer <token>`
- 模式: 路径参数 `mode` = `US`（美股 T+0，可做空）/ `CN`（A股 T+1，不可做空）

---

## 1. 认证

### POST /auth/login
```json
{ "username": "Bobbychina", "password": "ThisIsTheBestProjectEver" }
```
返回：`{ "token": "..." }`

---

## 2. 行情数据（只读，无需 token）

### GET /market/stocks — 全市场股票列表
返回 `Stock[]`：
```json
[{
  "symbol": "T1",
  "name": "芯澜半导体",
  "code": "688001",
  "listDate": "2019-08-12",
  "description": "专注 AI 推理芯片...",
  "industry": "半导体",
  "price": 45.30,
  "changePct": 0.93,
  "dayOpen": 44.90,
  "dayHigh": 45.80,
  "dayLow": 44.50,
  "dayVolume": 54321
}]
```

### GET /market/indices — 大盘指数
```json
[{ "code": "000001", "name": "上证指数", "value": 3123.45, "changePct": 0.76, "members": 28 },
 { "code": "399001", "name": "深证成指", "value": 10580.12, "changePct": 0.55, "members": 12 },
 ...]
```

### GET /market/klines?symbol=T1&timeframe=1min — K线历史
- timeframe: `1min` / `5min` / `daily`
- 返回 `Kline[]`：
```json
[{ "time": "2024-01-04T01:30:00.000Z", "open": 45.1, "high": 45.3, "low": 44.9, "close": 45.2, "volume": 1200 }]
```

### GET /market/orderbook?symbol=T1 — 盘口
```json
{ "asks": [{ "price": 45.35, "size": 600 }], "bids": [{ "price": 45.25, "size": 500 }], "spread": 0.1 }
```

### GET /market/prices — 全部最新价
```json
{ "T1": 45.3, "T2": 120.49, ... }
```

---

## 3. 交易（需 token）

### POST /trading/order?mode=US
Body：
```json
{
  "symbol": "T1",
  "type": "market",          // market | limit | stop | stop-limit
  "side": "buy",             // buy | sell | short(仅US) | cover(仅US)
  "quantity": 100,
  "price": 45.5,             // 限价单必填
  "triggerPrice": 46.0       // 止损单必填
}
```
市价单立即返回：
```json
{ "success": true, "fill": { "symbol": "T1", "side": "buy", "quantity": 100, "price": 45.3, "fees": 1.35 } }
```
限价/止损单返回挂单信息（成交由引擎撮合，`quantity` 可能部分成交）。

### GET /trading/orders/pending?mode=US — 未成交挂单
```json
[{ "id": "...", "symbol": "T1", "side": "buy", "type": "limit", "quantity": 100, "price": 45.0, "status": "PENDING" }]
```

### GET /trading/orders/history?mode=US — 成交历史
```json
[{ "symbol": "T1", "side": "buy", "quantity": 100, "price": 45.3, "commission": 1.13, "stampDuty": 0, "totalFees": 1.13, "createdAt": "..." }]
```

### POST /trading/order/:id/cancel?mode=US — 撤单

### GET /account?mode=US — 账户与持仓
```json
{
  "account": { "cash": 88979.1, "leverage": 1, "dayStartEquity": 100000, "initialEquity": 100000, "shortCollateral": 0 },
  "positions": [{ "symbol": "T1", "longQty": 100, "shortQty": 0, "longCost": 45.3, "boughtToday": 100 }]
}
```

---

## 4. WebSocket 实时流

地址: `ws://localhost:8000/market`（需 token query 或连接后认证）

事件：
- `tick`：每 1 秒推送一次行情
  ```json
  { "type": "tick", "data": [{ "symbol": "T1", "price": 45.31, "volume": 120, "timestamp": 12 }] }
  ```
- `news`：新闻事件（含 `type` bullish/bearish/neutral/insider、`impact`、`targetedSymbol`）
- `fill`：成交推送

---

## 5. 量化接入示例

**Node.js**（完整策略示例见 `backend/scripts/quant-bot.js`）：

```js
// 1. 登录拿 token
const token = (await api('POST', '/auth/login', { username, password })).token;

// 2. 拉全市场 + K 线算指标
const stocks = await api('GET', '/market/stocks');
for (const s of stocks) {
  const k = await api('GET', `/market/klines?symbol=${s.symbol}&timeframe=1min`);
  const closes = k.map(x => Number(x.close));
  // ... 计算 MA/RSI/布林 等，产生买卖信号
}

// 3. 下单
await api('POST', '/trading/order?mode=US', { symbol: 'T1', type: 'market', side: 'buy', quantity: 100 }, token);

// 4. 读持仓/资金，管理风险
const acct = await api('GET', '/account?mode=US', null, token);
```

**Python**（依赖 `requests`）：

```python
import requests
BASE = 'http://localhost:8000/api'
token = requests.post(f'{BASE}/auth/login', json={'username': 'Bobbychina', 'password': '...'}).json()['token']
H = {'Authorization': f'Bearer {token}'}
stocks = requests.get(f'{BASE}/market/stocks', headers=H).json()
klines = requests.get(f'{BASE}/market/klines?symbol=T1&timeframe=5min', headers=H).json()
r = requests.post(f'{BASE}/trading/order?mode=US', headers=H,
                  json={'symbol': 'T1', 'type': 'market', 'side': 'buy', 'quantity': 100})
```

---

## 6. 要点提示（给量化 AI）

- **红涨绿跌**（A 股惯例）：`changePct > 0` 为涨
- 限价/止损单由引擎逐 tick 撮合，成交会推送 `fill` 事件，或轮询 `pending` 判断状态
- 挂单撤单后 `rejectReason` 字段记录原因（如资金不足、T+1 限制）
- `dayStartEquity` 是当日初始权益，用于计算当日盈亏
- 模拟世界：宏观因子（宏观经济/行业景气/市场情绪/政策风险等）会受股票表现反馈影响，新闻会定向冲击个股/行业——策略可结合新闻事件
