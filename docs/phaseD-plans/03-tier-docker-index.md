# Phase D 方案 03：Dockerfile 修复 + 索引/批量化 + 段位数据驱动

> 方案设计师：AI（Phase D 方案组）｜预计实施 45–70 分钟
> 覆盖任务③（Docker 修复）/ 任务④（索引与 checkPendingOrders 批量化）/ 任务⑤（computeTier 数据驱动销债）/ 任务⑥（phase10 测试设计清单，用例主体由主 agent 编写）。
> 所有改动依据均为源码实读，引用格式 `文件:行号`（backend/src 下路径省略前缀 `backend/src/`）。

---

## 0. 结论速览

| 任务 | 结论 | 必改文件 |
|---|---|---|
| ③ Docker | Dockerfile.backend 缺 lockfile、CMD 路径错；新增 frontend/Dockerfile + frontend/nginx.conf + backend/docker/docker-compose.yml + 两个 .dockerignore | 5 个新/改文件 |
| ④ 索引 | 三个实体类装饰块各追加 1 条 `Index`（编译风格）；positions 的索引与 Unique 左前缀冗余（按任务仍加，注明理由） | order/transaction/position.entity.ts 各 1 处 |
| ④ 批量化 | checkPendingOrders：预扫 willFill → 一次 `In` 查账户建 Map → 循环内取 Map + dirty 单查刷新；**仓库无 compareAndSwap 符号**（全仓 grep 0 命中），"数据新鲜"由 dirty 机制保证 | trading-engine.service.ts |
| ⑤ 段位 | 新权重 30/20/20/20/10；公式抽纯函数模块 `tier.ts`；回撤沿用 `peakEquity`（**否决** snapshot 批量方案，理由见 §4.6）；流水一次批量拉取 + JS 分组截断 500；注入 txRepo | 新建 tier.ts；risk-manager.service/module.ts；risk-manager.test.js |
| ⑥ 测试 | 4 组用例 + 存量测试两处改造（risk-manager.test.js、phase2/phase7 fakeRepo 支持 In） | 新建 phase10 测试文件 |

现有 217 例基线：`npm run build && npm test`（jest.config.js:4 `test/**/*.test.js`，测试引用 dist 产物）。本方案不触碰任何既有运行时语义，**回归风险集中在测试辅助函数与 risk-manager.test.js 两个 describe**（§6）。

---

## 1. 任务③ Dockerfile 修复与容器化（compose + frontend Dockerfile）

### 1.1 实读依据（三处坏的确认）

| 问题 | 依据 |
|---|---|
| `npm ci` 缺 lockfile | `backend/docker/Dockerfile.backend:6` 只 COPY `package.json tsconfig.json`，第 7 行 `npm ci` 会因无 lock 失败；`backend/package-lock.json` 已存在（目录实读） |
| CMD 产物路径错 | `backend/package.json:7` `start = node dist/src/main.js`；`tsconfig.json:8-9` `rootDir="." outDir=dist` → 产物在 `dist/src/main.js`，而 Dockerfile.backend:27 写 `CMD ["node","dist/main"]`（两阶段都是 `npm ci`，runner 阶段 19-20 行同样缺 lockfile） |
| 无数据卷 / 无 .env | Dockerfile 不应负责，由 compose 提供（§1.5） |

运行目录事实：`app.module.ts:50-53` envFilePath=`.env`（相对进程 CWD）；`main.ts:71` `PORT` 默认 8000；`main.ts:92` + `app.module.ts:84` `SQLITE_PATH` 默认 `./data/stockgame.db`（相对 CWD）；后端 CWD=`/app`（Dockerfile WORKDIR）→ **SQLite 卷必须挂 `/app/data`**。Compose 文件位于 `backend/docker/`，故：
- build context：`..` = `backend/`，dockerfile `docker/Dockerfile.backend`（与 Dockerfile.backend:6-9 的 COPY 路径是 backend 相对路径吻合）；
- env_file：`../.env` = `backend/.env`（backend/.env 已存在，键含 PORT/JWT_*/ADMIN_*；**不含 DB_TYPE/SQLITE_PATH → 容器内走默认 better-sqlite3 + ./data/stockgame.db**，正好与卷路径一致）；
- frontend context：`backend/docker/../..` = 仓库根，dockerfile `frontend/Dockerfile`（任务指定路径；注意旧 `infra/docker-compose.yml:61` 引用的是不存在的 `frontend/docker/Dockerfile.frontend`，见 §6-9）。

前端事实（决定 nginx 反代路径）：`frontend/vite.config.ts:12-24` dev proxy 为 `/api`（ws 无关）与 `/socket.io`（ws:true），无 base 配置（默认 `/`，产物按根路径引用，nginx SPA fallback 直接可用）；`frontend/src/services/api.client.ts:3` 全部 API `baseURL='/api'`（同源相对）；`frontend/src/services/ws.client.ts:10-11` `io('/market',{transports:['websocket']})` → nginx 必须给 `/socket.io/` 配 Upgrade 头（注释 9 行明言"生产走 nginx 代理 /socket.io"）。前端 build 脚本 `tsc -b && vite build`（frontend/package.json:9），vite 5 / react 18。

### 1.2 改动清单与文件全文

**① backend/docker/Dockerfile.backend（修改，全文）**

```dockerfile
# ─── 构建阶段 ───
FROM node:22-alpine AS builder

WORKDIR /app

# Phase D 修复①：npm ci 必须有 package-lock.json（原缺导致 ci 报错）
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ─── 运行阶段 ───
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache tini

# runner 阶段 npm ci --omit=dev 同样需要 lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

EXPOSE 8000

ENTRYPOINT ["/sbin/tini", "--"]
# Phase D 修复②：tsconfig rootDir="." → 产物在 dist/src/，见 package.json start 脚本
CMD ["node", "dist/src/main.js"]
```

（数据卷与 .env 由 compose 注入，Dockerfile 不承担——见 §1.5。）

**② frontend/Dockerfile（新增，全文）**

