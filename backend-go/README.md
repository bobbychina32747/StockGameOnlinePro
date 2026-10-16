# Go 游戏 API 迁移

此实现替换 `remaster/apps/game-api/unified-*` 的常驻 NestJS 游戏接口进程。`/api/v2` 的会话、快照适配、历史/盘口查询、交易命令日志和 SSE 推送由 Go 提供。原后端继续负责统一身份、唯一资产账本、撮合、行情生成、基金、赛季和无状态回测；**这不是整个 NestJS 后端的 Go 重写**。

2026-10-15 排查时，线上健康检查正常，HK 行情仍在更新，CN 已进入盘后阶段；CN 146 支股票中 145 支显示零涨跌幅。代码原因是日终结算把展示用昨收价提前更新为当日收盘价。相邻的 TypeScript 修复把下个交易日基准单独保存，保留收盘展示，并在有日期明确的日线证据时恢复旧版快照。

## 资源设计

- Go 使用标准库 HTTP 和纯 Go SQLite，无常驻的第二个 Node/NestJS 进程。
- 共享公共行情缓存 1.5 秒，单角色快照缓存 1 秒；并发缓存未命中合并。交易后立即失效，较早发起的查询不能重新覆盖缓存。
- 64 个并发 HTTP 操作、128 条 SSE 连接、每角色最多 5 条 SSE 连接。慢连接写入有 5 秒超时，身份和账本请求有超时。
- SSE 每 2 秒检查会话并推送快照。前端收到正常推送后停止周期性重复拉取；流不可用时每 5 秒尝试 HTTP 补取，每个页面最多一个补取请求。
- 会话内存缓存最多 4096 项。长期会话持久化兼容原 AES-256-GCM 格式；没有使用延迟撤销的鉴权缓存。
- Compose 给 Go 服务设置 `GOMAXPROCS=2`、`GOMEMLIMIT=64MiB`、128MB 容器内存上限。前者是调度/GC 配置，**不是整套服务的实测资源保证**。原账本进程仍占用资源，部署前须测整机余量。

## 本地构建与验证

Go 1.26+（本次工具链 1.27.2），Node 22/24 用于前端及兼容回测模块。Go 依赖由 `go.mod`/`go.sum` 固定。

```sh
cd backend-go
go test ./... -count=1
go vet ./...
go test ./internal/game -run '^$' -bench . -benchmem -cpu 2
go build -trimpath -o stockgame ./cmd/stockgame
```

从 `backend-go/` 运行二进制，默认使用 `127.0.0.1:8321`、原后端 `127.0.0.1:8000`、`data/formal-commands.sqlite` 和已构建的 `../remaster/apps/web/dist`。若端口正在使用，设置 `REMASTER_PORT` 为未使用的端口；不要停止其他应用来腾端口。

沿用原配置名：`REMASTER_HOST`、`REMASTER_PORT`、`REMASTER_IDENTITY_URL`、`REMASTER_ALLOWED_ORIGINS`、`REMASTER_SITE_ORIGIN`、`REMASTER_COOKIE_SECURE`、`REMASTER_TRUST_PROXY`、`UNIFIED_COMMAND_DB`。额外的 `SGP_CATALOG`/`SGP_WEB_ROOT` 指定公开股票目录和静态资源路径。`REMASTER_TRUST_PROXY=1` 只适用于唯一前置代理可信且服务无公网直连入口的部署。

`GET /api/v2/config` 宣告 `transport: "sse"`，客户端据此选择 `/api/v2/events?market=CN|HK|US`。角色令牌通过原 HttpOnly cookie 发送，不放进 URL。旧版客户端仍可用 REST 补取；旧 Node 服务与新版前端继续使用 Socket.IO。Nginx 对 SSE 路由须关闭缓冲、关闭缓存，读取超时至少 60 秒。

Go 服务不实现 `/v2` Socket.IO。独立订阅客户端需要改用 SSE（脚本可使用 Authorization 请求头）或暂留在旧入口；不能把传输切换当作对所有外部客户端透明的更新。

## 数据与兼容

