# Phase E 方案 01：竞技化——模拟大赛 V2 + 债务清理

> 方案设计师：AI（Phase E 方案组）｜预计实施 45–70 分钟
> 覆盖任务①（seasonPoints 拆列）/ 任务②（大赛 V2：赛季类型/赛程日历/战绩档案/积分榜）/ 任务③（注册枚举面收口）/ 任务④（除权日 T+1 核验）/ 任务⑤（验证项执行清单）/ 任务⑥（phase11 测试用例清单）。
> 所有结论均基于源码实读，引用格式 `文件:行号`（backend/src 下省略前缀 `backend/src/`，backend/test 下省略前缀 `backend/`；frontend/src 下省略前缀 `frontend/src/`）。本方案只产出设计文档，不改任何源码/测试。
> 输出物：`docs/phaseE-plans/01-season-v2.md`（本文）。

---

## 0. 结论速览

| 任务 | 结论 | 必改文件（实施期） |
|---|---|---|
| ① seasonPoints 拆列 | account 加 `seasonPoints float default 0` 列（synchronize 自动迁移）；settleSeasonInner 奖励由 tierScore 累加改为 seasonPoints；**前端零改动**（tierScore 唯一消费点 Profile.tsx:113「评分」仍是段位口径） | account.entity.ts、season.service.ts、phase9-season-rules.test.js |
| ② 大赛 V2 | A：seasons 加 `type` simple-enum（weekly=5/biweekly=10/monthly=20），轮换制开赛（保留 durationDays 列不删，读侧零改动）；B：`GET /season/schedule`（建议 JWT，沿用类级守卫，不引 @Public 机制）；C：`GET /season/archive/:seasonId`（**最小口径：起点+终点两点曲线**——season_entries 无逐日净值且 daily_snapshots 无 accountId 无法归属，依据见 §2.4）；D：`GET /season/points`（**用户级口径取 max(该用户各账户 seasonPoints)**——sum 会把同一场胜利按三市场账户 ×3；连续获奖由 entries 推导，不做结算时增量记列） | season.entity.ts、season.service.ts、season.controller.ts、（season.module.ts 无改动）、API.md |
| ③ 注册枚举收口 | **推荐方案 B**（统一 200 + `{success:false}` + 前端同批改分支）：一次性消除状态码 oracle，前端仅 1 处逻辑改动且 0 测试影响；方案 A（保留 409 + 5/min 独立限流）作为保守备选。**teams 裁决** | auth.service.ts、api.client.ts、Login.tsx、API.md、（A 案另加 main.ts） |
| ④ 除权日 T+1 | 行为核验结论：除权日买入按除权价入账、T+1 无除权日特例（与真实 A 股一致）——**代码层无差距**，REALISM.md:41 措辞过时需注记；实读发现相邻真缺陷：**lockDay 从不记账**（trading-engine.service.ts:548 建仓恒 0、updatePosition 不更新）→ 红利税持有期恒 0、CN 恒按 20% 档。小改骨架 = 建仓行记 `lockDay: Number(account.currentDay) || 0`（1 行，零存量测试涟漪，依据见 §4.3） | trading-engine.service.ts（1 行）、REALISM.md:41 |
| ⑤ 验证项 | 盘后窗口浏览器冒烟（真实 15:00–15:30 执行销台账 open 条目）+ Docker compose 端到端冒烟 + 无 Docker 降级登记 | 不改码；tech-debt 台账销账 |
| ⑥ phase11 测试 | 新文件 `phase11-season-v2.test.js`（4 组 ≥16 例）+ phase9 两处断言改口径 + API.md 同步 | 见 §6/§7 |

基线：后端 304 例 / 前端 52 例全绿（`npm run build && npm test -- --runInBand`，测试引用 dist 产物——jest.config.js 全仓 test/**/*.test.js，phaseD 文档实证）。每个规则改动带 phase11 测试；commit `[AI]` 前缀分块。

---

## 1. 任务① seasonPoints 拆列（销 P2：tierScore 双语义冲突）

### 1.1 冲突实证（两写方 + 一列）

| 写方 | 代码 | 语义 |
|---|---|---|
| 赛季奖励（累加） | season.service.ts:197-204——`rewards=[300,200,100]`，:201 `account.tierScore = Number(account.tierScore || 0) + rewards[i]`；对**该用户全部市场账户**循环累加（同一场胜利三账户各 +300） | 荣誉分，只增不减 |
| computeTier（覆盖） | risk-manager.service.ts:106-112——:111 `account.tierScore = score` 整体赋值；调用点 :198-205 `settleAllAccounts` 每交易日日终逐账户执行 | 段位分（tier.ts 纯函数产出，data-driven 0~100 档） |
| 列定义 | account.entity.ts:89 `Column('float', { default: 0 })` tierScore | 单列双用 |

调用链：`settleAllAccounts` 由 market.service.ts:330（仅 CN 实例 tick counter===239，:328-331）触发 → 赛季奖励由 season.scheduler.ts:24-35（30s 轮询）→ `maybeSettleByClock`（season.service.ts:218-231）→ `settleSeason()`。

**实际症状**（双语义冲突的玩家可见后果）：赛季结算瞬间 tierScore 被 +300/200/100，但下一个交易日日终 `computeTier` 整体覆盖 → 荣誉分被"洗掉"回退为段位分；反之赛季奖励也把"段位评分"含义污染（展示层 Profile「评分」）。

### 1.2 读取面核查（改列是否破坏前端/其他后端）

- 前端全仓 grep `tierScore`：唯一命中 `pages/Profile/Profile.tsx:113`——`评分 {account.tierScore}`，数据来自 `accountApi.metrics`（后端 account.service.ts:113 `return { account, metrics }` 原样吐账户实体）。语义 = 段位分 → **拆列后该显示不变，无前端改动**。
- Ranking 榜（ranking.service.ts:65/100 只输出 `tier`，无 tierScore）、赛季榜（season 模块原样透传 seasonReturn/seasonPnl）、个人中心其余字段均不读 tierScore。
- 后端全仓 grep `tierScore` 写方仅 2 处（risk-manager.service.ts:111/204 + season.service.ts:201）→ 拆列后除 season.service 外无消费者，改动面收敛。
- 另注意 V1 把奖励累加在**每市场账户**上（:199-203 对该用户全部 accounts 循环）——拆列到 seasonPoints 后该"三账户同额"语义保留（§2.5 积分榜口径由此而来）。

### 1.3 改动清单

**改动 1-1｜account.entity.ts**：在 tierScore 装饰块（:87-90）后追加编译风格列（类无构造参数，**无需动底部装饰块**；synchronize 自动 `ALTER TABLE accounts ADD COLUMN seasonPoints float DEFAULT 0`，存量行自动 0——先例：daily_snapshots/positions 各期加列均走 synchronize:true，app.module.ts:81-88）：