```dockerfile
# ─── 构建阶段：与 package.json build 一致（tsc -b && vite build）───
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# tsconfig 工程引用（tsc -b 需要 tsconfig.node.json 等），.dockerignore 已排除 node_modules/dist
COPY . .
RUN npm run build

# ─── 运行阶段：nginx 托管静态产物（SPA fallback + /api + /socket.io 反代见 nginx.conf）───
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

**③ frontend/nginx.conf（新增，全文）**

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;
    gzip_min_length 1000;

    # API 反代（vite.config dev proxy /api → 与生产行为一致）
    location /api/ {
        proxy_pass http://backend:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Socket.IO 反代：ws.client 只走 websocket transport，必须带 Upgrade 头
    location /socket.io/ {
        proxy_pass http://backend:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s; # WS 长连接
    }

    # SPA fallback（vite 无 base 配置，产物根路径引用）
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**④ backend/docker/docker-compose.yml（新增，全文）**

```yaml
# Phase D 修复③：数据卷 + .env 注入 + healthcheck + restart（后端 Dockerfile 不承担这些）
# 用法：docker compose -f backend/docker/docker-compose.yml up -d --build
services:
  backend:
    build:
      context: ..          # = backend/（与 Dockerfile 内 COPY 相对路径一致）
      dockerfile: docker/Dockerfile.backend
    container_name: sgp-backend
    restart: unless-stopped
    env_file:
      - ../.env            # = backend/.env（PORT/JWT/ADMIN；无 DB_TYPE/SQLITE_PATH → 默认 sqlite ./data/stockgame.db）
    environment:
      - TRUST_PROXY=1      # 前面有 nginx 反代：限流/日志需真实客户端 IP（main.ts:66）
    ports:
      - "8000:8000"
    volumes:
      # SQLITE_PATH 默认 ./data/stockgame.db，后端 CWD=/app → 挂 /app/data
      - sgp-data:/app/data
      # 想直接复用本机开发库（E:\...\backend\data）时改用：
      # - ../data:/app/data
    healthcheck:
      # /api/docs 为 Swagger 静态页，无需鉴权（main.ts:81）
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8000/api/docs", "||", "exit", "1"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s

  frontend:
    build:
      context: ../../frontend   # backend/docker 上溯两级 = 仓库根/frontend
      dockerfile: Dockerfile    # frontend/Dockerfile
    container_name: sgp-frontend
    restart: unless-stopped
    ports:
      - "3000:80"
    depends_on:
      backend:
        condition: service_healthy

volumes:
  sgp-data:
```

> 说明：默认命名卷 `sgp-data` 冷启动为空库（main.ts autoSeed 只建股票池，无用户），首次注册账号即可用；与开发机 `backend/data` 物理隔离，避免 WAL 双开。绑定挂载方案以注释保留（复用现有 18 账户开发库）。

**⑤ backend/.dockerignore 与 frontend/.dockerignore（新增）**

```
# backend/.dockerignore（构建上下文 = backend/，当前无任何 .dockerignore，会把 node_modules/dist 全量发进 daemon）
node_modules
dist
dist.bak
data
data.bak
test
tools
scripts
.env
*.log
```

```
# frontend/.dockerignore
node_modules
dist
tools
.env*
```

### 1.3 冒烟验证点（实施后）

`docker compose -f backend/docker/docker-compose.yml up -d --build` → `docker compose ps` 两容器 healthy → `curl http://localhost:3000` 返回 index.html；`curl http://localhost:3000/api/market/prices` 有 JSON；浏览器开 `http://localhost:3000` 登录后实时行情走 WS（`/socket.io/market` upgrade）。本机 Docker Desktop 挂载与端口占用是唯一常见坑。

---

## 2. 任务④ 实体索引（orders/transactions/positions）

### 2.1 实读依据与语法确认

- 三个实体均为编译风格 TS：文件头手写 `__decorate`/`__metadata` 辅助 + `import typeorm_1 = require("typeorm")`（order.entity.ts:1-14、transaction.entity.ts:1-10、position.entity.ts:1-12），类无构造器 → **不需要 design:paramtypes**。
- `@Index` 类级数组写法在 typeorm 0.3.20 可用且有**同仓先例**：daily-snapshot.entity.ts:44-45 `[(0, typeorm_1.Entity)('daily_snapshots'), (0, typeorm_1.Index)(['userId','day'])]`，实库已生成 `IDX_17cff2bc21bf31717cbef4603a`（sqlite_master 实查），证明同步迁移链路（app.module.ts:86 `synchronize: true`）可用。三个新索引同样由 synchronize 在下次启动自动 `CREATE INDEX`，无需手写迁移 SQL。
- 表现状（实查 data/stockgame.db sqlite_master）：orders/transactions/positions 均无业务索引（仅 `sqlite_autoindex_*`）。orders 主查询 `checkPendingOrders`（见 §3）条件是 `status+type`（trading-engine.service.ts:579-585，**没有 accountId 条件，不会用到 (accountId,status) 索引**）——该索引服务的是账户维查询（getPendingOrders:1073-1077、账户重置查挂单 account.service.ts:165、订单历史页）。这是有意的范围界定，见 §3.4 P2 清单。
- **冗余提示**：positions 已有 `Unique(['accountId','symbol'])`（position.entity.ts:64），SQLite 唯一索引 (accountId,symbol) 左前缀已可加速 `accountId=` 查询；按任务要求仍补 `Index(['accountId'])`——行数 = 持仓数，写入成本可忽略，且若未来去掉 Unique 不丢索引，保留无害。

### 2.2 精确改动（import 无需新增：`typeorm_1` 已存在；仅改类底部装饰块）

**① order.entity.ts:131-136 → 改为**

```ts
Order = __decorate(
[
    (0, typeorm_1.Entity)('orders'),
    (0, typeorm_1.Index)(['accountId', 'status'])
],
Order
);
```

**② transaction.entity.ts:70-75 → 改为**

```ts
Transaction = __decorate(
[
    (0, typeorm_1.Entity)('transactions'),
    (0, typeorm_1.Index)(['accountId'])
],
Transaction
);
```

**③ position.entity.ts:61-67 → 改为**（保持 Unique 不动）

```ts
Position = __decorate(
[
    (0, typeorm_1.Entity)('positions'),
    (0, typeorm_1.Unique)(['accountId', 'symbol']),
    (0, typeorm_1.Index)(['accountId'])
],
Position
);
```

> 写法与 daily-snapshot 先例逐字同构（Index 追加在类装饰数组内，由文件底部 `__decorate` 块统一执行注册）。改动后 `npm run build` 通过即元数据有效；索引落库由 synchronize 首启完成。

---

## 3. 任务④ checkPendingOrders 批量化（N+1 → 批量 Map）

### 3.1 实读依据

- `checkPendingOrders` trading-engine.service.ts:578-712：一次全表 pending 查询（579-585）后逐单循环；每单 willFill 时 `const account = await this.accountRepo.findOne({ where: { id: order.accountId } })`（**648 行**）→ 一笔一查的 N+1（只对"将成交"订单发生）。
- 648 之后账户用途：a) 653 行 `validateOrder(order, account)` 二次校验；b) 662 行 `settleFill(..., account.marketMode)`；c) 666 行对手方结算。
- `settleFillInner` 473-577：**内部自读账户 476 行、资金/持仓复核 483-511、save 546**；返回值 572-576 **不含账户实体** → 结算成功后 Map 条目无法从返回值刷新，只能"标记脏 + 按需单查"。
- `settleCounterFills` 160-183：对手方也走 `settleFill`（172 行）→ 队列内 settleFillInner 自查，安全性与 Map 无关（§3.3）。
- 强平/其他路径互斥：结算全程串行队列（463-465 run = settlementQueue.then(...)），checkPendingOrders 本身在队列外跑，validate 是"预校验"，结算时才动钱——这是现有语义，批量化不得改变。

