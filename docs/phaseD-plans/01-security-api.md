# Phase D 方案 01：安全加固 + API.md 重写

> 角色：Phase D 方案设计师 ｜ 范围：任务② 安全加固（5 项）+ 任务① API.md 重写方案 + 任务③ phase10 测试设计
> 状态：**方案稿（未实施）**。所有依据均来自对 `backend/src` 源码实读，行号以当前文件为准。实施前先 `cd backend && npm run build`，测试引用 `dist`。
> 约束：不修改任何现有源码/测试，本文件为唯一产出。

---

## 0. 结论速览

| # | 事项 | 方案要点 | 涉及文件 |
|---|------|---------|---------|
| 1 | Swagger 无条件挂载 | `NODE_ENV === 'development'` 时才 setup `/api/docs` | `backend/src/main.ts` |
| 2 | `/market/backtest` 无限制 | `express-rate-limit` 20 次/分/IP，仅挂 `/api/market/backtest` | `backend/src/main.ts` |
| 3 | 登录账号级防爆破 | auth.service 内存 Map，5 次失败锁 10 分钟，惰性清理 | `backend/src/modules/auth/auth.service.ts` |
| 4 | WS 握手不查用户状态 | gateway 注入 User repo，`isActive=false` 即断 | `market.gateway.ts` + `market.module.ts` |
| 5 | fill 广播泄露对手方 | 纯函数 `sanitizeFill` 剥离 `accountId/orderId/mmId` | `common/market-utils.ts` + `market.service.ts` |
| 6 | API.md 漂移 | 按实现重写（大纲见 §3），附文档路由抽查测试设计 | `docs/API.md`（由主 agent 按 §3 大纲重写） |
| 7 | phase10 测试 | 用例清单 + mock 骨架见 §4，主 agent 编写 | `backend/test/phase10-security.test.js` 等 |

---

## 1. 关键代码事实基线（先读这些，方案才有依据）

### 1.1 路由真相表（controllers 实读结果，API.md 重写依据）

全部 controller 为编译风格 TS（手写 `__decorate`），路由 = `Controller(path)` + 方法装饰器，全局前缀 `api`（main.ts:41）。认证 = 类级或方法级 `UseGuards(JwtAuthGuard)`（jwt-auth.guard.ts:11-23，passport 'jwt'），`@CurrentUser()` 取 `request.user`（jwt-auth.guard.ts:25-29）。**JwtStrategy.validate 每次请求查库并校验 isActive**（jwt.strategy.ts:45-50），即 HTTP 侧被禁用用户的下一个请求即 401；**但 WS 网关只 `jwtService.verify(token)` 不查库**（market.gateway.ts:34-39）→ 禁用用户在 WS 上不掉线（任务②#4 的根因）。

| 方法+路径（全局前缀 /api） | 认证 | 控制器实读位置 |
|---|---|---|
| POST /auth/register | 无（限流 10/min/IP） | auth.controller.ts:60-65 → auth.service.ts:94-115 |
| POST /auth/login（200） | 无（限流 10/min/IP） | auth.controller.ts:66-73 → auth.service.ts:116-125 |
| GET /user/profile | JWT | user.controller.ts:34-39 |
| PUT /user/profile | JWT | user.controller.ts:41-47 → user.service.ts:33-45 |
| GET /account?mode= | JWT | account.controller.ts:60-66 |
| GET /account/metrics | JWT | account.controller.ts:68-74 |
| GET /account/history | JWT | account.controller.ts:76-82 |
| GET /account/transactions?limit | JWT | account.controller.ts:84-91 |
| GET /account/reviews | JWT | account.controller.ts:112-117 |
| POST /account/leverage | JWT | account.controller.ts:93-100 |
| POST /account/reset | JWT | account.controller.ts:119-126 |
| POST /account/transfer | JWT | account.controller.ts:102-110 |
| GET /account/achievements / POST /account/achievements | JWT | account.controller.ts:128-141 |
| POST /trading/order?mode= | JWT | order.controller.ts:84-91 |
| **DELETE /trading/order/:id**（非 POST .../cancel） | JWT | order.controller.ts:93-100 |
| GET /trading/orders/pending | JWT | order.controller.ts:102-108 |
| **GET /trading/history**（非 /orders/history） | JWT | order.controller.ts:110-116 |
| GET /market/prices、/stocks、/indices、/state、/reports、/ai-opponents、/flow-signals、/backtest、/klines、/orderbook | **全部无认证** | market.controller.ts:53-125（类无 UseGuards） |
| GET /fund、GET /fund/:id | 无认证 | fund.controller.ts:39-51（类无 UseGuards） |
| POST /fund/:id/subscribe、/fund/:id/redeem（**金额/份额在 Query**） | JWT（方法级） | fund.controller.ts:53-73 |
| POST /season/enroll、GET /season/current、/leaderboard、/history | JWT（类级） | season.controller.ts:40-66，类级 guard season.controller.ts:73 |
| GET /ranking | JWT（类级，SECURITY(F) 注释） | ranking.controller.ts:29-36, 44 |
| GET /admin/stats、/admin/users、GET/POST /admin/debug、POST /admin/debug/global、POST /admin/users/:id/toggle | JWT + 方法内 role 校验（403 无权限） | admin.controller.ts:82-128 |
| WS 命名空间 /market（socket.io） | handshake auth.token JWT | market.gateway.ts:74-78 |

### 1.2 与 docs/API.md 的已知漂移（重写必须纠正）

| 旧文档写法 | 实现真相 | 依据 |
|---|---|---|
| `POST /trading/order/:id/cancel` | `DELETE /trading/order/:id` | order.controller.ts:93-100 |
| `GET /trading/orders/history` | `GET /trading/history` | order.controller.ts:110-116 |
| order type 只有 `market\|limit\|stop\|stop-limit` | 还有 `fok/ioc/iceberg` | order.entity.ts:16-24 |
| 市价单返回 `{success, fill:{quantity,price,fees}}` | 返回 `result.settle`=`{success, fill:{symbol,side,quantity,price,totalCost,fees}, fees}` | order.service.ts:94-97；trading-engine.service.ts:572-576 |
| login 返回 `{token}` | 返回 `{user: 安全字段, token}` | auth.service.ts:123-124 |
| tick 事件 `{type:'tick', data:[...]}` | `emit('tick', { ticks, timestamp: Date.now() })`，tick 元素 `{symbol,price,volume,timestamp}` | market.gateway.ts:55；market-data.service.ts:540-545 |
| mode 只说 US/CN | 三市场 CN/HK/US（H 前缀港股/U 前缀美股/其余 A股） | market-utils.ts:3-10 |
| 仅列了 auth/行情/交易三个区 | 缺 user/account 全套、fund、season、ranking、admin、WS 事件形态、限流、swagger | 见 §3 大纲 |
| 无订单类型语义说明 | FOK/IOC/ICEBERG/STOP/STOP_LIMIT 语义见 §3.4 | trading-engine.service.ts:189-316 |

### 1.3 fill 广播泄露链（任务②#5 依据，字段名先对齐）