```ts
// 在 :90 totalTrades 装饰块之后追加：
__decorate([
    (0, typeorm_1.Column)('float', { default: 0 }),
    __metadata("design:type", Number)
], Account.prototype, "seasonPoints", void 0);
```

**改动 1-2｜season.service.ts settleSeasonInner**（:169 注释 + :196-204 累加目标改列；`rewards` 常量抽为服务级共享查表 `rewardFor(rank)`，供 §2.4 archive/§2.5 points 复用防常量漂移）：

```ts
// 结算：active 报名固化 finalEquity/finalReturn/排名；前三 seasonPoints +300/200/100（荣誉积分，
// 不再累加 tierScore——tierScore 由 computeTier 每日覆盖为段位分，双语义冲突见 phaseE 方案 01）
// 前三 seasonPoints 奖励（荣誉体系，不印钱；与 V1 一致：该用户全部市场账户同额累加）
const rewards = [300, 200, 100];
for (let i = 0; i < Math.min(3, ranking.length); i++) {
    const accounts = await this.accountRepo.find({ where: { userId: ranking[i].userId } });
    for (const account of accounts) {
        account.seasonPoints = Number(account.seasonPoints || 0) + rewards[i];
        await this.accountRepo.save(account);
    }
}
```

其余（entries 固化 :205-209、status SETTLED :210-213、幂等锁 :170-174）不动。

**改动 1-3｜存量数据不迁移，说明理由**：旧库 tierScore 里混入的奖励分**不再追回/拆出**。理由：①历史上每次结算后奖励分都会被下一个交易日日终的 computeTier 覆盖（§1.1），当前存量值基本已是段位口径，仅"最近一次结算 → 下一个日终"窗口内存在 +300 级残留，量小且无玩家资产语义（荣誉不印钱）；②逐赛季重算历史奖励需要审计"结算时刻净值排行"，无历史回放数据支撑，成本高收益零；③拆列后 seasonPoints 从 0 起算、新赛季即正确，赛季积分榜口径自 Phase E 干净；④旧赛季荣誉在 §2.4 archive 端点按 entries.finalRank 推导展示"历史奖牌"，不依赖 seasonPoints 列——旧荣誉仍可见。

**改动 1-4｜phase9-season-rules.test.js 断言改口径**（该文件是唯一断言赛季奖励的存量用例）：

| 位置 | 现值 | 改后 |
|---|---|---|
| :104-107 账户种子 | `{..., tierScore: 0 }` | 保留 tierScore:0，可补 `seasonPoints: 0`（fake 不校验字段，补上为可读性） |
| :140 用例标题 | `结算：固化收益与排名、前三 tierScore 奖励、幂等` | `……前三 seasonPoints 奖励……` |
| :154 | `expect(Number(u2.tierScore)).toBe(300); // 冠军奖励` | `expect(Number(u2.seasonPoints)).toBe(300);` **并追加** `expect(Number(u2.tierScore)).toBe(0); // 段位分不被赛季奖励污染` |
| :156 | `expect(Number(u1.tierScore)).toBe(200);` | `expect(Number(u1.seasonPoints)).toBe(200);`（可同加 tierScore 仍 0 断言；u1 三账户 AC1-3 同额 200） |

> 新增的"computeTier 之后 seasonPoints 不被覆盖"行为断言放 phase11（§6 组 1），因为 settleAllAccounts/computeTier 不在 SeasonService 依赖内，需按 risk-manager 路径单独组测。

---

## 2. 任务② 大赛 V2

### 2.0 现状实读（先修正两处任务书前提）

- **market.service 不直接调赛季结算**：market.service.ts 全文件 grep `season/Season` **0 命中**；赛季结算唯一入口是 season.scheduler.ts:24-35 的 30s 轮询 `maybeSettleByClock()`。market.service.ts:330 调的是 riskManager.settleAllAccounts（账户日终结算），两者是不同时钟路径，V2 不得混淆。
- 单赛季串行架构：ensureSeason（season.service.ts:48-65）用 `findOne` 只承认一个 ENROLLING/RUNNING 赛季；ENROLLING 且无报名时不会被调度结算（maybeSettleByClock 只处理 RUNNING :219-221）。**V2 的 type 轮换必须在这个单赛厅模型内做**（并行赛厅 = 结构改动，裁剪，远期）。
- season.entity.ts 现状：seq(Unique)/name/status(simple-enum enrolling|running|settled)/anchorDay(text JSON)/durationDays(int default 10)/startedAt/endedAt/settledAt——**无 type 列**；ensureSeason :60 硬编码 `durationDays: 10`。
- season-entry.entity.ts（:21-68）：id/seasonId/userId/accountId/marketMode/startEquity/startDay/status/finalEquity/finalReturn/finalRank/enrolledAt——**无任何逐日净值列**（影响 §2.4）。
- 报名/开赛：enroll（:70-109）首个报名者触发 RUNNING + anchorDay 定格（:102-107）；返回体 :108 含 `durationDays`。V1 冻结（isBlocked :111-117）消费方：account.service.ts:144/219（重置/划转）、fund.service（申购/赎回）——单 RUNNING 查询语义，type 轮换不触碰。

### 2.1 方案 A：赛季类型 + durationDays 由 type 决定

**字段改动｜season.entity.ts**：status 装饰块（:34-37）后追加 type 列；durationDays 列（:43-46）**保留不删**（myStatus/leaderboard/enroll 返回体都读它，season.service.ts:108/:163；保留列 = 读侧零改动，开赛时由 type 同步写入）：

```ts
// 赛季类型：weekly=5 / biweekly=10（现行为）/ monthly=20 游戏日；轮换开赛，见 season.service ensureSeason
export enum SeasonType {
    WEEKLY = 'weekly',
    BIWEEKLY = 'biweekly',
    MONTHLY = 'monthly',
}
// 类装饰块内追加：
__decorate([
    (0, typeorm_1.Column)({ type: 'simple-enum', enum: SeasonType, default: SeasonType.BIWEEKLY }),
    __metadata("design:type", String)
], Season.prototype, "type", void 0);
```

存量行自动落 `biweekly`（synchronize ALTER + default），与现库 10 日语义一致，无需迁移脚本。

**开赛逻辑｜season.service.ts**：type 轮换 + durationDays 由 type 驱动。轮换表第一个元素放 biweekly，保证"改造后首个新赛季仍是现口径"，存量/在途赛季不受影响（ensureSeason 只在无赛季时建新）：