### 3.2 改动骨架（改动前后，编译风格 TS）

改动前（648 行区域，节选）：

```ts
                if (!fill) { /* … 重试/取消逻辑 646 行前省略 … */ }
                // 重新加载账户：资金/持仓可能在挂单期间已变化
                const account = await this.accountRepo.findOne({ where: { id: order.accountId } });
                if (!account) { continue; }
                const recheck = await this.validateOrder(order, account);
                /* … 653-708 结算/取消逻辑不变 … */
```

改动后（三处插入 + 一处替换；`typeorm_2.In` 可直接用已 import 的 `typeorm_2`，见文件头 17 行）：

```ts
    // Phase D：抽纯函数——现价是否将触发成交（预扫与执行共用同一判断，防两遍逻辑漂移）
    shouldFillNow(order, currentPrice) {
        if (order.type === order_entity_1.OrderType.LIMIT) {
            return (order.side === order_entity_1.OrderSide.BUY && currentPrice <= order.price) ||
                (order.side === order_entity_1.OrderSide.SELL && currentPrice >= order.price);
        }
        if (order.type === order_entity_1.OrderType.STOP) {
            return (order.side === order_entity_1.OrderSide.BUY && currentPrice >= order.triggerPrice) ||
                (order.side === order_entity_1.OrderSide.SELL && currentPrice <= order.triggerPrice);
        }
        if (order.type === order_entity_1.OrderType.STOP_LIMIT) {
            const triggered = (order.side === order_entity_1.OrderSide.BUY && currentPrice >= order.triggerPrice) ||
                (order.side === order_entity_1.OrderSide.SELL && currentPrice <= order.triggerPrice);
            if (!triggered) return false;
            return (order.side === order_entity_1.OrderSide.BUY && currentPrice <= order.price) ||
                (order.side === order_entity_1.OrderSide.SELL && currentPrice >= order.price);
        }
        return false;
    }

    async checkPendingOrders() {
        const pending = await this.orderRepo.find({ /* 原 580-584 三组 where 不动 */ });

        // ── Phase D 批量预载：按"当前价将成交"预扫，收集 accountId 一次 In 查询 ──
        const willFillAccountIds = new Set();
        for (const order of pending) {
            const p = this.prices.get(order.symbol);
            if (p === undefined || p === null) continue;
            const remaining = Number(order.quantity) - Number(order.filledQty || 0);
            if (remaining > 0 && this.shouldFillNow(order, p)) willFillAccountIds.add(order.accountId);
        }
        const accountsById = new Map(); // accountId -> 批量预载账户
        if (willFillAccountIds.size > 0) {
            const list = await this.accountRepo.find({ where: { id: (0, typeorm_2.In)([...willFillAccountIds]) } });
            for (const a of list) accountsById.set(a.id, a);
        }
        const dirtyAccountIds = new Set(); // 本轮已结算/触及过、Map 条目已过期的 accountId

        const fills = [];
        for (const order of pending) {
            /* … 原 589-646 判断与 executeMarketOrder(Limited) 逻辑逐字保留 … */
            if (!fill) { /* … 原样 … */ }
            // ── Phase D 替换 648 行 findOne：批量 Map 取值；脏条目在"下一次使用前"单查刷新 ──
            let account = accountsById.get(order.accountId);
            if (dirtyAccountIds.has(order.accountId) || !account) {
                account = await this.accountRepo.findOne({ where: { id: order.accountId } });
                if (account) { accountsById.set(order.accountId, account); dirtyAccountIds.delete(order.accountId); }
            }
            if (!account) continue;
            const recheck = await this.validateOrder(order, account);
            /* … 原 654-661 校验失败取消失败路径原样 … */
            const settle = await this.settleFill(order.accountId, order.symbol, order.side, fill, account.marketMode);
            if (settle.success) {
                // 本条账户资金/持仓已变：同账户若还有后续挂单，validateOrder 前必须重读（见 §3.3 时机论证）
                dirtyAccountIds.add(order.accountId);
                if (fill.counterFills && fill.counterFills.length > 0) {
                    await this.settleCounterFills(order.symbol, account.marketMode, fill.counterFills);
                    // 对手方账户同样作废 Map 条目（其结算走 settleFillInner 自查，此处只为预校验新鲜度）
                    for (const cf of fill.counterFills) dirtyAccountIds.add(cf.accountId);
                }
                /* … 原 668-684 订单实体回写原样 … */
            } else {
                /* … 原 685-707 结算失败回滚/止损重试逻辑原样（无需标脏：失败路径不改账户）… */
            }
        }
        return fills;
    }
```

### 3.3 设计论证（对应任务要求逐条）

1. **Map 条目刷新时机 = "下次使用前"（lazy dirty refresh），而非每单立即查**：settleFillInner 返回值不含账户（572-576）且其内部已自查+save（476/546），所以"结算后立刻刷新 Map"没有数据源；改为标记脏。同账户的下一笔挂单在 validateOrder 前触发一次 findOne（原 648 行同款查询），保证"资金/持仓变化对同账户后续订单可见"这一旧语义精确保留（旧实现每单都 findOne，新实现在"同账户连续多单"的最坏情况下仍每单一次——因为每单都结算、每单都标脏；**完全不同账户的常见情形从每单 1 查降为每轮 1 查**）。
2. **对手方条目过期为何安全**：settleCounterFills → settleFill → settlementQueue 内 settleFillInner 自读账户（476）并二次复核资金/持仓/T+1（483-511），对手方结算正确性不依赖 Map；Map 中过期对手方条目只影响"该对手方后面还有另一笔将成交挂单"时的 validateOrder 预校验——它是预校验，即使放行，结算仍会被 settleFillInner 兜底拒绝并走既有取消+对手单回滚路径（685-707），不会坏账。标脏只是减少这种无谓的失败。
3. **compareAndSwap 符号在仓库中不存在**：全仓 grep `compareAndSwap|CompareAndSwap|compare-and-swap|swap`（ts/md/js 全部）0 命中，`docs/CONCURRENCY.md` 亦无。对应你关注的点——"validateOrder 重校验前要保证数据新鲜"——即上文 dirty 机制的语义：**Map 条目只有两类状态：预载新鲜（未结算）与标记脏（结算后），validateOrder 只可能吃到预载条目或刚单查的条目，绝不可能是已结算但未刷新的账户**。若未来把订单执行拆成独立"compare-and-swap"原子步骤，此 Map 可直接复用为 CAS 的预取层。
4. 预扫与执行共用 `shouldFillNow`，价格用同一时刻 Map 读取；执行循环内的价格读取仍发生在逐单执行时（原语义），两遍只会因执行期间成交改变盘口导致 fill=null 分支（原有逻辑），不会跳过任何本应尝试的订单。