1. 成交产生的顶层 fill 结构（撮合引擎返回）：`{ symbol, side, filledQuantity, avgPrice, totalCost, counterFills }`——**不是 quantity/price 命名**（matching-engine.ts:373-381 与 :425-432）。
2. `counterFills[]` 每元素：`{ orderId, accountId, side, price, qty, virtual, mmId }`（matching-engine.ts:198；冰山/虚拟单同构 :499-500）。
3. 挂单触发成交后，`checkPendingOrders` 组广播载荷：`fills.push({ ...fill, side: order.side, fees: settle.fees })`（trading-engine.service.ts:683）→ `market.service.ts:238` 原样 `gateway.broadcastFill(f)` → `server.emit('fill', fill)`（market.gateway.ts:57-59）。
4. 结论：所有 WS 客户端可读到**对手方真实用户的 accountId（uuid）与 orderId**；虚拟单元素携带 mmId。顶层 `filledQuantity/avgPrice/totalCost/fees` 是既有线上契约，不得改名；`counterFills` 仅需保留前端可展示信息。
5. HTTP 侧市价单返回的 settle.fill 是另一结构（`quantity/price` 命名，trading-engine.service.ts:572-576），sanitize 不触碰它。

### 1.4 业务口径常量（API.md「通用规则」章的数据源）

| 口径 | 值 | 依据 |
|---|---|---|
| 初始资金 / 杠杆上限 | 100000 / 1~3x | constants/index.ts:138-139；account.service.ts:115-124（setLeverage 校验 1..3） |
| 融资利率 | 0.02%/日（borrowed+shortCollateral 为基数） | constants/index.ts:137；risk-manager.service.ts:114-119 |
| 维持担保比三级 | 预警 <1.4 / 追保 <1.3（部分平仓至 1.5）/ 强平 <1.2 | constants/index.ts:140-144；trading-engine.service.ts:1097-1108, 1224-1303, 1304-1331 |
| 红利税 | CN ≤7 交易日 20%、>7 日 0%；HK 20%；US 30% | constants/index.ts:358-367 |
| 基金费率 | 申购 ETF 0.15%/货基 0；赎回 <7 日 1.5%、7-30 日 0.5%、≥30 日 0 | fund.service.ts:33-41, 52-56 |
| A股涨跌停 | 昨收基准 ±10%；**新股首日 +44%/-36%**（任务描述写的「首日±44%」是错的：下行按 0.64 即 -36%） | market-utils.ts:18-26 |
| 盘后固定价格交易 | 仅 CN 15:00-15:30，仅限价单、价格=当日收盘价；15:30 后未成交自动撤销 | constants/index.ts:344-356；order.service.ts:71-89；trading-engine.service.ts:980-1072 |
| 集合竞价 | 仅 CN：9:15-9:20 可申报可撤 / 9:20-9:25 可申报不可撤 / 9:25-9:30 撮合中禁申报 | constants/index.ts:325-341；order.service.ts:52-59 |
| 跨市场划转 | 动态汇率 + 0.1% 手续费 | constants/index.ts:161-162, 165-176；account.service.ts:210-250 |
| mode 默认值 | 控制器层 `mode || 'US'`（account/order 类），season/ranking 用 market 参数 | order.controller.ts:71；account.controller.ts:26 |
| 赛季中冻结 | 有 active 报名的用户：禁重置/划转/基金申购赎回 | season.service.ts:111-117；account.service.ts:144-146, 219-221；fund.service.ts:96-98, 135-138 |
| 重置预设 | 散户 10w/1x、机构 50w/2x、日内交易者 20w/3x；需无持仓/无基金份额/无挂单；冷却 1 游戏日；RESET_ENABLED 开关 | account.service.ts:130-208 |
| 排行榜输出 | 剔除 userId、用户名脱敏（保留前 2 字符 + *） | ranking.service.ts:90-107 |
| WS 事件 | tick：`{ticks[], timestamp}`；fill：原始 engine fill；news：`{title,description,type,impact,duration}`（+可选 targetedSymbol/insiderNews） | market.gateway.ts:54-62；news.service.ts:124-152 |
| K 线周期 | 1min / 5min / 60min（按小时聚合）/ daily / weekly / monthly | market-data.service.ts:1613-1651 |
| /market/state | 含 `isTradingTime`、`isPostCloseTrading`（=afterHoursStageFor≠null）、`fxRates`；MarketService 合并层再加 `tickIntervalMs`、`offHoursTrading`、`markets{CN,HK,US}` | market-data.service.ts:1657-1673；market.service.ts:510-526 |
| /market/backtest 策略 | `ma_cross`(fast/slow)/`rsi_reversal`(period)/`momentum`(momentumN)，白名单外回退 ma_cross；slippageBps=0 按市场默认；lotSize US=1 否则 100 | market.service.ts:544-559 |

---

## 2. ①改动清单：安全加固（文件 → 具体改动 → 代码骨架）

### 2.1 main.ts：Swagger 仅 development 挂载

现状：main.ts:72-85 无条件 `SwaggerModule.setup('api/docs', ...)`（外层只有 try/catch）。
改动：整段（含 try/catch）包进 `if (process.env.NODE_ENV === 'development')`。判断口径与 auth.service.ts:44 的 `isDev` 完全一致（精确相等、无默认回退）；当前 `.env` 即 `NODE_ENV=development`，本机开发不受影响；生产部署必须显式 `NODE_ENV=production`。

```ts
// P5 工程化：Swagger API 文档（/api/docs）仅 development 环境挂载（生产不暴露接口清单与 schema）
if (process.env.NODE_ENV === 'development') {
    try {
        const swaggerConfig = new swagger_1.DocumentBuilder()
            .setTitle('StockSim Pro API')
            .setDescription('模拟炒股平台接口文档：行情/交易/账户/量化接入（模拟数据仅供学习，不构成投资建议）')
            .setVersion('0.2.0')
            .addBearerAuth()
            .build();
        const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
        swagger_1.SwaggerModule.setup('api/docs', app, document);
    }
    catch (e) {
        logger.warn('Swagger 文档初始化失败: ' + (e && e.message ? e.message : e));
    }
}
```
（即把 main.ts:72-85 原 try 块整体上移一行、加 if 包一层；改动后 `swagger_1` import 在 production 仍存在，无副作用。）

### 2.2 main.ts：/market/backtest 限流（20 次/分/IP）

现状：express-rate-limit 已在 deps（package.json `express-rate-limit ^8.6.1`），auth 限流先例 main.ts:47-54。
改动：在 main.ts:54（`app.use('/api/auth', authLimiter)`）之后、:55（ValidationPipe）之前插入：

```ts
// Phase D: /market/backtest 为无认证公共计算接口（逐根 K 线跑策略），单 IP 限流防滥用
const backtestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { statusCode: 429, message: '请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/market/backtest', backtestLimiter);
```