```ts
// type 轮换表（单赛厅模型：每周→双周→月赛循环；快档压缩时间轴下"真实日历"语义失真，不用日历锚定）
const SEASON_TYPE_CYCLE: string[] = ['biweekly', 'weekly', 'monthly'];
const TYPE_DURATION_DAYS: Record<string, number> = { weekly: 5, biweekly: 10, monthly: 20 };

async ensureSeason() {
    let season = await this.seasonRepo.findOne({ ... }); // 原逻辑不变
    if (!season) {
        const settled = await this.seasonRepo.find({ order: { seq: 'DESC' }, take: 1 });
        const seq = (settled.length ? Number(settled[0].seq) : 0) + 1;
        const type = SEASON_TYPE_CYCLE[(seq - 1) % SEASON_TYPE_CYCLE.length];
        season = await this.seasonRepo.save(this.seasonRepo.create({
            seq,
            name: `第 ${seq} 赛季`,
            status: season_entity_1.SeasonStatus.ENROLLING,
            anchorDay: '{}',
            type,
            durationDays: TYPE_DURATION_DAYS[type], // durationDays 读侧不变，仍按天结算
        }));
        this.logger.log(`🏆 新赛季开启: 第 ${seq} 赛季（${type}，${TYPE_DURATION_DAYS[type]} 游戏日）`);
    }
    return season;
}
```

（骨架中省略处 = 逐字沿用现有 :49-51/:53-54。）结算/调度（maybeSettleByClock :218-231 读 season.durationDays）零改动。enroll 兼容：无 body，参加当前唯一 ENROLLING 赛季——**路由向后兼容**，type 对报名者透明（前端横幅可展示类型标签，见 §2.6）。

### 2.2 方案 B：赛程日历 `GET /season/schedule`

- **鉴权建议：沿用 JWT**（season.controller.ts:73 类级 `UseGuards(JwtAuthGuard)` 已覆盖全部端点）。理由：本项目无 `@Public`/isPublic 机制，为单端点开旁路需新增守卫逻辑（成本>收益）；数据无敏感度但也无公开消费场景（前端恒登录态）。如 teams 倾向公开，另行加白名单中间件——本方案按 JWT 设计。
- **时间语义**：不含真实日期——快档（TICK_INTERVAL_MS<60000）下游戏日与真实日解耦（market-data.service.ts:1235/1354 gameDay 计数与本地时钟无关，SANDBOX_FAST 门槛 main.ts:65-68），真实日期无意义。全部用**相对当前 CN 游戏日的偏移**表达。
- **返回结构**（纯查询 + 纯计算，不写库；未来届为合成行不落库）：

```jsonc
GET /api/season/schedule?count=6
{
  "today": { "CN": 87, "HK": 87, "US": 87 },          // 当前各市场游戏日（gameDays()）
  "seasons": [
    { "seq": 5, "name": "第 5 赛季", "type": "biweekly", "status": "running",
      "startDay": 0, "durationDays": 10, "daysLeft": 4, "anchorDay": {"CN": 77, "HK": 77, "US": 77} }, // DB 行
    { "seq": 6, "name": "第 6 赛季", "type": "weekly", "status": "upcoming",
      "startDay": 4, "durationDays": 5, "daysLeft": null },                                                // 合成行
    { "seq": 7, "name": "第 7 赛季", "type": "monthly", "status": "upcoming",
      "startDay": 9, "durationDays": 20, "daysLeft": null }
  ]
}
```

- **service 骨架**（纯读；`startDay` 口径：DB 赛季相对 today 为 0；合成行 startDay = 上一期 startDay + 上一期 durationDays；若当前赛季 ENROLLING 无 anchorDay（未开赛）则其 durationDays 满打作本期长度）：

```ts
// 赛程日历：DB 当前赛季（enrolling/running）+ 合成未来 count-1 届（不落库）。
// 注意 mockRepo 场景 find 无 order 支持 → 服务内显式按 seq 升序排，勿依赖仓库层排序。
async schedule(count = 6) {
    const gameDays = this.gameDays();
    const current = await this.seasonRepo.findOne({
        where: [{ status: SeasonStatus.ENROLLING }, { status: SeasonStatus.RUNNING }],
    });
    const out = [];
    let seq = 1;
    let nextStart = 0; // 下届 startDay（相对 today），由当期消耗折算后累加
    if (current) {
        seq = Number(current.seq);
        const anchor = JSON.parse(current.anchorDay || '{}');
        const duration = Number(current.durationDays);
        // running：以 CN 锚折算已消耗天数；enrolling：未开赛，期长按 type 满打
        const elapsed = current.status === SeasonStatus.RUNNING
            ? Math.max(0, Number(gameDays.CN) - Number(anchor.CN || 0),
                       Number(gameDays.HK) - Number(anchor.HK || 0), Number(gameDays.US) - Number(anchor.US || 0))
            : 0;
        out.push({
            seq, name: current.name, type: current.type, status: current.status,
            startDay: 0, durationDays: duration,
            daysLeft: current.status === 'running' ? Math.max(0, duration - elapsed) : null,
            anchorDay: current.status === 'running' ? anchor : null,
        });
        nextStart = Math.max(0, duration - elapsed); // 下届从当期剩余天数后开始
    } else {
        // 理论空档（正常不可达：scheduler 启动即 ensureSeason）——按已结算最大 seq 续算
        const settled = await this.seasonRepo.find({ order: { seq: 'DESC' }, take: 1 });
        seq = settled.length ? Number(settled[0].seq) : 0;
    }
    for (let i = 0; i < Math.max(0, Number(count) - out.length); i++) {
        seq += 1;
        const type = SEASON_TYPE_CYCLE[(seq - 1) % SEASON_TYPE_CYCLE.length];
        out.push({ seq, name: `第 ${seq} 赛季`, type, status: 'upcoming', startDay: nextStart, durationDays: TYPE_DURATION_DAYS[type], daysLeft: null });
        nextStart += TYPE_DURATION_DAYS[type];
    }
    return { today: gameDays, seasons: out };
}
```

- **controller**：`GET('schedule')` + `@Query('count')` 方法装饰块（照 season.controller.ts:53-60 leaderboard 的写法，`design:paramtypes: [Number]`）。**无构造参数变化 → 底部装饰块不动**（本类构造仅注入 SeasonService）。

### 2.3 方案 C：战绩档案 `GET /season/archive/:seasonId`（JWT）

**逐日净值的可行性裁决（读实体后的结论）**：

- season_entries **无每日净值列**（season-entry.entity.ts:21-68，只有 startEquity/startDay 起点与 finalEquity/finalReturn/finalRank 终点）。
- 备选数据源 daily_snapshots（daily-snapshot.entity.ts:19-34：userId/day/equity/dailyReturn）**无 accountId、无 marketMode**——同一用户三市场账户同日各有一条、无法归属到市场/账户；ranking.service.ts:47-49 注释已明言该表"按 userId 串算会跨账户混算"（该模块因此弃用它改用 account.dayStartEquity）。且旧赛季（快照表启用前）无数据。
- 三市场账户 currentDay 以 CN 日终统一推进（risk-manager.settleAllAccounts 仅 CN tick 调用，market.service.ts:328-331），快照 day 与各市场账户并非一一对应。