### 3.4 同类 N+1 排查（只列不改，Phase D 范围控制）

| 位置 | 模式 | 处置 |
|---|---|---|
| `getPendingOrders` trading-engine.service.ts:1073-1078 | 单账户一次 find，**不是 N+1** | 不动 |
| `forceLiquidateMarginalAccounts` 1304-1331 + `checkMarginLevel` 1079-1109 | 全账户循环，每账户 positionRepo.find（1080 行，含**无负债账户**的无效查询）；被强平账户进队列后 forceLiquidateInner 再重读 account+positions（1148/1151） | 列出；建议 P2：先只对 `borrowed>0 || shortCollateral>0` 账户估值；队列内重读是 F4 并发防御，保留 |
| `resetBoughtTodayInner` 142-151 | 全量 positions + 逐条 save | P3 批量 save |
| `validateOrder` 403-405 | 每单校验一次 positionRepo.findOne | 单笔 O(1)，不动 |
| `settleCounterFills`/`settleCounterFillsInner` 173/1125 | 每对手单一次 orderRepo.findOne | 对手单量小，不动 |
| `checkPendingOrders` 579-585 查询 | 无账户条件，新索引 (accountId,status) 覆盖不到 | P2：如挂单量增长，加 `(status, type)` 索引并评估批内分页 |

---

## 4. 任务⑤ 段位数据驱动（销 tech-debt）

### 4.1 实读依据（现状 = 主观公式）

- `computeTier(account)` risk-manager.service.ts:85-107：`retScore*0.4 + riskScore*0.3 + actScore*0.3`（94 行），回撤=peakEquity 口径（89-91），活跃=线性 `trades/50`（93），阈值表 95-103，写 `account.tier/tierScore`（105-106）。
- 调用链唯一入口：`settleAllAccounts` 155-170（162 行调 computeTier，163 行再 save）← market.service.ts:329（仅 CN 市场日终 tick 239，全局一次）。
- `settleAllAccounts` 现状：`accountRepo.find()`（156）→ 逐账户 `dailySettlement`（160）：内部 `getPositionsValue` → **每账户一次 positionRepo.find**（176 行）→ accountRepo.save（150）→ `recordDailyEquity` → snapshotRepo.save（63）+ 内存 equityHistory（46-56，>365 天 shift）；然后 computeTier + 第二次 accountRepo.save（163）。**全程不查交易流水**。
- 真实指标可用源：`perf.ts` `pairedMetrics`（5-82）输出 `pairedWinRate`（76，FIFO 配对）与 `profitFactor`（77，`grossLoss>0 ? grossWin/grossLoss : grossWin>0 ? Infinity : 0`）。UI 口径先例：account.service.ts:104-114 `getMetrics` 每账户 `find({where:{accountId}, order:{createdAt:'ASC'}, take:500})`（ASC 升序喂 pairedMetrics）。
- 快照维度陷阱：daily-snapshot.entity.ts:22-30 快照只有 `userId`（**无 accountId**）；ranking.service.ts:47-48 注释已指出"多市场账户同一天多条快照按 userId 串算会跨账户混算"。这是 §4.6 否决 snapshot 方案的决定性证据。

### 4.2 指标定义与打分公式（定稿）

新权重：**收益 30 / 最大回撤 20 / 盈亏因子 20 / 胜率 20 / 活跃 10**（合计 100）。

| 指标 | 定义/来源 | 归一化 → 0~100 | 满分/零分锚点 |
|---|---|---|---|
| 总收益 totalReturn | `(totalEquity - initialEquity)/initialEquity`（结算后口径） | `clamp01(totalReturn/0.5)*100` | ≥+50% → 100；≤0 → 0 |
| 最大回撤 maxDrawdown | `peak>0 ? max(0,(peak-totalEquity)/peak) : 0`，peak=account.peakEquity（日终结算时 145 行同步更新、持久化、重置归位 181 行） | `clamp01(1 - maxDrawdown/0.5)*100` | 0% → 100；≥50% → 0 |
| 盈亏因子 profitFactor | pairedMetrics 输出；Infinity=无亏损账户 | `pf===Infinity ? 100 : clamp01(pf/2)*100` | ≥2 → 100；0 → 0 |
| 胜率 winRate | pairedMetrics `pairedWinRate`（真实 FIFO 配对） | `clamp01(winRate)*100` **直乘** | 100% → 100；0 → 0 |
| 活跃 activity | account.totalTrades（含未配对成交，引擎 545 行累加） | `clamp01(log10(1+trades)/log10(51))*100` | ≥50 笔 → 100；0 → 0 |

权重合计：`tierScore = round(retScore*0.30 + ddScore*0.20 + pfScore*0.20 + wrScore*0.20 + actScore*0.10)`；段位阈值表保留（王者 92 / 大师 82 / 钻石 70 / 铂金 55 / 黄金 35 / 白银 15 / 青铜 0）。

**胜率为何不用 40% 基准**：基准会让"低胜率高盈亏比"的趋势交易选手在 wr 与 pf 双维度被重复惩罚（pf 已表达盈亏比）；直乘 0.5 胜率=50 分、口径线性可解释。若日后要调，把基准做成 tier.ts 常量即可（`WIN_RATE_BASELINE=0`，启用公式 `clamp01((wr-0.4)/0.6)*100`），属一行改动。

**空值语义（任务要求交代）**：0 流水账户（无任何成交）→ ret≈0 分、dd=0%（无回撤历史）得满分、pf=0、wr=0、act=0 → tierScore=20 → **白银**，与旧公式下同一账户的"白银 30 分"同段位 → 新账户段位展示无回归。无报价（currentPrices 空）时指标不依赖报价（峰值/流水口径），回撤与收益照常可用——比旧 getPositionsValue 估值路径更稳。

### 4.3 新建 `src/core/risk-manager/tier.ts`（纯函数，全文）