要点（写进实施说明）：
- **路径与 global prefix 的关系**：`app.setGlobalPrefix('api')`（main.ts:41）只影响 Nest 路由注册；express 中间件 `app.use` 的路径匹配是**原始请求路径**，必须写全 `/api/market/backtest`——auth 限流 `app.use('/api/auth', ...)`（main.ts:54）是同一先例，照抄即可。
- `express-rate-limit` v8 路径式挂载 = 精确路径 + 子路径（本端点无子路径，无歧义）。不要用 `app.use` 全局挂载（会波及所有公开行情端点）。
- 插入位置必须在 `app.listen`（main.ts:86）之前即可；紧跟 authLimiter 之后最直观，与现有限流配置聚在一起。
- 429 响应体格式与本项目 auth 限流一致：`{ statusCode: 429, message: '请求过于频繁，请稍后再试' }`（main.ts:50 同款）；`standardHeaders: true` 会带 `RateLimit-*` 头。
- 与 trust proxy（main.ts:66）配合：`set('trust proxy', ...)` 在 :66 才执行——**限流中间件是延迟到请求时才读 IP，顺序无影响**（现有 auth limiter 同样定义于 :66 之前且工作正常，可直接验证）。
- 阈值评估：backtest 为纯 CPU 计算（市场 K 线×策略循环），单次 <50ms 级；20/min/IP 防脚本滥用即可，前端/量化 bot 正常节奏远低于此。

### 2.3 auth.service.ts：登录账号级防爆破（纵深防御）

现状：login（auth.service.ts:116-125）只做 repo 查询 + bcrypt.compare；错误统一抛 `UnauthorizedException('用户名或密码错误')`（:119、:122 文案一致，天然防枚举第一步）。IP 限流 10/min（main.ts:47-54）挡单 IP 脚本；账号级锁定防**多 IP/慢速**逐账号爆破。构造函数参数不变 → **类底部 `__metadata("design:paramtypes", ...)` 不用改**（只加字段与私有方法）。

改动骨架（编译风格，插入到类内 `[key: string]: any;` 后 / login 方法前，并改写 login）：

```ts
// ─── Phase D: 账号级防爆破（纵深防御；IP 层 10次/分限流在 main.ts:47-54） ───
// 内存结构：username(normalized) → { failCount, lockedUntil }；进程内单实例有效（本项目单进程部署）。
// 惰性清理：访问时过期即删；Map 超阈值时顺带扫一遍过期项（防记忆体无限增长）。
// 字段/常量全部走构造器赋值（与仓库手写编译风格一致，无类字段/访问修饰符先例）；
// 常量做成实例字段便于 phase10 单测覆写（如 LOGIN_LOCK_MS=1 验证"锁定期外恢复"）。
```
构造器（auth.service.ts:31-35 扩展，**构造参数不变 → 底部 design:paramtypes 无需改动**）：
```ts
    constructor(userRepo, accountRepo, jwtService) {
        this.userRepo = userRepo;
        this.accountRepo = accountRepo;
        this.jwtService = jwtService;
        this.loginFails = new Map();       // key: trimmed username → { failCount, lockedUntil }
        this.LOGIN_MAX_FAILS = 5;
        this.LOGIN_LOCK_MS = 10 * 60 * 1000; // 10 分钟
        this.LOGIN_LOCK_MSG = '尝试次数过多，账号已锁定10分钟';
    }
```
新增私有方法（插在 `login` 前；不写访问修饰符，与文件内其余方法一致）：
```ts
    loginFailKey(username) {
        // trim 规范化：拒绝 " admin " 与 "admin" 各记一次的分裂计数
        return String(username || '').trim();
    }
    purgeExpiredLoginFails() {
        if (this.loginFails.size < 5000)
            return;                                  // 低于阈值不扫
        const now = Date.now();
        for (const [k, v] of this.loginFails) {      // Map 迭代中 delete 安全
            if (v.lockedUntil <= now)
                this.loginFails.delete(k);
        }
        if (this.loginFails.size > 10000)
            this.loginFails.clear();                 // 极端兜底（正常不可能）
    }
    checkLoginLocked(key) {
        const rec = this.loginFails.get(key);
        if (!rec)
            return;
        const now = Date.now();
        if (rec.lockedUntil > now) {
            throw new common_1.UnauthorizedException(this.LOGIN_LOCK_MSG);
        }
        this.loginFails.delete(key);                 // 锁已过期：惰性清除并放行本次尝试
    }
    recordLoginFail(key) {
        this.purgeExpiredLoginFails();
        const now = Date.now();
        const rec = this.loginFails.get(key) || { failCount: 0, lockedUntil: 0 };
        rec.failCount += 1;
        if (rec.failCount >= this.LOGIN_MAX_FAILS) {
            rec.lockedUntil = now + this.LOGIN_LOCK_MS; // 第 5 次失败即锁
            rec.failCount = 0;                          // 重置计数，避免锁内继续累加
        }
        this.loginFails.set(key, rec);
    }
```

改写后的 `login`（替换 auth.service.ts:116-125 整段）：

```ts
async login(username, password) {
    const key = this.loginFailKey(username);
    // 锁定检查先于一切 IO/bcrypt：锁定期内既不查库也不跑 bcrypt（省钱省 CPU，且不可被计时旁路）
    this.checkLoginLocked(key);
    const user = await this.userRepo.findOne({ where: { username: String(username || '').trim() } });
    if (!user) {
        // 取舍（见下）：不存在的用户名同样计数 → 爆破方无法区分"用户名不存在"与"密码错误"
        this.recordLoginFail(key);
        throw new common_1.UnauthorizedException('用户名或密码错误');
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
        this.recordLoginFail(key);
        throw new common_1.UnauthorizedException('用户名或密码错误');
    }
    this.loginFails.delete(key); // 成功登录清零
    const token = this.jwtService.sign({ sub: user.id, username: user.username, role: user.role });
    return { user: this.toSafeUser(user), token };
}
```

（若 tsconfig 不支持类字段语法——本仓库源文件未见类字段先例，全部写在 constructor——则把 `loginFails` 等字段初始化放进 constructor 即可，其余不变。两处实现等价的，实施者按仓库风格选一；建议直接放 constructor 内，与 auth.service.ts:30-35 现有风格一致。）

**设计决策记录**：
1. **不存在的用户名计不计？→ 计**。理由：①错误文案本就统一（:119/:122），计数对象不同也不会暴露信息差异；②不计的话，爆破不存在用户名可无限试探且绕开账号锁；③会暴露"哪些用户名被计数/没被计数"的时序差异。**遗留取舍须写进 API.md/风险**：`register` 对已存在用户名返回 409 '用户名已存在'（auth.service.ts:96-97）仍可枚举用户名——这是既有行为，改动会破坏前端注册体验，本次**不改**，仅记为 P2 债（如需要可在注册侧对重复用户名统一返回 200+"邮件验证"式假象，属产品决策）。
2. **锁定期内对同一 key 继续尝试**：直接抛锁定文案（区分于普通 401）。这是有意为之：攻击者立刻知道自己被锁、正常用户看到明确指引；副作用是攻击者可借此"锁死"他人账号（DoS）——评估：本项目为学习型模拟盘、无真实资金、账号本身无价值，5 次×10 分钟的可接受；若要消除 DoS 面，可改成"锁定期内对目标账号也拒绝"不变、但错误文案一律统一（不推荐，体验差）。IP 层 10/min 限流已限制单 IP 制造锁定的速率。
3. **trim 规范化**：查询与计数共用 `trim()` 后的 key；DB 中历史注册若带首尾空格（register 未 trim，auth.service.ts:94-99），trim 后查不到会走"不存在"分支——可接受（正常 UI 不会注册出带空格用户名）；**不**做 toLowerCase（会把现存大小写用户名语义改掉）。
4. 内存锁进程重启即失效——本项目单进程 + SQLite 场景可接受；如需重启持久化要落库，成本不值，记为技术债说明。