**结论**：不做逐日净值曲线；采用**最小可行口径 = 报名起点 + 结算终点两点**（用户级汇总 + 分市场 entries 明细），理由如上注明于代码注释与 API.md。逐日曲线需 season_entries 加每日净值列或快照表加 accountId（结构改动）→ 登记为 V3 候选，不做。

**返回结构**（与 V1 风格对齐：业务性失败用 200 + `{success:false,error}`，先例 enroll :73、fund、trading 拒绝均如此，API.md:13 错误约定）：

```jsonc
GET /api/season/archive/:seasonId   // 已结算赛季
200 {
  "success": true,
  "season": { "seq": 5, "name": "第 5 赛季", "type": "biweekly", "settledAt": "...", "entriesCount": 12,
              "champion": { "userId": "U9", "ret": 23.45 } },
  "mine": null | { "rank": 2, "ret": 12.34, "medal": "silver", "points": 200,
                   "curve": [ { "point": "报名", "equity": 250000 }, { "point": "结算", "equity": 280850 } ], // 两点最小口径
                   "entries": [ { "marketMode": "CN", "startEquity": 100000, "finalEquity": 110000, "ret": 10 },
                                 ... ] },         // 分市场拆解（无报名 → mine: null，仍 200）
  "championCurve": null | { "userId": "U9", "entries": [...], "curve": [...] }   // 冠军（非本人时）同口径
}
// 不存在/未结算：
{ "success": false, "error": "赛季不存在或未结算" }
```

- 结算排名是用户级（settleSeasonInner :193-195 按 userId 聚合排序，同一用户的全部 entries 共享同一 finalRank，:205-209）→ archive 的 rank/medal/ret 按用户取；entries[] 给出分市场拆解。
- **medal/points 由 finalRank 推导查表**（复用 §1.3 抽出的 `rewardFor(rank)`：1→gold/300、2→silver/200、3→bronze/100、其他→null）——不读 seasonPoints 列（防历史数据与未来口径漂移，且 archive 语义是"该届成绩"）。
- service 骨架要点：`seasonRepo.findOne({where:{id}})` → 非 SETTLED 返回 `{success:false,error:'赛季不存在或未结算'}`；`entryRepo.find({where:{seasonId, status: SETTLED}})`（fake 场景注意不依赖 take/order，服务内排序）；按 userId 聚合成用户榜找冠军 + 我的 entries；curve 由 ΣstartEquity/ΣfinalEquity 合成两点。**注意归档赛季可能早于赛季点开始或账户已重置**——净值口径就是 entries 里的固化值（settleSeasonInner 结算时已冻结 :183-184），不回溯账户现值（更真实：档案 = 赛季当期的固化成绩）。
- controller：`GET('archive/:seasonId')` + `@Param('seasonId')`（照 history 块写法 + paramtypes [String]）。

### 2.4 方案 D：赛季积分榜 `GET /season/points?limit=`

**榜单口径建议（关键取舍，teams 复核）**：

- seasonPoints 在 account 层三市场各一份，且 V1 结算对该用户**全部市场账户同额累加**（season.service.ts:199-203）——同一场冠军在 CN/HK/US 三个 seasonPoints 上各记 300。
- **sum(全账户) = 单场胜利计 3 次（×3 失真）→ 否决**。**max(该用户各账户 seasonPoints) = 单场计 1 次**：注册必建 3 账户（auth.service.ts:110-121）且同额累加 → 三值恒等，max 与任一账户等值；对"仅部分市场账户"的极端边缘（历史半账户用户）max 仍稳健（sum 则继续 ×N 失真）。**推荐 max**，并在代码注释 + API.md 写明"积分按用户计一次，账户层三市场同额仅为 V1 记账语义兼容"。
- **连续获奖 consecutiveWins：由 entries 推导，不做结算时增量记列**。增量记列需在结算时维护用户维度游标（加列/加表，成本高、易与 seasonPoints 同额语义纠缠）。推导法：已结算 seasons 按 seq 降序 + 全部 SETTLED entries 一次拉取（fake/真库都可，量级小：赛季数 × 人数），内存分组算"从最近一届往回数 finalRank==1 的连续届数，遇非冠军即断"。**裁剪项标注**：若选手规模大（>1000 用户）仅在榜单 TOP N 上计算连续获奖；本游戏规模（几十~几百账户）全量算无压力。
- 返回：

```jsonc
GET /api/season/points?limit=20 →  // 与 V1 赛季榜一致：userId 原值输出，前端自行脱敏展示前 6 位（Ranking.tsx:145 先例）
[{ "rank": 1, "userId": "U9", "points": 900, "consecutiveWins": 3 },
 { "rank": 2, "userId": "U1", "points": 500, "consecutiveWins": 0 }, ...]
```

- service 骨架要点：`seasonRepo.find({where:{status:SETTLED}, order:{seq:'DESC'}})`（fake 无 order → 服务内 sort）；`entryRepo.find({where:{status:SETTLED}})` 后按 seasonId 分组（season 已过滤）；账户层取 max 需要 `accountRepo.find({where:{userId: In(users)}})`——fakeRepo 的 matchesWhere 需支持 In（phase2/7 已有先例：matchesWhere 复制体加 In 分支，见 phaseD 03 §6-3）或退化为逐用户 find；**本方案测试与实现统一用逐用户 `accountRepo.find({where:{userId}})`（fake 天然支持等值 where），避免 In 兼容面扩散**。limit 钳制 1~100（照 leaderboard :140 先例）。

### 2.5 V2 范围控制与向后兼容

- **不做**：实时同场对局/并行赛厅/逐日曲线/积分榜增量列/报名带 type 偏好（单赛厅下无意义）。远期表已有"用户社区/交易对战"立项。
- 路由兼容：`/season/enroll` 签名不变（无 body）；`/season/current` 的 season 对象**新增 type 字段**（前端 Ranking.tsx:103-108 只读 name/status/daysLeft/enrolled/myReturn/myRank——加字段零破坏）。
- 前端最小可选改动（不阻塞后端验收）：横幅加 `（双周赛/周赛/月赛）` 类型标签（Ranking.tsx:103 附近）；**本期不新增 V2 页面**（schedule/archive/points 先以 API + phase11 交付，UI 进 Phase E 收尾块或 F，避免死链路）。
- 依赖注入零变化：SeasonService 构造（season.service.ts:30-40）与装饰块（:247-264）不动（新方法全部用现有三个 repo + gameDays()）；controller 无新依赖。