```ts
// Phase D 段位数据驱动（销 tech-debt）：权重与阈值单一来源，纯函数可单测、UI 可复用。
// 旧实现（risk-manager.service 85-107）主观 40/30/30 公式删除，改由本模块 + computeTier 委托。

// 权重（收益/回撤/盈亏因子/胜率/活跃，合计 1.0）
export const TIER_WEIGHTS = { totalReturn: 0.3, maxDrawdown: 0.2, profitFactor: 0.2, winRate: 0.2, activity: 0.1 };
// 归一化锚点：收益 50% 满分 / 回撤 50% 清零 / 盈亏因子 2 满分 / 活跃 50 笔满分
export const NORM_RETURN_CAP = 0.5;
export const NORM_DRAWDOWN_FLOOR = 0.5;
export const NORM_PF_CAP = 2;
export const NORM_TRADES_CAP = 50; // 对数归一 log10(1+50)/log10(51)=1
// 段位阈值（保留原表）
export const TIER_LEVELS = [
    { min: 92, name: '王者', icon: '🐉' },
    { min: 82, name: '大师', icon: '👑' },
    { min: 70, name: '钻石', icon: '🔷' },
    { min: 55, name: '铂金', icon: '💎' },
    { min: 35, name: '黄金', icon: '🥇' },
    { min: 15, name: '白银', icon: '🥈' },
    { min: 0, name: '青铜', icon: '🥉' },
];
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

// metrics = { totalReturn, maxDrawdown(0~1), profitFactor(>0 或 Infinity), winRate(0~1), totalTrades }
export function computeTierScore(metrics) {
    const m = metrics || {};
    const ret = clamp01(Number(m.totalReturn) / NORM_RETURN_CAP);
    const dd = clamp01(1 - Number(m.maxDrawdown) / NORM_DRAWDOWN_FLOOR);
    const pf = m.profitFactor === Infinity || Number(m.profitFactor) >= NORM_PF_CAP
        ? 1 : clamp01(Number(m.profitFactor) / NORM_PF_CAP);
    const wr = clamp01(Number(m.winRate)); // 直乘；40% 基准否决理由见方案 §4.2
    const act = clamp01(Math.log10(1 + Math.max(0, Number(m.totalTrades) || 0)) / Math.log10(1 + NORM_TRADES_CAP));
    return Math.round((ret * 30 + dd * 20 + pf * 20 + wr * 20 + act * 10));
}
export function tierOf(score) {
    return TIER_LEVELS.find((t) => score >= t.min) || TIER_LEVELS[TIER_LEVELS.length - 1];
}
```

### 4.4 risk-manager.service.ts 改动清单

**① 文件头 import（25-27 行区域）追加**（tier 模块与 Transaction 实体）：

```ts
import tier_1 = require("./tier");
import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");
```

**② 构造器追加 txRepo**（31-41 行；**编译风格硬性要求：同步改底部 `__metadata("design:paramtypes", ...)` 与 `__param`，见 ⑤⑥**）：

```ts
    constructor(accountRepo, snapshotRepo, positionRepo, txRepo) {
        this.accountRepo = accountRepo;
        this.snapshotRepo = snapshotRepo;
        this.positionRepo = positionRepo;
        this.txRepo = txRepo;
        /* …其余不变… */
    }
```

**③ 新私有方法 buildTierMetrics + computeTier 换签名**（替换 85-107 行整块；段位写回行为不变）：

```ts
    // Phase D：真实指标聚合（一次 txs 批量拉取后逐账户调用；perf.ts 配对纯函数输入须时间升序）
    buildTierMetrics(account, txs) {
        const initial = Number(account.initialEquity) || 1;
        const totalReturn = (Number(account.totalEquity) - initial) / initial;
        const peak = Number(account.peakEquity) || Number(account.totalEquity);
        const maxDrawdown = peak > 0 ? Math.max(0, (peak - Number(account.totalEquity)) / peak) : 0;
        const paired = perf_1.pairedMetrics(Array.isArray(txs) ? txs : []);
        return {
            totalReturn,
            maxDrawdown,
            profitFactor: paired.profitFactor,
            winRate: paired.pairedWinRate,
            totalTrades: Number(account.totalTrades) || 0,
        };
    }
    // Phase D 数据驱动段位：metrics 必传（settleAllAccounts 提供）；无参调用降级为空流水口径（兼容存量测试构造）
    computeTier(account, metrics) {
        const m = metrics || this.buildTierMetrics(account, []);
        const score = tier_1.computeTierScore(m);
        const tier = tier_1.tierOf(score);
        account.tier = tier.name;
        account.tierScore = score;
    }
```

**④ getPositionsValue 支持预载行**（175-195 行）：签名加可选参数，settleAllAccounts 批量预载后免 N 次查询；dailySettlement 透传。

```ts
    async getPositionsValue(account, positions) {
        const rows = positions || await this.positionRepo.find({ where: { accountId: account.id } });
        /* …原 177-194 估值逻辑对 rows 迭代不变… */
    }
```

dailySettlement（108-153 行）签名保持 `(account, day)` 兼容，内部 113 行改为 `const positions = await this.getPositionsValue(account);`（不动亦可，settleAllAccounts 传参时新增一个透传可选参 `dailySettlement(account, day, positions)` 由 113 行 `getPositionsValue(account, positions)` 消费；无调用方受影响，见 §6-2）。

**⑤ 类装饰块 __param 与 __metadata**（271-282 行）：

```ts
RiskManagerService = __decorate(
[
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(account_entity_1.Account)),
    __param(1, (0, typeorm_1.InjectRepository)(daily_snapshot_entity_1.DailySnapshot)),
    __param(2, (0, typeorm_1.InjectRepository)(position_entity_1.Position)),
    __param(3, (0, typeorm_1.InjectRepository)(transaction_entity_1.Transaction)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository])
],
RiskManagerService
);
```

**⑥ risk-manager.module.ts**：forFeature 列表（29 行）加 Transaction；文件头 11-15 行区域加 `import transaction_entity_1 = require("../../infrastructure/database/entities/transaction.entity");`：

```ts
imports: [typeorm_1.TypeOrmModule.forFeature([account_entity_1.Account, position_entity_1.Position, daily_snapshot_entity_1.DailySnapshot, transaction_entity_1.Transaction])],
```

**⑦ settleAllAccounts 批量改造**（替换 155-170 行）：