### 2.4 market.gateway.ts + market.module.ts：WS 握手校验 isActive

现状/根因：gateway `handleConnection` 仅 `jwtService.verify(token)`（market.gateway.ts:34-39），token 有效期内禁用用户照常连 WS 收行情；HTTP 侧 JwtStrategy 每次请求查库（jwt.strategy.ts:45-50）形成不对称。

#### 2.4.1 market.module.ts

现状 imports 只有 JwtModule（market.module.ts:30-39）。
改动 ①：文件头 import 区（:9-11 一带）追加两行：
```ts
import typeorm_1 = require("@nestjs/typeorm");
import user_entity_1 = require("../../infrastructure/database/entities/user.entity");
```
改动 ②：`imports: [` 数组内（JwtModule.registerAsync 块 :32-38 之后、:39 数组收尾前）追加：
```ts
typeorm_1.TypeOrmModule.forFeature([user_entity_1.User]),
```
（AppModule 的 TypeOrmModule 是 `autoLoadEntities: true`（app.module.ts），forFeature 注册即全局可用；auth.module.ts:33 的 `TypeOrmModule.forFeature([User, Account])` 是现成先例格式。）

#### 2.4.2 market.gateway.ts（完整骨架，编译风格）

改动 ①：文件头 import 区追加：
```ts
import typeorm_1 = require("@nestjs/typeorm");
import typeorm_2 = require("typeorm");
import user_entity_1 = require("../../infrastructure/database/entities/user.entity");
```
改动 ②：构造器加参数并同步**类底部装饰器数组**（gateway 底部 :71-82）：
```ts
// 构造器（:20-24 原样扩展）：
constructor(jwtService, userRepo) {
    this.jwtService = jwtService;
    this.userRepo = userRepo;
    this.logger = new common_1.Logger(MarketGateway.name);
    this.clients = 0;
}
```
改动 ③：`handleConnection` 改 async 并加查库（替换 :25-48）：

```ts
async handleConnection(client) {
    // SECURITY(C): WS 必须携带 JWT（前端 socket.io 使用 auth: { token } 传参），校验失败直接断开
    // Phase D: verify 后再查 User 校验 isActive——用户被禁用后其存量 WS 立即断开（HTTP 侧由
    // JwtStrategy.validate 每次请求兜底，jwt.strategy.ts:45-50；WS 无请求概念，故在此补 DB 检查）
    try {
        const token = client.handshake && client.handshake.auth ? client.handshake.auth.token : null;
        if (!token) {
            this.logger.warn(`WS 认证失败（缺少 token）: ${client.id}`);
            client.disconnect(true);
            return;
        }
        const payload = this.jwtService.verify(token);
        if (!payload || !payload.sub) {
            this.logger.warn(`WS 认证失败（token 载荷无效）: ${client.id}`);
            client.disconnect(true);
            return;
        }
        const user = await this.userRepo.findOne({ where: { id: payload.sub } });
        if (!user || !user.isActive) {
            this.logger.warn(`WS 认证失败（用户不存在或已被禁用）: ${client.id}`);
            client.disconnect(true);
            return;
        }
    }
    catch (e) {
        this.logger.warn(`WS 认证失败: ${client.id} - ${e.message}`);
        client.disconnect(true);
        return;
    }
    this.clients++;
    this.logger.log(`WS 客户端已连接: ${client.id} (在线: ${this.clients})`);
}
```
改动 ④：类底部装饰器（:71-82）同步加参数注入元数据——**给类加构造参数必须改这里**：
```ts
MarketGateway = __decorate(
[
    (0, common_1.Injectable)(),
    (0, websockets_1.WebSocketGateway)({
        // FIX(M5): 收紧 CORS 白名单（原 origin:'*' 为无差别放行）
        cors: { origin: ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000'], credentials: true },
        namespace: '/market',
    }),
    __param(1, (0, typeorm_1.InjectRepository)(user_entity_1.User)),
    __metadata("design:paramtypes", [jwt_1.JwtService, typeorm_2.Repository])
],
MarketGateway
);
```
（设计:paramtypes 与 auth.service.ts:133-137 / admin.service.ts:74-84 的 Repository 注入写法一致；`__param(1, InjectRepository(User))` 提供 token，paramtypes 提供类型。）

行为语义确认：@nestjs/websockets v10 对返回 Promise 的 handleConnection 会**等待其 resolve 后才完成握手**，因此 await 查库期间客户端不会进入已连接状态；失败分支全部 `client.disconnect(true)`，与现行为（未计数）一致——handleDisconnect 有 `Math.max(0, ...)` 保护（:51）。

### 2.5 market-utils.ts + market.service.ts：sanitizeFill 剥离对手方敏感字段

位置决策：放进 `common/market-utils.ts`（纯函数文件、零依赖、现有测试已直接 require 它，phase9-season-rules.test.js:3），避免 market.service 文件因 require 副作用被单测拉入；market-utils.ts 是普通 TS（`export function` 直写，非编译装饰器风格），加函数零风险。

```ts
// Phase D: WS fill 广播前脱敏——剥离对手方账户/订单标识（原样广播会泄露
// 对手方 accountId/orderId/mmId，见 trading-engine/matching-engine.ts:198）。
// 顶层字段保持引擎原命名（filledQuantity/avgPrice/totalCost/fees，matching-engine.ts:373-381），
// counterFills 仅保留前端可展示信息 {side, price, qty, virtual}。
export function sanitizeFill(fill) {
    if (!fill || typeof fill !== 'object')
        return fill;
    const out = { ...fill };
    if (Array.isArray(fill.counterFills)) {
        out.counterFills = fill.counterFills.map((cf) => ({
            side: cf.side,
            price: cf.price,
            qty: cf.qty,
            virtual: !!cf.virtual,
        }));
    }
    return out;
}
```

market.service.ts 改动（唯一广播点 :238）：
```ts
// 原：fills.forEach((f) => { this.gateway.broadcastFill(f); });
// 新：
fills.forEach((f) => { this.gateway.broadcastFill((0, market_utils_1.sanitizeFill)(f)); });
```
（:35 `const { symbolMarket } = market_utils_1;` 可保持不动，直接用命名空间调用；若想解构需同步改成 `const { symbolMarket, sanitizeFill } = market_utils_1;`——任选其一，实施时注意 :238 上下文。）

说明：broadcastFill 唯一调用点即 market.service.ts:238（全仓 grep 无其他调用）；auction/盘后路径不广播 fill（settleAuctionFills / submitClosingOrder 无 emit），无需其它点。剥离后字段名兼容旧前端（只少字段不少改名），`virtual` 保留供前端区分 AI 对手。

---

## 3. ②API.md 大纲（新文档完整结构，供主 agent 重写 docs/API.md）

文档基调：**以实现为准（本文 §1 全部行号可回溯）**；示例值用现实数据；所有错误返回注明 Nest 默认格式 `{ statusCode, message, error }`（ValidationPipe 400 带 message 数组，auth limiter 429 为 `{statusCode:429, message}`）。

