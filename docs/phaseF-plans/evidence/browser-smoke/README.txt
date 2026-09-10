── Phase F 浏览器冒烟证据（生产壳 vite preview + 真实后端，2026-09-10 17:49-17:50）──

环境（全部为一次性实例，真实 103MB 库未被触碰）
- 后端：`SQLITE_PATH=E:\Files\.agent-work\sgp-iter\smoke8000.db`（临时库副本）`PORT=8000 SANDBOX_FAST=true TICK_INTERVAL_MS=1000 node backend/dist/src/main.js`
- 前端：`node node_modules/vite/bin/vite.js preview --port 3000 --strictPort`（生产 dist + 生产 SW；F-3 新增的 preview 代理配置）
- 驱动：playwright-cli（Thorium headless，会话 sgp-smoke）；登录态通过 API 注册用户后在 localStorage 注入 token（不写死密码到脚本）

链路与断言（DOM 断言优先，截图存证）
1. 生产壳加载：`GET http://127.0.0.1:3000/` → 200 且含 `id="root"`；`GET http://127.0.0.1:3000/api/market/prices` → 200（**证明 preview 的 /api 代理配置生效**）
2. 仪表盘渲染：截图 `01-dashboard.png`（OCR 复查：指数条/股票列表/盘口深度/账户总览/第 31 个交易日/市场状态：牛市行情，无白屏无 NaN）
3. **Phase F 可见面（C1/R11）**：`document.body.innerText` 命中
   `"AI 对手盘（本地策略+随机森林，零 API）· 市场 多头市\n#1 算法一号趋势跟随➖ 稳健\n+0% · 青铜\n…"`
   → 档位标签与市场状态均为一句话可解释文案；未暴露 takeProfit/stopLoss 等裸参数
4. 档位样式类名：`.ai-mindset.ai-mindset-normal` × 3（前 5 名对手盘渲染，文本 `➖ 稳健`）
5. 断线链路：`window.__wsSocket.disconnect()` → 9s 后 `.ws-offline-tip` 出现，文案
   `"⚠️ 实时行情连接已断开，正在通过轮询获取数据..."`；截图 `02-offline-banner.png`（OCR 复查：横幅文案可见、页面其余部分仍正常渲染 = 离线壳非白屏）

结论：Phase F 的 AI 自适应对外可见面、断线横幅、生产壳 + preview 代理链路均在真实浏览器中通过。