只打开原适配器的命令数据库，不直接打开生产玩家账本。`formal_commands` 和 `remembered_roles` 的表结构、角色 owner、令牌摘要、加密密钥文件均兼容原实现。记住的角色和幂等结果可沿用；未持久化的一次性角色登录需要重新登录。原账号、现金、负债、持仓、订单 ID 和基金份额由原账本返回。

幂等键先持久化，再发送唯一写入；上游报错或网络中断留下 pending，后续重试查询原结果，不自动再次扣款。命令记录不自动过期。`reset` 等现有写入规则仍由原账本执行，不会在迁移启动时触发。

回测通过原后端新增的 `POST /api/market/backtest-v2` 调用同一份纯计算模块，保留数值与成交细节。原后端本地默认加载 `../remaster/dist/packages/engine/backtest.js`，容器通过 `V2_BACKTEST_MODULE` 指定部署文件；缺失时明确返回 503，不换用另一套回测算法。

`tooling/compat-fixtures.cjs` 从原 TypeScript 生成合成账号契约、三市场快照及加密会话测试数据。它不读取真实玩家数据库或凭证。跨语言契约测试比较实际 JSON 输出。

## 部署准备与回退

本机验证记录（2026-10-15）：Go 功能测试与 `-race` 竞争检查通过；原后端全量 64 套/823 项通过，最终收盘、回测桥和时钟定向检查 26 项通过；原重制版 38 项通过，前端构建及类型检查通过。浏览器使用本地合成账号完成登录、持续 SSE、100 股请求参数、断线只读和恢复检查；连续 5 次有效推送期间新增 `/state` 请求为零。

`GOMAXPROCS=2` 下，414 支公共目录/138 支当前区服的冷快照适配与 JSON 编码约 1.34ms/次；合成账号、小负载的 Go API 进程工作集约 19MB。前者不含账本 I/O，后者不含原后端进程，均不是目标服务器的整机压测。Linux amd64 二进制已交叉编译；镜像随后在服务器完成构建、隔离试运行及生产检查。

2026-10-15 已按用户授权上线，实际镜像、数据保留校验与回退入口见 [发布记录](../docs/GO-API-RELEASE-20261015.md)。本次使用旧依赖镜像叠加补丁，服务器未安装 Go 工具链。下列通用 `Dockerfile` 从仓库根构建两个目标：

```sh
docker build -f backend-go/Dockerfile --target legacy-core -t stockgame-core:go-api-20261015 .
docker build -f backend-go/Dockerfile --target game-api -t stockgame-go:20261015 .
```

`legacy-core` 保留原账本服务，加入收盘修复和兼容回测模块。按原生产 Compose 配置、原数据卷更新该镜像；不要另起第二个行情/撮合写者，不启用自动改表，不重置数据。具体生产服务配置须部署前核对。

`deploy/compose.yml` 将 Go 服务绑定在宿主回环 `8322`，使用现有身份网络，并强制显式指定原命令卷名。它是待审核的部署配置，不能直接推断现有卷名。切换步骤：

本次实际发布沿用原生产 Compose，以镜像覆盖文件切换原 `sgp-unified-formal` 容器，保留 `8321` 端口；没有另起第二个正式适配器。以下 `8322` 模板用于独立迁移流程，不代表当前线上端口。

1. 记录旧镜像与代理配置；一致性备份原命令数据库及其 `.session-key`，账本沿用既有备份方案。
2. 更新并验证原账本服务：时钟、收盘涨跌幅、账号接口、回测模块均正常。
3. 停止旧正式适配器；再让 Go 打开同一个命令卷。**两个适配器不能同时服务同一批写入**。
4. 验证 Go 的健康、两种登录、三个区服、历史/盘口、命令幂等、SSE、退出与重启恢复，再修改 Nginx 目标为 `127.0.0.1:8322`。
5. 更新 Nginx 前先检查配置。保留旧镜像、旧适配器配置和所有卷。

回退：停止 Go，恢复 Nginx 的旧目标，使用同一命令数据库和密钥启动旧适配器。没有新增私有资产库，无需反向迁移玩家资金。Go 创建的一次性登录会失效，用户重新登录；保留长期会话的格式兼容。

仍需完成的整体原生迁移：行情生成/AI、撮合与结算、基金、赛季及身份以外的账户读取。它们目前保留在 TypeScript，不能把仅 Go API 的延迟或内存测量称为整套后端性能。