### §0 总览与通用约定（新增）
- Base URL `http://localhost:8000/api`；全局前缀 api（main.ts:41）；认证 `Authorization: Bearer <token>`。
- 市场与代码约定：CN（无前缀代码，T1/C1/F1/M1/E1/D1/R1/P1/G1-V3）、HK（H 前缀）、US（U 前缀）（market-utils.ts:3-10）；`mode` 枚举 CN|HK|US，缺省 US（order/account 控制器 `mode || 'US'`）。
- 请求体校验：ValidationPipe whitelist+forbidNonWhitelisted（main.ts:55-59）→ 未知字段直接 400。
- 限流：/api/auth 全路径 10 次/分/IP（main.ts:47-54）；/api/market/backtest 20 次/分/IP；429 格式。
- 错误码惯例：401 未认证/凭证错、403 越权（admin 非 ADMIN / 自禁）、404、409（注册重名）、429、400 业务拒绝（多数交易类错误以 `{success:false,error}` 返回而非异常——逐端点注明）。
- Swagger：仅 development 环境挂载 `/api/docs`（若 2.1 实施完成）；未登录态可用但无鉴权信息展示。
- 真实时段依赖：下单/撤单受本地时钟+节假日历约束（盘前竞价、盘后固定价格窗口见 §4/§11）。

### §1 认证
- POST /auth/register：body {username(2-50), password(8-72)}；注册即建 CN/HK/US 三账户各 100000（auth.service.ts:94-115）；返回 {user, token}；409 重名。
- POST /auth/login（HTTP 200）：body {username, password}；返回 {user:{id,username,role,isActive,createdAt,updatedAt}, token}；401 '用户名或密码错误'（不存在与错密码同文案）；账号锁定 10 分钟错误（若 2.3 实施）：401 '尝试次数过多，账号已锁定10分钟'。

### §2 用户
- GET /user/profile（JWT）：{id, username, role, createdAt}（注意：此端点不含 isActive/updatedAt——controller 自建对象，user.controller.ts:26-28；与 PUT 返回不同，文档需如实标注）。
- PUT /user/profile（JWT）：仅 username 可改（白名单 user.service.ts:35-36）；返回完整安全档案 {id,username,role,isActive,createdAt,updatedAt}。

### §3 账户
均 JWT；`mode` query 缺省 US。
- GET /account?mode=：{account: Account 实体, positions: Position[]}。Account 关键字段：cash、leverage、borrowed（融资负债）、shortCollateral、marginUsed、totalEquity、dayStartEquity、initialEquity、peakEquity、dailyPnl、totalPnl、tier、tierScore、currentDay（账户.entity.ts:34-93）。
- GET /account/metrics：{account, metrics}；metrics 含 totalReturn/sharpeRatio/maxDrawdown/calmarRatio/winRate/volatility/totalTrades/pairedTrades/pairedWinRate/profitFactor/monthlyPnl（risk-manager.service.ts:196-241）。
- GET /account/history：净值曲线 [{day, equity, return}]（risk-manager.service.ts:172-174）。
- GET /account/transactions?limit=（≤300）：资金流水/交割单 [{id,orderId?,symbol,side,quantity,price,turnover,commission,stampDuty,transferFee,totalFees,createdAt}]（transaction.entity.ts:15-66）。
- GET /account/reviews：个人+全局复盘卡 ≤20（risk-manager.service.ts:80-83）。
- POST /account/leverage?mode= body {"leverage":2}：1~3 数字；400 越界（account.service.ts:115-124）。
- POST /account/reset?mode= body {"preset":"散户|机构|日内交易者"}：依次拒绝 ①RESET_ENABLED=false（大赛）②赛季中已报名 ③有持仓 ④有基金份额 ⑤有挂单 ⑥距上次重置 <1 游戏日；成功重置现金/权益/杠杆并审计落库。返回 {success,error?} 风格（多数拒绝为 200+{success:false,error}，account.service.ts:139-207）。
- POST /account/transfer?fromMode=CN&toMode=US body {"amount":1000}：动态汇率折算+0.1% 手续费；返回 {success, received}；赛季报名中禁划转。
- GET/POST /account/achievements：GET 列表；POST body {"code": "≤40 字符"} 幂等解锁 {success, duplicate?}。

### §4 交易（本文件重写重点）
均 JWT；`mode` query 缺省 US。
- POST /trading/order?mode=：body {symbol, type, side, quantity(1-1000000), price?, triggerPrice?, displayQty?}（PlaceOrderDto 校验 order.controller.ts:25-64）。
  - type 全枚举：market/limit/stop/stop-limit/fok/ioc/iceberg（order.entity.ts:16-24）。
  - side 全枚举：buy/sell/short/cover（order.entity.ts:25-30；**CN 禁 short/cover**——order.service.ts:63-65 直接返回 {success:false,error:'A股模式不支持做空/融券'}；T+1 仅 CN：当日买入次日可卖 trading-engine.service.ts:411-417）。
  - 语义表（trading-engine.service.ts:184-316，文档逐条给）：
    - market：即时按盘口+滑点全量市价成交，不进盘口；返回 settle（见下）。
    - limit：挂真实盘口排队（价格-时间优先），触发后限价封顶撮合，可部分成交续排（:271-316, :593-598）。
    - stop：带 triggerPrice；市价触发（价格穿越触发价即转市价，无流动性重试 10 次后撤 :599-646）；不挂盘口。
    - stop-limit：带 triggerPrice+price；触发后才按限价撮合，**触发前严禁入盘口**（:272-274 注释根因）。
    - fok：限价全成否则撤；未全成回滚对手方（:209-227）。
    - ioc：限价立即成交可部分，剩余撤销（:209-252）。
    - iceberg：quantity=总量、displayQty=显示量（1..总量-1，校验 :341-346）；显示量上盘口，吃尽后同价队尾补量（:253-316 + matching-engine.ts:208-221）。
  - 市场闸门顺序（400 文案照抄）：休市拒单 → CN 集合竞价 9:25-9:30 禁申报 → 跨市场禁（symbol 前缀与 mode 不符）→ **盘后固定价格交易（CN 15:00-15:30）：仅限 LIMIT 且 price==当日收盘价**（order.service.ts:71-89）→ 购买力校验（BUY：估算成本 ≤ cash×leverage，真杠杆口径 trading-engine.service.ts:385-388）→ 做空保证金/券源（SHORT）→ 持仓/T+1（SELL/COVER）→ CN 委托价涨跌停带宽（昨收基准 ±10%，新股首日 +44%/-36%，trading-engine.service.ts:363-380）。
  - 返回：market/fok/ioc 立即成交 → `{success, fill:{symbol,side,quantity,price,totalCost,fees}, fees}`（**注意 HTTP 成交对象是 quantity/price 命名**，engine settleFillInner 572-576 经 order.service.ts:94-97 直返）；limit/stop/stop-limit/iceberg → `{success, order: Order实体}`（含 id/status/triggerLog/displayQty/hiddenQty/postClose 等，order.entity.ts）；拒绝 → `{success:false, error}`（HTTP 200）。
