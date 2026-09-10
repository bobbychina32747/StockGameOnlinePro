── Phase F-4 E2E 冒烟证据（2026-09-10）──

脚本：`tests/e2e/smoke.mjs`（可选门禁，不进 CI 强依赖）
复现：`cd backend && npm run build`、`cd frontend && npm run build`，然后 `node tests/e2e/smoke.mjs`

绿色运行记录（连续两轮 6/6 PASS，exit 0）
- runId 20260910-180145：PASS=6 FAIL=0 SKIP=0
- runId 20260910-180928：PASS=6 FAIL=0 SKIP=0 ← 本目录 `result-20260910-180928.json` 为该轮完整结果
  链路：auth-login / place-order / cancel-order / ranking / season-enroll / offline-shell

本目录随附截图（取自 20260910-180928）
- `02-place-order.png`：下单链路成功态
- `06-offline-banner.png`：断线横幅（`.ws-offline-tip` 文案断言通过）

安全红线证据（见 result.json 的 env 段）
- `tempSqlite` 为 `%TEMP%\sgp-e2e-<pid>.db`，`realDbTouched: false`
- 后端以 `SANDBOX_FAST=true` + `TICK_INTERVAL_MS=1000` 启动，前端为 `vite preview` 生产壳
- 端口自动挑选（backendPort/previewPort/gatewayPort 均为当时空闲端口）

完整产物（截图/各子进程日志）在 `tests/e2e/artifacts/<runId>/`，该目录已 gitignore（本项目不把冒烟产物纳入版本库，仅归档结果摘要与关键截图）。