---

## 3. 任务③ 注册用户名枚举面收口（P2）

### 3.1 现状实读

- Oracle 本体：auth.service.ts:103-124 register——:104-106 `findOne` 后 `throw new ConflictException('用户名已存在')`（409）。攻击者可对用户名集合发注册请求：不存在 → 200 + token（注册成功）；存在 → 409 —— **状态码即枚举面**。
- 现有防线：main.ts:47-54 `authLimiter` 10 次/分/IP 挂在 `/api/auth` 整前缀（login + register 共池）——枚举吞吐上限约 10 名/分/IP；trust proxy=0（main.ts:76）无代理层，IP 为直连。登录侧纵深已有账号锁定（auth.service.ts:40-43/140-162，Phase D）。
- 前端行为：Login.tsx:16-32 统一 catch —— 409 的 `err.response.data.message`（'用户名已存在'）与 200 包裹的 error 字段都能展示，但**改 B 方案后 200 分支不会走 catch**，需按 `success===false` 显式判错。api.client.ts:44-45 register 直通 `api.post`；api.client.ts:32 `isAuthRequest` 特判（401 刷新语义）——实施时主 agent 先通读该拦截器全文确认 200+success:false 不被拦截器改写。
- RegisterDto 校验：username 2~50 / password 8~72（auth.controller.ts:21-32）——格式类 400 保留（非枚举面）。
- 后端测试影响面：backend/test 全目录 grep 无 register 直接用例（仅 phase10-security.test.js:26-60 测 login 侧防枚举——不存在用户名同样计数锁定、文案与密码错误一致，注册侧枚举收口正是补上这条对称缺口）；前端 7 个测试文件（PriceText/offline-assets/store/adjust/marketSessions/quote/replay）**均不含 Login/register** → 前端测试 0 影响。

### 3.2 候选方案代价

**方案 A：维持 409 + 注册端点独立限流 5 次/分/IP**
- 改动：main.ts 在 authLimiter 之前按路径更精确挂一个 `app.use('/api/auth/register', registerLimiter)`（express 中间件先匹配先执行；先例 backtestLimiter main.ts:57-64）。
- 代价/评价：状态码 oracle 仍在，仅把单 IP 吞吐从 10/min 降到 5/min（同池分拆后 login 不受影响）；**分布式/代理池枚举下只是拖慢**；不损前端、不动业务返回约定。保守、可逆。

**方案 B：统一 200 + `{success:false, error}` 并改前端分支**（roadmap Phase E 任务 3 的首选表述：「返回统一 200+`{success:false,error:'注册失败，请更换用户名'}`」）
- 改动：auth.service.ts:106 由 throw 改为 return 业务失败体；文案统一『注册失败，请更换用户名』（不泄露"已存在"，同时覆盖其他注册期失败）；前端 api.client/Login 增加 `success===false` 判错分支（Login.tsx:21-31 改 3~5 行）；API.md:13/24 错误约定同步。
- 代价/评价：一次性消除状态码枚举面（409 vs 200 不再可分）；代价 = 反 REST 的 200 包裹（项目内已有大量先例：reset/transfer/order 业务拒绝均 200+success:false，API.md:112-118，风格一致）+ 前端一处分支 + 残留**时序侧信道**（成功路径 bcrypt+3 账户落库 ~百 ms，失败路径单 select ~ms——5/min 限流下利用价值≈0，不做反侧信道垫片，注明裁剪）。实测口径：注册失败后不改动"用户名已存在"以外的任何返回差异。

**推荐：方案 B**。理由：枚举面的本质是响应码可分；单机模拟盘（几十账户、演示性质）威胁模型低（tech-debt 定级 P2），B 以一次前端小改换掉整个 oracle 面，且与项目"业务拒绝 200 包裹"惯例一致（API.md:13 注明"多数交易类业务拒绝以 HTTP 200 + {success:false,error} 返回"——注册并入该惯例无违和）。方案 A 保守但未消除根因（拖慢≠收口），仅当 teams 反对 200 包裹业务语义时选用。**teams 裁决**（roadmap 明示）。

### 3.3 骨架（按方案 B；若裁决 A 则只做 main.ts 限流块）

```ts
// auth.service.ts:104-106
async register(username, password) {
    const existing = await this.userRepo.findOne({ where: { username } });
    if (existing)
        return { success: false, error: '注册失败，请更换用户名' }; // 枚举面收口：不返回 409（状态码不分 已存在/可注册）
    ...
}
// auth.controller.ts register 不变（透传返回值；注册端点本就无 HttpCode 覆盖 → 200）
```
```tsx
// frontend Login.tsx:21-31（handleSubmit catch 前插入成功码分支）
const data = await fn(username, password);
if (data && data.success === false) { setError(data.error || '注册失败，请更换用户名'); return; }
setAuth(data.token, ...);
```
（Login 模式：isRegister 才检查 success 字段更精确；表单 required 已挡空值。）

---

## 4. 任务④ 除权日 T+1 细节（REALISM #19 残余）核验

### 4.1 行为核对（现行为 vs 真实规则，逐项给依据）

| 问题 | 现行为（源码依据） | 与真实 A 股差距 |
|---|---|---|
| 除权日当日买入按什么价入账 | exDay 日初（tick counter===0，竞价前）先执行 `applyExRights` 调价（market.service.ts:223-229 → market-data.service.ts:1898-1937，:1908-1909 `st.price -= perShare` + 前复权因子 :1911-1916），之后才开盘竞价/连续交易 → 全天成交价已为除权价 | **无差距**（买入自动按除权价入账，复权因子保证历史图表连续；登记日收盘快照享息已封"除权日买入白拿股息"套利：trading-engine.service.ts:787-789 注释、快照 :860-898 在 exDay-1 收盘拍、发放 :790-858 在 exDay 盘后） |
| 除权日当日买入能否当日卖（T+1 是否有除权特例） | T+1 无任何日期特例：SELL 校验 `sellable = longQty - boughtToday`（validateOrder trading-engine.service.ts:410-417；precheckFill :916-917；结算队列复核 :489-491），boughtToday 买入累加（updatePosition :445），每交易日日初全局清零（resetBoughtToday :139-151，market.service.ts:212-213 先于撮合） | **无差距**（真实 A 股 T+1 无除权日豁免；登记日买入者除权日开盘可卖且照拿息——引擎 resetBoughtToday 日初解锁，一致） |
| 登记日买入享息口径 | 按 exDay-1 收盘快照（含当日买入者），做空者除权日付息（:835-853） | 已一致（P0#3 封堵 + 做空付息是超真实项） |

### 4.2 描述层结论