- **DELETE /trading/order/:id**?mode=：撤单。仅 PENDING 可撤（engine cancelOrder trading-engine.service.ts:713-737，找不到返回 {success:false}）；CN 集合竞价 locked/matching 窗口禁撤（order.service.ts:100-111）；盘后单从 closingBook 移除。
- GET /trading/orders/pending?mode=：本账户 PENDING 列表（含盘后单 postClose:true）。
- **GET /trading/history**?mode=：本账户最近 100 条交割单（order.service.ts:112-121，Transaction[] 同 §3.4 格式；与 /account/transactions 同源同构，区别是固定 100 条/无 limit 参数）。
- 资金/成交内部口径（写成"规则说明"小节）：BUY 拆分为自有资金=总额/杠杆 + 借入记 borrowed（trading-engine.service.ts:528-533）；SELL 按持仓负债比例还款（:534-541）；融资利率 0.02%/日（日终按 borrowed+shortCollateral 计息，risk-manager.service.ts:114-119）；维持担保比=总权益/借入，<1.2 全仓强平、<1.3 追保部分平仓至 1.5、<1.4 预警（trading-engine.service.ts:1079-1109、1224-1331；日终 CN 结算后统一检查 market.service.ts:331）。

### §5 行情（全部无认证；本文件统一写明，纠正旧文含糊）
- GET /market/prices：{T1:45.3, ...} 三市场合并。
- GET /market/stocks：三市场合并股票列表，元素见 market-data.service.ts:1564-1582（symbol/market/name/code/listDate/description/industry/price/changePct/dayOpen/dayHigh/dayLow/dayVolume/adjFactor/adjustmentSeries）。
- GET /market/indices、GET /market/reports?symbol=（财报，market-data.service.ts:1683-1719 形态）、GET /market/ai-opponents（pnlPct 排序）、GET /market/flow-signals?symbol=（OFI+大单）。
- GET /market/state：完整字段表（§1.4 行）；**isPostCloseTrading**、isTradingTime、fxRates、offHoursTrading（调试全服开关）、markets.CN/HK/US 各自 state。
- GET /market/klines?symbol&timeframe=：1min|5min|60min|daily|weekly|monthly（缺省 1min；60min 按小时聚合）。
- GET /market/orderbook?symbol=：{asks,bids,spread,sealedUp?}（合成深度+真实挂单合并显示）。
- GET /market/backtest：query symbol/fast(5)/slow(20)/timeframe(1min)/strategy(ma_cross|rsi_reversal|momentum，非法回退 ma_cross)/slippageBps(0=市场默认)/period(14)/momentumN(10)；返回回测报告（字段照 market.service.ts:544-559 + backtest-engine 输出：bars/initialCash/finalEquity/totalReturn/annualizedReturn/maxDrawdown/sharpe/profitFactor/trades/winRate/fees/slippageCost/benchmarkReturn/equityCurve/equityCurveBench）；**限流 20/min/IP**。
- （旧文档"每 1 秒推送一次行情"等 WS 口径移入 §9。）

### §6 基金
- GET /fund（公开）：[{id:'fund-1',name:'沪深300 ETF',type:'ETF',nav,dailyReturn,subscribeFeeRate:0.0015}, {id:'fund-2', 货币基金 A, subscribeFeeRate:0}]（fund.service.ts:52-61）。
- GET /fund/:id（公开）。
- POST /fund/:id/subscribe?amount=&mode=（JWT，**参数在 Query**）：申购费 ETF 0.15%/货基 0，份额按扣费后净额；返回 {success, shares, nav, fee}；余额不足/赛季报名中/未知基金 → {success:false,error}。
- POST /fund/:id/redeem?shares=&mode=（JWT）：赎回费按持有游戏日 <7→1.5%、7-30→0.5%、≥30→0；返回 {success, amount, nav, holdDays, feeRate}。

### §7 赛季（类级 JWT：四个端点全要 token——season.controller.ts:73）
- POST /season/enroll：报名三市场账户；首个报名者触发开赛（anchorDay 定格，10 游戏日赛季）；重复报名/已开赛 → {success:false,error:'当前赛季已开赛，报名已截止'}；成功 {success, season:{id,seq,name,status,anchorDay,durationDays}, entries[], created}。
- GET /season/current：我的状态 {season:{...,daysLeft}, enrolled, myReturn, myRank}。
- GET /season/leaderboard?market=ALL|CN|HK|US&limit=：合成收益率口径（Σ净值-Σ起点）/Σ起点，limit 钳 1..100；[{userId, seasonReturn(%), seasonPnl}]（注意：此表返回 userId 原值，未脱敏——与 ranking 不同，如实写文档并注明隐私取舍）。
- GET /season/history：最近 5 届已结算赛季 {seq,name,settledAt,champions[]}。
- 规则注明：赛季 RUNNING 中、有 ACTIVE 报名的用户被冻结——账户重置、跨市场划转、基金申购/赎回（season.service.ts:111-117 被 account/fund service 引用）。

### §8 排行与管理
- GET /ranking?limit=&sort=totalReturn|dayReturn|equity&market=（JWT）：limit 钳 1..50；输出 {market,tier,username(脱敏 前2+*),totalEquity,totalReturn,dayReturn,rank}，无 userId（ranking.service.ts:82-107）；内存缓存由 ranking.scheduler.ts 每 30s + 启动 10s 后重算。
- GET /admin/stats、GET /admin/users?page&limit（1..100）、POST /admin/users/:id/toggle body {"isActive":bool}（禁自己 400 '不能禁用当前登录的管理员账号'、禁最后一个活跃管理员 400、目标不存在 404）、POST /admin/debug {"on":bool}、GET /admin/debug、POST /admin/debug/global {"on":bool}：全部需 ADMIN role，否则 403 '无权限'。

### §9 WebSocket（重写旧 §4）
- 地址 ws://host:8000/market（namespace /market，socket.io）；握手 auth.token=JWT；缺 token/无效载荷/用户禁用 → 服务端立即 disconnect。
- 事件表（gateway 实际 emit 形态，market.gateway.ts:54-62）：
  - tick：`{ticks:[{symbol,price,volume,timestamp}], timestamp}`（纠正旧文档虚构的 {type,data} 包裹）。
  - fill：`{symbol,side,filledQuantity,avgPrice,totalCost,fees,counterFills:[{side,price,qty,virtual}]}`——**脱敏后形态**（2.5 实施后；counterFills 只含展示字段，不含对手方身份）。
  - news：`{title,description,type:bullish|bearish|neutral|insider|night,impact,duration}`，部分新闻带 targetedSymbol 与嵌套 insiderNews。

### §10 量化接入示例（纠正版）
- Node/Python 示例按 §1-§9 新端点改：login 返回体含 user+token；下单 mode 三市场；撤单用 DELETE；轮询 pending + GET /trading/history；WS 示例 auth 回调。旧文档引用的 `backend/scripts/quant-bot.js` 若无实现则删引用（核实后再写，勿臆造）。

### §11 通用规则速查（给量化 AI 的一页口径）
费率表（US_FEES/HK_FEES/CN_FEES，constants/index.ts:94-130：CN 佣金 0.025% 最低 5 + 卖出印花税 0.1% + 过户费 0.002%；HK 佣金 0.03% 最低 50 + 卖出印花税 0.13% + 交易费 0.005% + 征费 0.0027% + 交易费?——以代码为准逐项列出）、红利税二档、涨跌停（含首日 +44%/-36% 更正）、T+1、做空保证金率（个股 0.5-0.65 动态）、杠杆/borrowed/维持担保比三级、盘后窗口、竞价窗口、赛季冻结、重置冷却、汇率动态带。