```ts
    async settleAllAccounts(day) {
        const accounts = await this.accountRepo.find();              // 批量 1：账户（原 156 行不变）
        const settled = [];
        if (accounts.length === 0) return settled;
        const ids = accounts.map((a) => a.id);
        // 批量 2：持仓（原逐账户 positionRepo.find → 1 次 In；读-only，结算不回写 positions）
        let positionsByAccount = new Map();
        try {
            const posRows = await this.positionRepo.find({ where: { accountId: (0, typeorm_2.In)(ids) } });
            for (const p of posRows) {
                const arr = positionsByAccount.get(p.accountId) || [];
                arr.push(p);
                positionsByAccount.set(p.accountId, arr);
            }
        }
        catch (e) {
            this.logger.warn('日终批量预载持仓失败，退回逐账户查询: ' + e.message);
            positionsByAccount = null; // null → getPositionsValue 走原逐账户查询
        }
        // 批量 3：流水（1 次全局 ASC 拉取，JS 分组后每账户截最近 500；take 全局 LIMIT 的坑见 §4.5）
        let txsByAccount = new Map();
        try {
            const txRows = await this.txRepo.find({ order: { createdAt: 'ASC' } });
            const byAcct = new Map();
            for (const t of txRows) {
                const arr = byAcct.get(t.accountId) || [];
                arr.push(t);
                byAcct.set(t.accountId, arr);
            }
            for (const [acid, arr] of byAcct) {
                txsByAccount.set(acid, arr.length > 500 ? arr.slice(-500) : arr); // 最近 500 且保持升序
            }
        }
        catch (e) {
            this.logger.warn('日终批量预载流水失败，段位指标按 0 流水口径: ' + e.message);
        }
        for (const account of accounts) {
            try {
                const posRows = positionsByAccount ? positionsByAccount.get(account.id) : undefined;
                settled.push(await this.dailySettlement(account, day, posRows));
                const metrics = this.buildTierMetrics(account, txsByAccount.get(account.id) || []);
                this.computeTier(account, metrics);   // 新签名：真实指标 → 段位（原 162 行）
                await this.accountRepo.save(account); // 原 163 行不变（写 tier/tierScore/日终字段）
            }
            catch (e) {
                this.logger.error(`日终结算失败 account=${account.id}: ${e.message}`); // 原 166 行不变
            }
        }
        return settled;
    }
```

（settleAllAccounts 里 `typeorm_2.In`、`typeorm_2.Repository` 均已 import，见文件头 15-17 行。）

### 4.5 流水批量拉取：全局 take 的坑与选优（任务要求"读代码后选优并说明"）

- TypeORM `find({take})` 在 better-sqlite3 生成**全局 LIMIT**：若 `take = 500×账户数`，同一 ORDER BY createdAt 下先被排序的账户会独占额度，靠后账户拿不满甚至拿 0（账户 id 为 uuid 随机序，任何账户都可能被截）→ **语义错误，否决**。
- 备选 A：每账户独立 `find({where:{accountId}, order:{createdAt:'ASC'}, take:500})` → N 次查询。**否决**：把 N+1 从账户换到流水，且任务明确"每日每账户一次流水查询"不可取。
- **采用方案 B：一次全局 `find({order:{createdAt:'ASC'}})`（无 take）+ JS 分组 + 组内 `slice(-500)`**：ASC 全量 → 分组后每账户天然升序，取尾部 500 = "最近 500 笔升序"，与 UI 口径（account.service.ts:106-111 ASC+500）逐字一致；pairedMetrics（perf.ts:16-24 按序 FIFO）输入要求满足。成本实据：现库 18 账户 / transactions 全表 1 行、daily_snapshots 45 行——即使未来 2000 账户 × 人均 500 笔 = 100 万行，better-sqlite3 单次全表扫描也在数百 ms 内且一天一次；超过该量级再切"每账户 LIMIT 500"（可提私有方法 `fetchSettlementTx(accounts)` 集中切换点，本方案先内联）。
- **截断失真说明（已知限制）**：>500 笔的账户 FIFO 配对窗口被截断——早期开仓若在窗口外，其平仓会配对到"不存在的成本"边缘（pairedMetrics 33-47 无 lot 时直接计 loss）。影响面：极活跃账户；UI（account.service getMetrics）本就 500 截断，口径一致，不做额外修复（P2 可选：perf.ts 暴露 `sliceRecentAsc` 供两处共用）。
- **perf.ts 导出建议**：`pairedMetrics` 无需改动；建议**不新增导出**（改动面最小），分组/截断逻辑留在 risk-manager 内部；若后续 account.service 也想复用，再在 perf.ts 提 `sliceRecentAsc(txs, n)` 统一口径（登记 P2）。

### 4.6 回撤是否改 snapshot 批量加载 → **否决**（成本评估 + 语义论证）

任务要求评估"settleAllAccounts 一次性 snapshotRepo.find({where:{userId: In(所有用户)}}) 建 Map"。结论：**不采用**，回撤沿用 `account.peakEquity` 口径。理由（实读证据）：

1. **快照表没有 accountId 维度**（daily-snapshot.entity.ts:22-30 仅 userId+day+equity+dailyReturn），多市场账户（同 userId 三个账户）每日各写一条快照（recordDailyEquity:57-63 以 account.userId 落库）→ 按 userId 聚合必然跨账户混算（ranking.service.ts:47-48 注释承认该缺陷并只拿它兜底）。要做成按账户的回撤序列，需给快照表加 accountId 列 + 历史回填迁移——超出 Phase D。
2. **peakEquity 与快照在同一时刻、同一数值下更新**：dailySettlement 145 行先 `peakEquity = max(...)`，151 行才 recordDailyEquity；峰值是持久化列，重启不清（内存 equityHistory 46-56 才会清空），重置时随账户归位（account.service.ts:181）。即"自赛季/重置以来按日终净值的峰值→当前"口径完全等价且无需任何新查询。
3. 成本对比：快照全量行数 = 账户 × 已结算游戏日（现 45 行；按 2000 账户 × 200 日 = 40 万行估算，better-sqlite3 一次批量 find 数十~数百 ms，非瓶颈——ranking.service.ts:34 已每轮全量拉一次作为先例）；真正可省的是**每账户 positions 查询 N→1 与账户双 save**（§4.7）。花一次批量查询去换取一个口径更差的指标，不划算。

### 4.7 查询次数对比（N = 账户数；settleAllAccounts 单轮）

| 操作 | 现状 | 改造后 |
|---|---|---|
| 账户读取 | 1 | 1 |
| 持仓读取（估值） | N（getPositionsValue:176 逐账户） | 1（批量 In） |
| 流水读取 | 0（computeTier 不看流水） | 1（批量 ASC + JS 分组截断） |
| 快照写（recordDailyEquity） | N | N（不变，落库审计需要） |
| 账户写（dailySettlement 内 save + settleAllAccounts save） | 2N | 2N（不变；合并为 N 属可选 P3 优化，需动 dailySettlement 幂等语义，不做） |
| **纯读查询** | **N+1** | **3 次批量** |

### 4.8 段位消费方核对（改动影响面）

全仓 grep：`computeTier` 生产调用仅 settleAllAccounts:162 一处；`account.tier/tierScore` 消费方：account.entity.ts:88-89 列定义、ranking.service.ts:65/100 展示（只读列，每日结算后刷新）、season.service.ts:201 赛季前三把 `tierScore` 当荣誉分累加（**与 computeTier 每日覆盖 tierScore 共用同一列**——既有语义冲突，非本方案引入；登记 P2：建议拆 `seasonPoints` 独立列，见 §6-6）。无控制器直改段位，UI 无需变更。