REALISM.md:41 末句「除权日 T+1 细节仍未实现」**过时**：除权日买入按除权价入账、T+1 无特例两项均已由上述时序保证且与真实规则一致 → **方案 = 文档注记**：把该行改为「**已核验（Phase E）：除权日买入按除权价入账（日初 applyExRights 先于竞价/连续交易）、登记日收盘快照享息封堵套利、T+1 无除权日特例（与真实一致）**」。

### 4.3 实读发现相邻真缺陷（roadmap 任务 4「与 lockDay 红利税口径对齐」所指）：lockDay 从不记账

证据链：
1. 建仓 create 恒 `lockDay: 0`（trading-engine.service.ts:548）；
2. `updatePosition`（:440-458）只维护 longQty/longCost/boughtToday/short*，**无 lockDay 写入**；全仓 grep `lockDay =` 仅 snapshotDividendHolders 幂等回写（:877）与注释；
3. 后果：payDividendsInner 持有期 `holdDays = (exDay-1) - lockDay`（:810-812），lockDay 恒 0 → holdDays 恒 0 → CN 红利税恒按「≤7 日 20%」档（constants.dividendTaxRate，phase9:33-38 锚定：CN 0-7→20%、8+→0）——持有 >7 游戏日的长线玩家红利税错收 20%（本应 0%）。

**小改骨架（推荐实施，1 行 + 注释；不改 updatePosition 纯函数——trading-engine.test.js:49-72 直接单测 updatePosition，保持其不写 lockDay 可零涟漪）**：

```ts
// trading-engine.service.ts:548（settleFillInner 建仓分支）——建仓日记 lockDay，红利税持有期真实化
// （加仓不刷新 lockDay：保留最早建仓日 = "建仓日"字面语义；快照单值锁定的简化口径，注释注明）
pos = this.positionRepo.create({ accountId: account.id, symbol, longQty: 0, shortQty: 0, longCost: 0, shortCost: 0, boughtToday: 0, lockDay: Number(account.currentDay) || 0 });
```

- 存量测试涟漪核查：分红流程用例（phase7:146-189）直接 seed snapshot 行（lockDay 0→20%、30→0%），不经建仓路径 → **0 影响**；settleFill BUY 用例的 seed 账户多数无 currentDay 字段 → `Number(undefined)||0 = 0`，行为与现值一致 → 0 影响。order-validation.test.js:36/43 mock position 只测 T+1 校验，不涉及。
- 真实语义自洽验证：登记日（exDay-1）当日买入 → lockDay=exDay-1 → holdDays=0 → 20%（短线税，正确）；第 1 日买入、exDay=50 → holdDays=48 → 0%（长线，正确）。做空付息与 taxRate 调用点不变。

**不扩大改动**：送转股/红股到账可卖（远期）、按笔 FIFO 计税（V3，快照单值口径已定）、除权日 T+1 特例（无，见 4.1）。

---

## 5. 任务⑤ 验证项与文档附赠（不改码为主，执行清单）

### 5.1 盘后窗口浏览器冒烟（真实 15:00–15:30 CN 执行，销 tech-debt 台账 open 条目）

台账：`~/.dsh/storages/tech-debt.md:5-11`（open 2026-09-06 盘后窗口未冒烟；切换目标 = browser-smoke-tester SOP）。执行前置（SOP 摘要）：先列「后端字段 → 前端元素 → 预期渲染」映射表，再点击流 + 截图 + ocr_vision 复查。

检查点清单（代码锚点）：
1. 时段判定：CN 15:00-15:30 内 `afterHoursStageFor('CN') === 'fixedPrice'`（constants/index.ts:343-354）；后端 processMarket 盘后分支早退不再生成行情（market.service.ts:150-169，`lastAfterHoursDay` 防重入）。
2. 状态传导：market.gateway 推 `isPostCloseTrading` → AppLayout.tsx:49-50 写 store → `store/index.ts:183-184/260-262 postCloseTrading`。
3. 下单面板交互（OrderPanel.tsx）：:86-101 `inPostClose = postCloseTrading && mode==='CN' && !marketOpen && !canPlaceAuction`；:102 canSubmit 含 inPostClose；:122-124 强制 limit + 价格=收盘价；:218-223 价格框 `readOnly={inPostClose}` + 值锁收盘价 + title 提示「盘后固定价格交易限以收盘价申报」；现价按钮隐藏（:223 条件）。
4. payload 契约：提交订单 type=limit、price=收盘价（服务端 order.service/结算路径二次校验——主 agent 冒烟时抓请求体核对字段）。
5. 15:30 跨界后：撤单清理（market.service.ts:160-168 cancelAfterHoursOrders，跨 15:30 一次性撤销未成交盘后申报）；表单恢复可编辑。
6. 证据：截图 ×N（窗口内下单成功态 + 15:30 后恢复态）→ ocr_vision 复查无 WARNING/文案缺失 → 台账销账（[paid] + 依据）。
7. 无法在当日窗口执行的降级：登记为台账 open 保持（不销账），由下一个 CN 交易日补。

### 5.2 Docker compose 端到端冒烟

- 命令：`docker compose -f backend/docker/docker-compose.yml up --build`（backend/docker/docker-compose.yml 全文 42 行：backend 8000 healthcheck `/api/market/prices` :21-27、frontend 3000 :29-39、数据卷 sgp-data:/app/data :16-18；注意 backend/.env 无 DB_TYPE → 默认 better-sqlite3 ./data/stockgame.db 与卷路径一致，compose :11 注释明示）。
- 检查点：① `docker compose ps` 两服务 healthy；② 后端 `GET http://localhost:8000/api/market/prices` 200；③ 前端 `http://localhost:3000` 页面可开（nginx 反代 /api 与 /socket.io Upgrade——frontend/nginx.conf）；④ WebSocket 行情（browser 打开 Trading 页看到 tick 推送/遮罩状态正确）；⑤ 注册/登录一次走通；⑥ 端口冲突检查（本机 dev 8000/3000 已占用时先停 dev 或改映射）。
- **本机无 Docker 的降级**：检测 `docker version` 失败 → 不硬装；改跑本地双端冒烟（start-fast.bat + 临时 DB），并在 tech-debt 台账**登记 open**：「Docker 端到端冒烟未执行（本机无 Docker），触发条件 = 有 Docker 环境/CI 时补跑」——不伪造通过。
- 冒烟用临时数据：不要污染 backend/data 开发库（compose 卷隔离；本地降级路径用 `SQLITE_PATH` 指临时文件 + SANDBOX_FAST=true，照 main.ts:65-68 门槛）。

### 5.3 README / 文档更新点清单（执行项，不占主改动预算）