### §12（附录）实现与文档路由对照抽查测试设计（phase10 静态抽查）
新测试文件（建议 `backend/test/phase10-api-doc-routes.test.js`）：
- 读取 `docs/API.md` 文本（`path.resolve(__dirname, '../../docs/API.md')`——jest rootDir=backend，测试文件在 backend/test）。
- **必须包含**字符串清单（路由真值来自 §1.1 表）：
  `POST /auth/register`、`POST /auth/login`、`GET /user/profile`、`PUT /user/profile`、`GET /account`、`POST /account/leverage`、`POST /account/reset`、`POST /account/transfer`、`GET /account/metrics`、`GET /account/transactions`、`GET /account/reviews`、`GET /account/achievements`、`POST /account/achievements`、`POST /trading/order`、`DELETE /trading/order/:id`、`GET /trading/orders/pending`、`GET /trading/history`、`GET /market/prices`、`GET /market/stocks`、`GET /market/indices`、`GET /market/state`、`GET /market/reports`、`GET /market/ai-opponents`、`GET /market/flow-signals`、`GET /market/backtest`、`GET /market/klines`、`GET /market/orderbook`、`GET /fund`、`POST /fund/:id/subscribe`、`POST /fund/:id/redeem`、`POST /season/enroll`、`GET /season/current`、`GET /season/leaderboard`、`GET /season/history`、`GET /ranking`、`GET /admin/stats`、`GET /admin/users`、`POST /admin/users/:id/toggle`、`POST /admin/debug`、`GET /admin/debug`、`POST /admin/debug/global`。
- **必须包含**语义字符串：`fok`、`ioc`、`iceberg`、`isPostCloseTrading`、`counterFills`、`维持担保比`（或 1.2/1.3/1.4 阈值）、`15:00`（盘后窗口）、`20%`（红利税）。
- **禁止出现**（旧漂移残留）：`POST /trading/order/:id/cancel`、`GET /trading/orders/history`、`targetedSymbol`（若已移入正确定义处则从禁词中剔除——禁词表以最终版为准，实施时对照 §1.2 漂移表逐条定）。
- 断言骨架：
```js
const fs = require('fs');
const path = require('path');
const apiMd = fs.readFileSync(path.resolve(__dirname, '../../docs/API.md'), 'utf8');
describe('API.md 与实现路由一致（静态抽查）', () => {
  const MUST_HAVE = [ /* 上表 */ ];
  test.each(MUST_HAVE)('收录实现路由 %s', (route) => { expect(apiMd).toContain(route); });
  const MUST_NOT = ['POST /trading/order/:id/cancel', 'GET /trading/orders/history'];
  test.each(MUST_NOT)('不残留漂移路由 %s', (bad) => { expect(apiMd).not.toContain(bad); });
});
```

---

## 4. ③phase10 用例清单（主 agent 编写；参照 phase9 fakeRepo 风格）

统一前置：`require('../dist/src/...')`（先 build）；fakeRepo 照抄 phase9-season-rules.test.js:11-30（rows/find/findOne/save/create/delete + matchesWhere）。

### 4.1 登录防爆破（`new AuthService(userRepo, accountRepo, fakeJwt)`）
```js
const { AuthService } = require('../dist/src/modules/auth/auth.service');
const bcrypt = require('bcrypt');
function makeAuth(over = {}) {
  const userRepo = {
    findOne: over.findOne || (async () => ({ id: 'u1', username: 'alice', password: 'hashed', role: 'user', isActive: true })),
  };
  const accountRepo = {};            // 登录路径不触达 accountRepo
  const jwt = { sign: jest.fn(() => 'tok') };
  const svc = new AuthService(userRepo, accountRepo, jwt);
  return { svc, jwt };
}
```
用例与断言要点：
1. **5 次错密码 → 第 6 次即使密码正确也锁定**：`jest.spyOn(bcrypt, 'compare')` 前 5 次 `mockResolvedValueOnce(false)`、第 6 次 `mockResolvedValueOnce(true)`；连调 5 次 `svc.login('alice','x')` 均 reject UnauthorizedException '用户名或密码错误'；第 6 次调用 → reject 且 message 含 '尝试次数过多'；**断言第 6 次 bcrypt.compare 未被调用**（锁前置短路，可用 `mock.calls.length === 5` 佐证）。
2. **锁定期外恢复**：锁时长做成实例字段后可覆写——直接 `svc.LOGIN_LOCK_MS = 1` 后连错 5 次 → `await new Promise(r => setTimeout(r, 5))`（真实毫秒等待，锁 1ms）→ 正确密码（compare mockResolvedValue(true)）→ resolve 返回 {token:'tok'}。断言 `jwt.sign` 被调用（成功路径）。
3. **成功登录清零计数**：错 4 次 → 成功 1 次（compare mockResolvedValue(true)）→ 再错 4 次 → 第 9 次正确密码成功（若未清零会锁）。断言无锁定异常。
4. **不存在的用户名同样计数并锁定**：findOne 返回 null；错 5 次（无 bcrypt 调用）→ 第 6 次同用户名 → '尝试次数过多'；**错误文案与"密码错误"一致**（防枚举断言：抛错 message 均为 '用户名或密码错误' 或 '尝试次数过多，账号已锁定10分钟'，无第三种）。
5. **trim 规范化**：login(' alice ') 与 login('alice') 共享计数（5 次混合错 → 锁）。findOne 收到的 where.username === 'alice'（trim 后查询）——`expect(findOneSpy.mock.calls.at(-1)[0].where.username).toBe('alice')`。
6. （回归护栏）正常登录成功即删 Map 条目：可断言 `svc.loginFails.has('alice') === false`——私有字段在 JS 类里就是普通属性，测试可直接访问。

### 4.2 WS isActive 断连（`new MarketGateway(jwtService, userRepo)`）
```js
const { MarketGateway } = require('../dist/src/modules/market/market.gateway');
const { JwtService } = require('@nestjs/jwt');        // 真实 JwtService 签 token
const jwtSvc = new JwtService({ secret: 'phase10-test-secret-0123456789' });
const token = jwtSvc.sign({ sub: 'u1', username: 'bob', role: 'user' });
function fakeClient() {
  return { id: 'c1', handshake: { auth: { token } }, disconnect: jest.fn() };
}
```
用例：
1. **isActive:false 的用户被断开**：userRepo.findOne = async () => ({id:'u1', isActive:false})；`await gateway.handleConnection(fakeClient())` → `expect(client.disconnect).toHaveBeenCalledWith(true)`。
2. **用户不存在（findOne null）断开**：同上断言。
3. **isActive:true 放行**：findOne → {isActive:true}；disconnect 未被调用；`gateway.clients === 1`（连上计数）。
4. **缺 token / 坏 token 仍断开**（回归既有 SECURITY(C) 行为）：auth:{token:null} 与 auth:{token:'bad'}（verify 抛错）→ disconnect(true)。
5. **jwtService 用假实现也可跑**：备选 mock jwtService = {verify: jest.fn(()=>({sub:'u1'}))}——两法都写，真实签名更有说服力（也验证 market.module 的 JWT secret 一致性不在本单测范围）。
注意：fake client 无需 server；gateway.handleConnection 现为 async，直接 await。断开分支不触碰 `this.server`（broadcast 才用）。