---

## 5. 任务⑥ phase10 测试设计清单（主 agent 编写，本文给用例 + 断言要点）

测试文件：`backend/test/phase10-tier-docker-index.test.js`（jest testMatch backend/test/**/*.test.js 自动收集；`npm run build && npm test`）。仓库根引用路径：test 文件 `__dirname = backend/test` → 仓库根 `path.join(__dirname,'..','..')`、backend/docker `path.join(__dirname,'..','docker')`、frontend 根 `path.join(__dirname,'..','..','frontend')`。

### 组 1：段位公式纯函数（require dist/tier.js，3 组输入）

```js
const { computeTierScore, tierOf, TIER_LEVELS } = require('../dist/src/core/risk-manager/tier');
```
| 用例 | 构造 metrics | 断言 |
|---|---|---|
| 满分 | `{totalReturn:0.6, maxDrawdown:0, profitFactor:Infinity, winRate:0.9, totalTrades:200}` | score=98（30+20+20+18+10）；tierOf=王者；`computeTierScore({totalReturn:0.5, maxDrawdown:0, profitFactor:2, winRate:1, totalTrades:50})`=100 满分边界 |
| 零分 | `{totalReturn:-0.2, maxDrawdown:0.6, profitFactor:0.2, winRate:0.1, totalTrades:0}` | score=4（0+0+2+2+0 → 4）；tierOf=青铜 |
| 典型 | `{totalReturn:0.25, maxDrawdown:0.1, profitFactor:1.5, winRate:0.55, totalTrades:30}` | ret 50→15；dd 80→16；pf 75→15；wr 55→11；act log10(31)/log10(51)≈0.873→8.7 → score 66；tierOf=铂金（55≤66<70） |
| 边界/空值 | 0 流水 `{totalReturn:0,maxDrawdown:0,profitFactor:0,winRate:0,totalTrades:0}` | score=20 → 白银（与旧公式同段位，锁回归）；metrics=undefined → score=0 不抛 |

再补一条实例级：`new RiskManagerService(null,null,null,null)` → `computeTier(account, metrics)` 后 `account.tier/tierScore` 写回正确（对应 §6-1 改造后的构造签名）。

### 组 2：索引存在性（getMetadataArgsStorage）

```js
const { getMetadataArgsStorage } = require('typeorm'); // typeorm 0.3.20
const { Order } = require('../dist/src/infrastructure/database/entities/order.entity'); // require 即注册元数据
const { Transaction } = require('../dist/src/infrastructure/database/entities/transaction.entity');
const { Position } = require('../dist/src/infrastructure/database/entities/position.entity');
const storage = getMetadataArgsStorage(); // 全局存储：indices: [{target, columns, ...}]
const idxOf = (target, columns) => storage.indices.find((i) =>
  i.target === target && JSON.stringify(i.columns) === JSON.stringify(columns));
expect(idxOf(Order, ['accountId','status'])).toBeTruthy();
expect(idxOf(Transaction, ['accountId'])).toBeTruthy();
expect(idxOf(Position, ['accountId'])).toBeTruthy();
// 回归锚：既有索引仍在
expect(idxOf(Position, ['accountId','symbol'])).toBeFalsy(); // Unique 不在 indices 里，在 storage.uniques
expect(getMetadataArgsStorage().uniques.some((u) => u.target === Position)).toBeTruthy();
```
**为何 require dist 而非 src**：仓库测试约定即 require dist（217 例全部如此，如 risk-manager.test.js:1、phase9 头 4 行）；src 是编译风格 TS 无现成转译管线（jest 无 ts-jest），dist 由 `npm run build` 产出且 tsconfig 只编 src。typeorm 自身加载 reflect-metadata，实体模块 evaluate 时装饰器把元数据注册进全局 storage，故 require 顺序无要求。

### 组 3：checkPendingOrders 批量（fakeRepo 记录 find 调用，同 phase9 fakeRepo 风格）

fakeRepo 升级版（**phase10 自己的 helper**，In 支持 + 调用日志）：

```js
function matchesWhere(r, where) {
  if (Array.isArray(where)) return where.some((w) => matchesWhere(r, w));
  return Object.entries(where || {}).every(([k, v]) => {
    // TypeORM FindOperator：{_type:'in', value:[...]}
    if (v && typeof v === 'object' && v._type === 'in') return (v.value || []).map(String).includes(String(r[k]));
    return String(r[k]) === String(v);
  });
}
function fakeRepo(seed = []) {
  const rows = [...seed];
  const calls = { find: 0, findOne: 0, lastFindWhere: null };
  return {
    rows, calls,
    find: async (q) => { calls.find++; calls.lastFindWhere = q?.where; return rows.filter((r) => matchesWhere(r, q?.where)); },
    findOne: async (q) => { calls.findOne++; return rows.find((r) => matchesWhere(r, q?.where)) || null; },
    save: async (e) => { if (!e.id) e.id = 'a' + (rows.length + 1); const i = rows.findIndex((r) => r.id === e.id); if (i >= 0) rows[i] = e; else rows.push(e); return e; },
    create: (o) => o,
  };
}
```

场景：3 张将成交挂单 × 2 个账户（如 AC1 两张不同 symbol 的 buy-limit、AC2 一张 buy-limit），各 symbol 现价低于限价且盘口有对手卖单（`engine.placeRestingOrder(sym,'rN','R'+n,'sell',price,qty)`）。引擎构造沿用 phase2:214 五参形式。断言：

1. `accountRepo.calls.find === 1` 且 `lastFindWhere.id._type === 'in'`、value 含 AC1/AC2（**In 批量只查一次**）；
2. `fills.length === 3`、三张订单实体 status=filled、filledQty 正确（结算结果正确性）；
3. 同账户连单刷新语义：再加一张与 AC1 同账户的第四单（AC1 第一张结算后才轮到它）→ `accountRepo.calls.findOne === 1`（脏条目按需刷新一次），`calls.find` 仍为 1——把"Map 条目更新时机"锁进回归；
4. 触发后校验失败路径不变：把 AC1 现金设到只够第一张 → 第二张 validateOrder 失败 → 订单 cancelled + rejectReason 含"资金不足"（证明脏刷新后预校验读到新现金，**这是数据新鲜度的行为断言**）。

### 组 4：Docker 静态断言（fs 读文件，__dirname 相对路径写准）

