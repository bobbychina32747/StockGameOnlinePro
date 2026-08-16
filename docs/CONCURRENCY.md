# 并发与一致性设计（StockSim Pro）

> 回应常见代码评审问题：为什么不用 @VersionColumn 乐观锁？为什么没有消息队列（BullMQ）？
> 本文档说明当前取舍、已证实的正确性依据，以及多实例化时的升级路径。

## 1. 成交结算的互斥：串行结算队列（settlementQueue）

### 现状
`TradingEngineService` 内所有资金/持仓变更（成交结算、分红、日初重置、强平）都通过
`settleFill()/runExclusive()` 进入同一条 **Promise 串行队列**：

```js
settleFill(...) {
  const run = this.settlementQueue.then(() => this.settleFillInner(...));
  this.settlementQueue = run.then(() => undefined, () => undefined);
  return run;
}
```

### 为什么不用 @VersionColumn（乐观锁）
- 部署形态是**单进程、单实例**（内存盘口 `realBooks`/`orderBooks` 只存在于本进程）。
  单进程内，串行队列就是事实上的互斥锁，没有第二写入方，乐观锁只会徒增版本冲突重试，零收益。
- 订单校验（资金/持仓/T+1）在队列外执行，**队列内 settleFillInner 二次复核**同样的约束，
  并发下单在队列内串行结算，不会出现超买/超卖/双花（有 76→145 项测试覆盖并发边界）。
- 注意：代码库中**并没有 @VersionColumn**——外部评审若提到它，属于对实现的误读。

### 局限与升级路径（多实例/公网多人部署时）
1. 内存盘口必须先外置（Redis Order Book / 单写节点分区），否则多实例撮合不一致；
2. 结算互斥升级为 **DB 行级锁（SELECT ... FOR UPDATE）或 Redis 分布式锁**；
3. 仅当锁升级后，实体再加 `@VersionColumn` 做二次防线（而非替代锁）。
在"单机模拟训练场"的产品定位下，以上均为过度设计。

## 2. 事件循环争抢：tick 流水线拆分（P5）

### 问题
原实现 `generateTick()` 在返回价格结果**之前**串行执行：
宏观反馈 → 行业传导 → AI 对手盘（10 个代理挂单/扫单/结算对手方）→ 做市商撤换单 → 指数反馈。
`market.service` 要等全部完成后才 `broadcastTick()` —— AI 的 CPU 与 DB 等待全部阻塞在
WebSocket 推送之前，实时档（60s/tick）尚可，高速回放/调试模式（1s/tick）会与推送争抢事件循环。

### 现状（P5 拆分后）
```
processMarket:
  1. generateTick()           # 价格/成交量/K线（快路径）
  2. engine.updatePrices + refreshOrderBooks
  3. gateway.broadcastTick()  # 立即推送前端 ← 关键路径到这里为止
  4. await postTickProcessing()  # 宏观反馈/行业传导/AI 对手盘/做市商/指数（重计算）
  5. 日初/日终结算
```
- 推送延迟与 AI 计算解耦；
- `postTickProcessing` 仍在 tick 循环内 `await`，**不与下一 tick 交叠**，撮合顺序语义与旧版一致；
- tick 循环自适应调度（调试模式休市期 1s/tick，正常按配置）。

### 为什么不引入 BullMQ/消息队列
- 全系统是**本地内存世界**：无跨进程任务、无外部消费者、无故障重放需求；
- 引入 Redis + BullMQ = 部署门槛 +1 依赖 + 分布式语义复杂度，与"单机可训练"定位冲突；
- 真实瓶颈（AI 下单与推送争抢）已用流水线拆分解决；若未来做**多玩家对战服务器**，
  再按第 1 节的升级路径引入队列。

## 3. 查询与 N+1
- 需要关联数据的路径均显式 `relations: ['account']` / `relations: ['user']`（JOIN 一次取回），
  如分红结算、排行榜；
- 日终结算对每个账户一次持仓查询（每日一次 × 账户数，当前规模无感），若账户数上万再批量化。

## 4. 已验证的边界（测试）
- 结算队列二次复核：超买/超卖/T+1 并发双卖/平空资金（trading-engine/order-book 测试组）；
- 撮合一致性：MatchingEngine 独立类 21 例（价格-时间优先/冰山补量/OFI 滑点/封板）；
- 行情后处理拆分：postTickProcessing 在 null 引擎下可安全执行（phase4 集成测试）。
