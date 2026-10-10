# StockGameOnlinePro 2.0 重制版

保留股票模拟交易，采用独立引擎、HTTP/WebSocket 后端与 React/ECharts 前端。基础股票池为 **23 个行业、每行业 6 支、合计 138 支虚构股票**；原有 68 支的标识和名称保留。真实市场数据只用于统计校准，不作为游戏的实时行情。

## 本机运行

公开测试：[https://game.bobbycn.cc/remaster/](https://game.bobbycn.cc/remaster/)。输入昵称创建独立沙盒账户，24 小时后或服务重启后需要重新进入；测试资金与旧站玩家资产隔离。部署和回退见 [deploy/README.md](deploy/README.md)。

全新检出使用 Node.js 22，在本目录执行 `npm ci`、`npm run verify`、`npm start`。依赖锁文件已纳入仓库，自动检查覆盖独立安装、构建、前端类型与 19 项测试。

已使用本机 Node 24 和现有项目依赖验证，无需为本次变更重新安装依赖。在本目录执行：

```powershell
node tooling/runner.cjs build-api
node tooling/runner.cjs build-web
node --require ./tooling/runtime.cjs dist/apps/game-api/main.js
```

打开 http://127.0.0.1:8320 。默认是独立沙盒；首次进入创建合成账号。持久化文件仅允许位于 `remaster/data/`，默认 `remaster/data/remaster.sqlite`。不读取旧版玩家数据库，不自动认领旧版资产。启动命令运行新服务，不负责停止或重启其他服务。

`tooling/runtime.cjs` 优先使用本目录依赖，其次使用既有 `../backend/node_modules` 与 `../frontend/node_modules`，方便旧工作区开发。线上容器和自动检查使用本目录的独立依赖，不依赖旧项目的安装目录。

## 工程结构

- `packages/domain/`：股票目录、价格最小单位、市场日历、可审计的行业/新闻校准数据。
- `packages/engine/`：确定性价格生成、撮合、结算、风控、参与者、分红、基金、赛季与回测。新闻的未释放价格影响仅留在服务器。
- `packages/protocol/`：命令解析和前后端共用的快照协议。
- `apps/game-api/`：单写者队列、SQLite 事务、幂等命令、outbox、身份桥接及 `/api/v2` 与 `/v2` Socket。
- `apps/web/`：图表主工作区、底部导航、行业筛选、订单抽屉、行情缓存与离线只读壳。
- `tooling/`：构建、公开数据采集、行业拟合、新闻时间线分析和多种子检验。运行游戏不需要访问采集站点。

## 校准与证据

本轮采集 138 支真实参考股票和 3 个指数的 173,066 条日线，以及 12 支参考股票的 15,591 条五分钟线。行业拟合只使用 2025-10-01 之前的数据，之后的数据留作检验。新闻库含 28 个原始公告事件，覆盖全部 23 个行业的公司、信用或供给案例；宏观事件另外跨行业分析。

完整方法、各行业股票清单、数据问题和验证结果见 [市场真实性报告](../docs/MARKET-REALISM-20261010.md)。不确定首次公开时段的公告保留两个交易日窗口，不用于单一时点的幅度拟合。历史反应是关联，不能当成新闻造成涨跌的因果证明。

```powershell
node --require ./tooling/runtime.cjs --test tests/*.test.cjs
npm run typecheck:web
```

公开数据采集工具要求显式传入输出目录，有节流、超时和体积限制。原始采集数据与浏览器证据保存在本次 C 盘可视化工作目录；没有自动上传。

## 本轮验收边界

本轮已验证股票扩展、波动统计、新闻时序、确定性、成交守恒、关键事务故障、HTTP/WS 沙盒鉴权及图表布局。完整重制的其他验收项仍按 [验收矩阵](../docs/REMASTER-ACCEPTANCE-20261010.md) 逐项执行；真实站点身份接入与生产发布不由沙盒验证代替。