| 位置 | 现值 | 改为 |
|---|---|---|
| README.md:111 | `单元测试（166 例）+ 数据库迁移校验（sql.js → better-sqlite3）` | 测试数以验收时实际全绿输出为准（任务口径 304 后端/52 前端，写成 `后端 N 例 + 前端 52 例`；先跑 `npm test` 取 jest 汇总数再落笔，防再次漂移）；括号说明改 `sql.js → better-sqlite3（已迁移，WAL）` |
| README.md:153 技术栈表 | `NestJS + TypeORM + sql.js（SQLite WASM）` | `NestJS + TypeORM + better-sqlite3（WAL 增量写盘）` |
| README.md:123 | 已写 better-sqlite3 默认（保留即可，微调措辞不必） | — |
| REALISM.md:41（#19） | 「除权日 T+1 细节仍未实现」 | 按 §4.2 改「已核验（Phase E）」措辞 |
| REALISM.md:50（#22） | sql.js 全库序列化导出（旧现状） | 补 better-sqlite3 已默认 + WAL（README:123 同口径）；或整条标「已迁移」 |
| REALISM.md:37（#15） | 「尚未实现：展期」 | 追加裁剪注记：显式融券展期端点明确不做（隐式展期 + 日终计息含券息；roadmap「不做清单」已列，README 注记即可） |
| API.md | :13 错误约定 / :24 注册 / :205-221 赛季节 / :318 赛季语义 | §3 裁决落地后同步注册口径；:318 `tierScore +300/200/100` → `seasonPoints`；:205-221 赛季节补 type/schedule/archive/points 路由（**phase10-api-doc-routes.test.js 的 MUST_HAVE 列表须同步加入 3 条新路由，防文档防腐烂门失效**——该测试 :7-18 只校验存在性，加新路由 = 在 API.md 写路由行即可，可不动 phase10 文件也可在 phase11 文件内补断言，推荐后者避免改 phase10） |
| infra/docker-compose.yml | 无标记（88 行：postgres/redis/backend/frontend/data-generator——引用不存在的 `frontend/docker/Dockerfile.frontend`（:58-69）与已废弃目录 data-generator（:72-84），postgres/redis 前提与 sqlite 默认互斥） | **最小方案 = 文件头注释块**（不加任何 yaml 结构改动）：3-4 行注明「legacy / deprecated：PostgreSQL+Redis 时代遗留，构建引用已失效（frontend/docker、data-generator 不存在）；现役为 backend/docker/docker-compose.yml（better-sqlite3 单卷两服务）」；README 无需额外注记（无任何文件引用该 compose，grep docker-compose 全仓仅 backend/docker 自引用 + phaseD 文档）。删除文件不在本期（保留历史可回看） |

---

## 6. phase11 测试用例清单（主 agent 编写，参照 phase9 fakeRepo 风格）

文件：`backend/test/phase11-season-v2.test.js`（require `../dist/src/...`，fakeRepo/matchesWhere 复制 phase9:7-30 同款；**用例一律先 build 再跑**）。SeasonService 构造 6 参：`(seasonRepo, entryRepo, accountRepo, mdCN, mdHK, mdUS)`（照 phase9:100）；TradingEngine/RiskManager 相关按各自现有测试构造惯例。

### 组 1：seasonPoints 拆列（任务①行为）

1. **结算后 seasonPoints 累加 + tierScore 不被污染**：phase9:140-160 同构场景（U1 +10% ×3 账户、U2 +20%）→ settleSeason 后 U2.seasonPoints=300、U1.seasonPoints=200、**U1/U2 各账户 tierScore 保持 0**（断言"不再回写 tierScore"）。
2. **跨届累加**：连续两届冠军同一用户（构造两轮 season rows，手动置 SETTLED 后各自 settle 或直接调两次结算闭环）→ seasonPoints=600。
3. **entity 元数据含 seasonPoints 列**：require dist 实体后断言 `(0,typeorm_1).getMetadata?` 不可用——改走源码静态断言（fs 读 account.entity.ts 含 `"seasonPoints"` 且 type `'float'`）或实例化 Account 原型上有 seasonPoints 默认 0（装饰器只在列映射，原型无默认值——**静态 fs 断言更稳**，先例 phase10 docker 组 fs 断言）。
4. **computeTier 不覆盖 seasonPoints**：RiskManagerService 注入 fake repos，账户 seed `{tierScore: 23, seasonPoints: 900}` → settleAllAccounts 后 tierScore=新段位分、seasonPoints 仍 900（防未来把覆盖逻辑再带回）。

### 组 2：大赛 V2 类型与赛程

5. **type 决定 durationDays**：makeSeason 空库 + `svc.ensureSeason()`（改后逻辑）→ 新赛季 seq=1 type=biweekly durationDays=10；再连续结算轮换断言 weekly=5/monthly=20（沿轮换表 `[biweekly,weekly,monthly]`：seq 2 建 weekly 需先把 seq1 赛季置 SETTLED 或直接测 `TYPE_DURATION_DAYS` 私有表——建议导出常量或经 ensureSeason 循环断言）。
6. **schedule 返回结构**：running 赛季（anchorDay CN=77、md CN gameDay=87、durationDays=10）→ `today.CN===87`、首行 status=running/startDay=0/daysLeft=0、次行 type 按轮换 upcoming、startDay=10（running 已耗尽则从 0 起算？此处用 elapsed=10 → nextStart=0 语义要与实现对齐，用例值由实现决定后锁死）。
7. **schedule enrolling 未开赛**：ENROLLING 无 anchor → status=enrolling、daysLeft=null、后续合成行 startDay 从 durationDays 起。
8. **schedule count 钳制**：count 缺省/负数/超大 → 输出行数 1~100。

### 组 3：archive 与 points

9. **archive 已结算取到我的成绩**：settled season + 我的 entries(finalRank=2) → rank/ret/medal=silver/points=200/entries 分市场明细/curve 两点（Σstart、Σfinal 校验）。
10. **archive 未结算/不存在** → `{success:false, error 含'未结算'或'不存在'}`。
11. **archive 未报名用户** → success:true + mine:null + champion 正常（无报名仍可看档案结构）。
12. **points 榜 max 口径**：用户 A 三账户 seasonPoints 900/900/900（冠军 3 届 ×3 账户）→ 榜首 points=900 非 2700；用户 B 一账户 200 → 次席 200。
13. **consecutiveWins 推导**：用户 A 最近 3 届 finalRank=1、第 4 届 rank=2 → 3；用户 B 仅最近 1 届冠军 → 1；无报名 → 0。

### 组 4：注册（方案裁决后选一断言）+ 除权 lockDay

