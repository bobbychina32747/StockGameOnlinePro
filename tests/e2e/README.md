# E2E 冒烟（Phase F-4）

浏览器级主链路冒烟：一条命令跑通「登录/注册 → 下单 → 撤单 → 排行 → 赛季报名 → 断线后外壳非白屏」，
落盘截图 + `result.json` 证据。**可选门禁**：不被 `npm test` / CI 强依赖，失败不影响 build/test 通道。

## 前置

1. 前后端都已构建：`cd backend && npm run build`、`cd frontend && npm run build`（脚本跑的是 `dist` 生产壳 + `backend/dist/src/main.js`）。
2. 本机 `playwright-cli`（`@playwright/cli`）与其配置 `~/.dsh/scripts/playwright-cli.json` 可用（Thorium headless + 持久 profile）。
3. 端口不用手工腾：脚本自动挑空闲端口；后端强制走**临时 SQLite**（`%TEMP%\sgp-e2e-<pid>.db`）+ `SANDBOX_FAST=true` + `TICK_INTERVAL_MS=1000`，**绝不触碰** `backend/data/stockgame.db`，退出（含异常）时杀掉自己起的子进程并删除临时库。

## 跑

```bat
node tests/e2e/smoke.mjs              :: 完整 6 条链路，总超时 300s
node tests/e2e/smoke.mjs --help        :: 用法与环境变量
node tests/e2e/smoke.mjs --strict      :: SKIP 也返回 1（可当门禁）
node tests/e2e/smoke.mjs --clean       :: 开始前清理 7 天前的旧产物目录（默认不删）
node tests/e2e/smoke.mjs --timeout=600000
```

## 产物与语义

产物在 `tests/e2e/artifacts/<YYYYMMDD-HHmmss>/`（已 gitignore）：`NN-<name>.png` 每条链路截图、`result.json`（步骤/状态/耗时/断言值，**不含密码**）、`server.log`（后端 stdout）、`preview.log`、`cli.log`、`run.log`。

- **PASS**：断言全过；**FAIL**：断言失败或超时 → 最终 `exit 1`（单条失败不阻断后续链路）；**SKIP**：构建产物缺失 / 端口不可达或被占用 / 浏览器不可用 / 赛季报名区缺失 → 默认 `exit 0`（加 `--strict` 变 1）。
- 环境变量：`SGP_E2E_BACKEND_PORT`、`SGP_E2E_PREVIEW_PORT`、`SGP_E2E_GATEWAY_PORT`、`SGP_E2E_TICK_MS`、`SGP_E2E_BACKEND_READY_MS`（默认 200000；空临时库要补全生命周期日线 + 30 游戏日 warm-up，实测 40~90s，慢机器可再放大）、`SGP_E2E_PREVIEW_READY_MS`（默认 60000）、`SGP_E2E_PREVIEW_TARGET_PORT`、`SGP_E2E_NO_GATEWAY=1`、`SGP_E2E_FORCE_GATEWAY=1`。
- 后端/preview/gateway 端口默认全部自动挑空闲端口，**不会占用 8000**；需要与别的服务共存（例如同时跑 8111 的实例）直接跑即可。
- 前后端同源问题：`vite.config.ts` 的 `preview.proxy`（Phase F-3 落地）target 固定 `http://localhost:8000`，而脚本按团队要求自动挑空闲端口，两者不一致时脚本起一个**同源内置网关**（`/api` + `/socket.io` 反代到本次后端）兜底，因此不依赖该 target 的具体值，也不会与占用 8000 的其他服务抢端口。若要顺带验证 preview 代理本身，令 `SGP_E2E_BACKEND_PORT=8000`（该端口空闲时）即可直连 preview。
- 防误连（临时库红线配套）：后端/preview 端口被占用、或就绪后的后端不接受本脚本**本次运行独有**的管理员口令（说明它不是本脚本起的），一律 SKIP —— 绝不会把冒烟打到连着真实库的后端上。