```js
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const backendDocker = path.join(__dirname, '..', 'docker'); // backend/test/.. = backend
const read = (p) => fs.readFileSync(p, 'utf8');
expect(read(path.join(backendDocker, 'Dockerfile.backend'))).toMatch(/COPY package\.json package-lock\.json/);
expect(read(path.join(backendDocker, 'Dockerfile.backend'))).toMatch(/dist\/src\/main\.js/);
const compose = read(path.join(backendDocker, 'docker-compose.yml'));
expect(compose).toMatch(/"8000:8000"/); expect(compose).toMatch(/"3000:80"/);
expect(compose).toMatch(/env_file/); expect(compose).toMatch(/sgp-data:\/app\/data/);
const feDockerfile = path.join(ROOT, 'frontend', 'Dockerfile');
expect(fs.existsSync(feDockerfile)).toBe(true);
expect(read(feDockerfile)).toMatch(/nginx/); expect(read(feDockerfile)).toMatch(/vite build|npm run build/);
const nginx = read(path.join(ROOT, 'frontend', 'nginx.conf'));
expect(nginx).toMatch(/try_files/); expect(nginx).toMatch(/proxy_pass http:\/\/backend:8000/);
expect(nginx).toMatch(/Upgrade \$http_upgrade/); expect(nginx).toMatch(/socket\.io/);
```

### 组 5（存量改造，非新增用例）

- risk-manager.test.js:7 构造改 4 参；:50-62 computeTier 两例按新签名/metrics 重写（值见组 1 锚点）。
- phase2-matching.test.js / phase7-money-safety.test.js 的 matchesWhere 复制体升级 In 支持（§6-3）。

---

## 6. 风险与回归点

1. **risk-manager.test.js（唯一直接测 computeTier 的文件）**：grep 全测试目录，调用 settleAllAccounts/dailySettlement 的用例为 0；computeTier 仅 risk-manager.test.js:50-62 两例——新公式下旧输入（无 pf/wr 数据）得 60 分（铂金）与 20 分（白银），**必须重写**（显式 metrics），否则红。构造器 4 参同步改（:7）。
2. **settleAllAccounts 批量改造的兼容性**：无测试调用它（grep 证实），风险面 = 生产日终路径。防护点：批量预载各包 try/catch 降级（持仓失败→逐账户查；流水失败→0 流水口径告警），逐账户 try/catch 保留（现 165-167 行），幂等 currentDay 守卫（110 行）不动。dailySettlement 透传可选 positions 参数，不破坏现有单账户签名。
3. **checkPendingOrders 批量化对存量用例的影响（最大回归点）**：phase2:219-275 四例（止损触发成交/10 次取消/止损限价/冰山不入直拍）与 phase7:50-82（STOP_LIMIT 触发成交）都走到 648 行账户重读 → 批量后变成 `find({where:{id: In([...])}})`；这两个文件的 matchesWhere（phase2:7-10、phase7:7-10）按 `String(v)` 等值比较，会把 FindOperator 序列化成 `[object Object]` → find 返回 [] → 订单被跳过 → 用例红。**必须给这两处 helper 加 In 分支**（代码见 §5 组 3 matchesWhere），顺序：先改 helper 再跑全量。
4. **实体索引**：synchronize 首启自动建索引（先例 daily_snapshots IDX_* 已实证）；大表场景首启会有一次 CREATE INDEX 耗时——本库 18 账户规模可忽略。positions 的 Index 与 Unique 左前缀冗余（§2.1），若评审不接受冗余可只做两处 + 更新组 2 断言。
5. **段位分布变化属预期**：回撤/盈亏因子/胜率进公式后，高回撤或低盈亏比账户段位会下移；无交易账户仍是白银（§4.2 空值语义），UI 字段（tier/tierScore）不变无前端改动。阶段内用现有数据做一次"结算前后段位分布"抽查即可（跑一天 EOD 看 ranking 接口）。
6. **tierScore 双语义冲突（既有债，本方案不修，登记 P2）**：season.service.ts:201 赛季奖励对 tierScore **累加**，computeTier 每日**覆盖**——两者共用 account.tierScore（account.entity.ts:89）。建议拆列 seasonPoints。Phase D 保持现状，测试断言不受影响（phase9:154-156 断言赛季路径，phase10 组 1 断言段位路径，互不调用）。
7. **快照内存口径不动**：equityHistory/recordDailyEquity 保留（calculateMetrics/VaR/getEquityHistory 消费方不变，196-257 行），仅 computeTier 不再依赖内存历史（改用 peakEquity+流水）——重启后段位不再受内存清空影响，这是本方案的净改进。
8. **流水截断失真**（§4.5）：>500 笔/账户的配对窗口截断为已知限制，与 UI 口径一致；不要在本任务里"顺手修复"perf.ts（会改变 getMetrics 口径）。
9. **Docker 相关**：backend/.env 文件是 GBK 编码（键名 ASCII，值无中文，compose env_file 解析安全；不要转码以免破坏现有 dev 启动）；旧 `infra/docker-compose.yml:39-69` 引用了不存在的 `frontend/docker/Dockerfile.frontend` 与挂载式 nginx conf（GBK 注释文件），其 postgres/redis 服务按 DB_TYPE=postgres 前提构建，与本方案 sqlite compose 互斥——**建议实施后顺手把 infra 中 backend/frontend 两节标记 deprecated**（P2，避免误导）；两套 compose 网络/端口不冲突（本方案未占 5432/6379）。
10. **验证基线**：改造全程保持 `npm run build && npm test` 全绿（先改 helper 再动业务码的顺序建议：实体索引 → helper 升级 → checkPendingOrders → tier → settleAllAccounts → phase10 用例）。

---

## 7. 文件改动汇总（最终交付物清单）

| 操作 | 文件 |
|---|---|
| 修改 | `backend/docker/Dockerfile.backend`（lockfile ×2 处、CMD 路径） |
| 新增 | `backend/docker/docker-compose.yml`、`backend/.dockerignore`、`frontend/Dockerfile`、`frontend/nginx.conf`、`frontend/.dockerignore`、`backend/src/core/risk-manager/tier.ts` |
| 修改 | `backend/src/infrastructure/database/entities/{order,transaction,position}.entity.ts`（各 1 条类级 Index） |
| 修改 | `backend/src/core/trading-engine/trading-engine.service.ts`（checkPendingOrders 批量化 + shouldFillNow） |
| 修改 | `backend/src/core/risk-manager/risk-manager.service.ts`（构造器+txRepo、buildTierMetrics、computeTier 新签名、getPositionsValue/dailySettlement 透传、settleAllAccounts 批量、装饰块 paramtypes） |
| 修改 | `backend/src/core/risk-manager/risk-manager.module.ts`（forFeature + import） |
| 修改（存量测试） | `backend/test/risk-manager.test.js`（构造 4 参 + computeTier 两例重写）、`backend/test/phase2-matching.test.js` 与 `backend/test/phase7-money-safety.test.js`（matchesWhere 支持 In） |
| 新增（测试） | `backend/test/phase10-tier-docker-index.test.js`（组 1-4） |