14. **方案 B**：register 重名 → 返回对象 `{success:false, error}` 且**不 throw**（`await expect(...).resolves` 路径）；方案 A 则断言 409 保留 + main.ts 源码含 registerLimiter 5/min（fs 静态断言）。
15. **lockDay 记账**（若 §4.3 采纳）：settleFill BUY 建仓（account.currentDay=9）→ position.lockDay=9；加仓不刷新（先建仓 day9 再加仓 day20 → lockDay 仍 9）；account 无 currentDay → lockDay=0（存量兼容）。
16. **T+1 除权回归锁定**（描述层结论防回退）：applyExRights 调价后当日买入仍记 boughtToday、当日 SELL 仍被拒（校验函数路径已在 order-validation.test.js:36 覆盖——phase11 补端到端一条：exDay 开盘 applyExRights 后 submitOrder BUY → 当日 SELL 返回 T+1 文案、次日 resetBoughtToday 后可卖）。
17. **API 防腐烂**：API.md 含 `GET /season/schedule`/`GET /season/archive/`/`GET /season/points`（照 phase10-api-doc-routes 的 apiMd.toContain 风格，写在 phase11 内不改 phase10）。

### 存量回归改造清单（与 phase11 同 commit 块）

- phase9-season-rules.test.js：:140-156 断言 tierScore→seasonPoints（§1.3 改动 1-4 表格）。
- phase10-api-doc-routes.test.js：**不改文件**（其 MUST_HAVE 只断言既有路由仍在；新路由断言进 phase11 组 4 #17）。
- 前端：注册方案 B 改动 Login.tsx/api.client.ts 后，前端 7 个测试文件 0 涉及；若 teams 要求可补 1 例 Login 组件渲染测试（可选，不强制）。

---

## 7. 风险与回归点

1. **phase9 是唯一断言赛季奖励的存量用例**（grep tierScore 于 backend/test 仅 phase9:154/156 + 分红税纯函数 :34-43）→ 拆列回归面 = 该文件 2 行断言 + 标题；改造顺序：先改断言再跑全量，红了能立刻定位是口径问题还是逻辑问题。
2. **fakeRepo 能力边界**：无 take/order/skip、where 等值比较（phase9:7-10）→ ①schedule 的未来届合成 + points 的 seq 排序**必须在服务内显式排序**（实现与测试同约束）；②points 用逐用户 `find({where:{userId}})` 而非 `In()`（避免 matchesWhere 升级涟漪——phaseD 03 §6-3 曾为 In 改过 phase2/7 helper，能避则避）。
3. **ensureSeason 轮换的存量语义**：改造只影响"新建"赛季；进行中/报名中赛季不动（findOne 短路）。phase9:167-175 时钟用例断言 rows[1].status==='enrolling'——不查 durationDays/type，但 enroll 返回体含 durationDays（:108）→ 轮换表首位放 biweekly 保证改造后首个新赛季仍 10 日，线上无感知跳变。
4. **register 方案 B 的 axios 拦截器**：api.client.ts:32 `isAuthRequest` 特判意图需实读确认（401→登出?）；200+success:false 若被拦截器统一抛错则前端 catch 分支仍可显示——实施前主 agent 通读拦截器（5 分钟），两条路径都断言文案可达。
5. **lockDay 小改的隐藏涟漪**：position 实体无 currentDay 概念、settleFillInner 里 account 已加载（:476）→ 1 行改动安全；风险点是**账户重置/初始化路径**（重置后新建仓 currentDay 可能是旧值 → lockDay 偏大 → 税率偏低）：核查 account.service.resetAccount（:129-151 段）是否重置 currentDay——实施时读该函数，若重置则 currentDay=0 由 `||0` 兜底，语义自洽。
6. **computeTier 与赛季结算的时钟竞争（既有，不修）**：settleSeason 由 30s 轮询触发、computeTier 由日终触发——拆列后两者写不同列，竞争从"数据互踩"降为"展示时序差异"，风险消除。
7. **README 编码**：README.md 为 UTF-8（本方案以 read/grep 工具读取正常）；编辑走 write/edit（UTF-8），禁止 PowerShell 默认 ANSI 写回（safe-text-io）。
8. **API.md 语义项防误删**：phase10 测试 MUST_HAVE_SEMANTIC 含 '20%'/'15:00-15:30' 等——注册文案『注册失败，请更换用户名』与红利税注记不得移除这些既有语义串。
9. **预算裁剪标注**：V2 的 schedule UI 页、积分榜"近 N 届走势"、archive 冠军曲线逐日化——全部不做（远期/台账登记）；consecutiveWins 在选手 >1000 时裁剪为 TOP N 计算（§2.4）。

---

## 8. 文件改动汇总（实施期交付物）

| 类型 | 文件 | 对应任务 |
|---|---|---|
| 实体 | `backend/src/infrastructure/database/entities/account.entity.ts`（+seasonPoints 列） | ① |
| 实体 | `backend/src/infrastructure/database/entities/season.entity.ts`（+type simple-enum 列） | ②A |
| 服务 | `backend/src/modules/season/season.service.ts`（奖励改 seasonPoints；ensureSeason type 轮换；schedule/archive/points 新方法；rewardFor 查表） | ①② |
| 控制器 | `backend/src/modules/season/season.controller.ts`（+schedule/archive/:id/points 三方法装饰块；无构造变化） | ② |
| 引擎 | `backend/src/core/trading-engine/trading-engine.service.ts`（:548 lockDay 记 currentDay，1 行 + 注释） | ④ |
| 认证 | `backend/src/modules/auth/auth.service.ts`（register 409→200 包裹，方案 B 裁决后）｜（A 案：`backend/src/main.ts` 加 register 限流） | ③ |
| 前端 | `frontend/src/services/api.client.ts`、`frontend/src/pages/Login/Login.tsx`（success===false 分支，B 案） | ③ |
| 测试 | 新增 `backend/test/phase11-season-v2.test.js`（组 1-4）；改造 `backend/test/phase9-season-rules.test.js`（:140-156 断言） | ⑥ |
| 文档 | `docs/API.md`（注册口径/赛季节/语义行）、`docs/REALISM.md`（:37 #15 裁剪注记、:41 #19 核验注记、:50 #22）、`README.md`（:111 测试数、:153 技术栈）、`infra/docker-compose.yml`（文件头 deprecated 注释） | ⑤ |

**commit 分块建议（[AI] 前缀，每块后 `npm run build && npm test -- --runInBand` 全绿）**：① seasonPoints 拆列 + phase9 断言 → ② season type + schedule + archive + points + phase11 组 2/3 → ③ 注册收口（裁决后）+ 前端 + phase11 组 4 → ④ lockDay 1 行 + REALISM 注记 + phase11 组 4 补充 → ⑤ 文档四件套（README/API/REALISM/infra 头注，独立一块零测试风险，最后跑 phase10-api-doc-routes 确认）。