### 4.3 sanitizeFill 纯函数
```js
const { sanitizeFill } = require('../dist/src/common/market-utils');
```
用例：
1. **剥离身份字段**：输入 `{symbol:'T1',side:'buy',filledQuantity:100,avgPrice:45.3,totalCost:4530,fees:{totalFees:1.13},counterFills:[{orderId:'o1',accountId:'a1',side:'sell',price:45.3,qty:60,virtual:false,mmId:'m1'},{orderId:null,accountId:null,side:'sell',price:45.31,qty:40,virtual:true}]}` → 输出的 counterFills 深度相等 `[{side:'sell',price:45.3,qty:60,virtual:false},{side:'sell',price:45.31,qty:40,virtual:true}]`；**顶层 filledQuantity/avgPrice/fees 原样保留**；JSON 序列化后不含 'orderId'/'accountId'/'mmId' 子串。
2. **不修改输入**（纯函数）：调用后输入对象 counterFills[0] 仍含 accountId。
3. **边界**：counterFills 缺失/非数组 → 原样浅拷贝返回；null/undefined → 原样返回；空数组 → counterFills: []。

### 4.4 Swagger dev-only 与 backtest 限流（静态断言，推荐做法）
理由（写进测试注释）：现 217 例全是服务层单测（jest.config.js testMatch test/*.test.js，require dist 单类）；main.ts 的改动在 Nest app 装配层，起完整 app 代价高（TypeOrm better-sqlite3 DataSource + MarketDataService.init 需要真库文件与定时器；MarketService 构造还有 SANDBOX_FAST 校验：TICK_INTERVAL_MS<60000 且非 'true' 直接 throw，market.service.ts:63-68）。**推荐纯静态文本断言**，零启动、秒级：
```js
const fs = require('fs');
const path = require('path');
const mainJs = fs.readFileSync(path.resolve(__dirname, '../dist/src/main.js'), 'utf8');
describe('main.ts 安全装配（静态抽查编译产物）', () => {
  test('backtest 限流已挂载（20次/分路径限流）', () => {
    expect(mainJs).toContain("'/api/market/backtest'");   // app.use 路径参数
    expect(mainJs).toContain('rateLimit(');                // express-rate-limit 调用
    // 20 次阈值：backtestLimiter 配置字面量
    expect(mainJs).toMatch(/windowMs: 60 \* 1000[\s\S]{0,400}max: 20/);
  });
  test('Swagger 仅在 development 挂载（NODE_ENV 门内才出现 setup 调用）', () => {
    expect(mainJs).toContain("process.env.NODE_ENV === 'development'");
    const gateIdx = mainJs.indexOf("process.env.NODE_ENV === 'development'");
    const setupIdx = mainJs.indexOf('SwaggerModule.setup');
    expect(setupIdx).toBeGreaterThan(gateIdx);             // setup 出现在门之后（同一 if 体内）
    // 更严：setup 到门之间只隔一个函数体（无其它 "development" 门的干扰；宽松断言即可防手滑）
  });
});
```
局限说明（注释里写明）：静态断言防"改没了/忘加"，不防"门写错逻辑"；如需真 HTTP 验证（supertest + createNestApplication 打 429 与 404 /api/docs），可作为可选慢用例单列——若走此路必须：`.env` 设 `TICK_INTERVAL_MS=60000`（或 `SANDBOX_FAST=true`）绕开 market.service.ts:66 启动抛错；用 `SQLITE_PATH` 指向临时文件并在 afterAll 删除 + `app.close()` 清定时器（tick 循环 setTimeout 自续，close 才能终止）；jest 默认 30s 超时够用。**默认不加**，避免 CI 变慢与本地库文件污染。

---

## 5. ④风险与回归点

| 风险 | 影响面 | 缓解/回归点 |
|---|---|---|
| 编译风格装饰器：gateway 加构造参数忘改底部 `__metadata("design:paramtypes", ...)` / 忘加 `__param(1, InjectRepository)` | DI 实例化失败或注入 undefined，启动即挂 | 实施后 `npm run build && node dist/src/main.js` 冒烟一次；§2.4.2 骨架已含底部数组全文；对比 auth.service.ts:130-140 模板 |
| 测试引用 dist：改动后未 build 就跑 jest | 测的是旧码 | 流程固定 `npm run build` → `npm test`（package.json scripts）；phase10 文件里 require dist 同款 |
| sanitizeFill 剥离后 WS fill 契约变化 | 前端 fill 监听若读 counterFills[].accountId 会拿到 undefined（本来也不该读） | 顶层字段零改名（filledQuantity/avgPrice 保持）；只在广播层脱敏，DB/HTTP 口径不动；§4.3 单测锁形状 |
| 登录锁误伤正常玩家（5 连错来自手滑/密码管理器） | 锁 10 分钟，文案明确；IP 限流 10/min 已先行 | 文案 '尝试次数过多，账号已锁定10分钟'；成功即清零；重启即解除（内存态）；API.md 标注 |
| 不存在的用户名也计数 → 攻击者可对任意名字制造"锁定态" | 无法借此获利（锁的是攻击目标自己也无利可图），但可干扰他人登录 | 已记录取舍（§2.3 决策 2）；本项目无真实资金，接受；如未来对抗 DoS 需改为 IP 维度锁定或验证码 |
| register 的 409 可枚举用户名（既有行为，本次不改） | 用户名枚举面 | 记为 P2 债入 tech-debt-register（附切换触发条件：产品要求注册匿名化时） |
| Swagger 仅 dev：production 下 /api/docs 404 | 运维查接口要翻 API.md | 正是目的；API.md 本次重写即兜底 |
| backtest 限流对量化 bot 20/min 可能不够 | 高频策略脚本受限 | 阈值 20/min 可调；文档写明；如需放开可为该端点加 token 可选认证（本期不做） |
| WS handleConnection 变 async 后 Nest 等待语义 | socket.io 握手在查库期间挂起（毫秒级）；DB 故障时 catch 分支断连 | 单测 4.2 覆盖四分支；market-data 全内存 + SQLite 查询极快，延迟可忽略 |
| app.module.ts / .env 里历史 GBK 乱码注释（PowerShell Get-Content 显示为 �） | 不涉及本次改动文件 | 只读不动；改文件用 read/write 工具而非 Get-Content |
| 排行榜/赛季数据时效（内存缓存/调度刷新） | API.md 需写清口径避免量化侧误读 | §3 §8 已注明 ranking.scheduler 30s 重算；season leaderboard 实时聚合 |
| API.md 抽查测试字符串与最终文案不一致 | 静态断言脆 | 断言只针对"方法+路径"粗粒度字符串，禁对文案细粒度断言；禁词表以 §1.2 漂移表为准，随文档定稿同步 |

回归点汇总（改完跑一遍）：`npm run build && npm test`（现有 217 例不得红——除 phase9 外无 auth/WS/广播相关单测，预计零影响）；`node dist/src/main.js` 启动日志正常；浏览器连一次 WS（token 有效/无效/禁用用户三态）。
