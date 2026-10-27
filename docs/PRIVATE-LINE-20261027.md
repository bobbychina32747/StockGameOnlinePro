# 站内私线（/chat/）· 2026-10-27

站主 ↔ 受邀账号（`role=subadmin`，当前只有 **tina**）的两人对话。发文本、发文件、发链接、内置 emoji；
手机与桌面自适应；实时靠 SSE，断线自动退回轮询。

## 1. 边界与规则

| 规则 | 实现位置 |
|---|---|
| 只有站主与 `role=subadmin` 的身份能用；其它任何登录账号一律 403 | `ChatService.resolveAccess`（判据复用 `IdentityService.isOwnerIdentity`） |
| 站主判据 = `ADMIN_EMAILS` 命中，或**最早注册且已验证**的身份（与写作台同一套） | `IdentityService.isOwnerIdentity` / BlogAdminGuard 复用 |
| 一对一会话，不提供群聊/会话列表；一对 (owner, peer) 一条 thread，按需创建 | `chat_threads` + `ChatService.ensureThread` |
| 附件只给本会话两个参与者存取；上传者只能发自己传的附件、且不能重复发 | `ChatService.openFile` / `send` |
| 站内私线不走既有 `users` 表（游戏 JWT 体系），只认站点身份会话（`sid` Cookie 或 Bearer） | `SessionAuthGuard` |

## 2. 数据模型（3 张表，`autoLoadEntities` + synchronize 自动建）

- `chat_threads(id, ownerId, peerId, lastMessageAt, createdAt, updatedAt)`，`(ownerId, peerId)` 唯一。
- `chat_messages(id, threadId, senderId, kind, text, linkUrl, attachmentId, readAt, createdAt)`，
  `kind ∈ text | file | link`。
- `chat_attachments(id, threadId, uploaderId, filename, mime, size, storageKey, messageId, createdAt)`。

身份表新增一列：`identities.role ∈ user | subadmin | admin`，默认 `user`（用 `varchar` 而非
`simple-enum`：线上表已有数据，避免 SQLite 重建整表；添加新列只是一条 `ALTER TABLE ADD COLUMN`）。

附件落盘在容器数据卷：`/app/data/chat-uploads/<threadId>/<32hex><ext>`（`CHAT_UPLOAD_DIR` 可覆盖），
库里的 `storageKey` 只是相对路径。上传中转目录 `incoming/`，孤儿附件（传了没发）48 小时后由
`ChatService.cleanupOrphans()` 每小时清理一次。

## 3. API（全部挂 `/api/chat/*`，需站点会话）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/access` | 能否进、对方是谁、未读数、对方是否在线、上限（20MB / 4000 字） |
| GET | `/messages?before=<id>&limit=` | 历史消息，升序返回；`before` 为严格更早的游标 |
| POST | `/messages` | `{kind:'text'\|'file'\|'link', text?, linkUrl?, attachmentId?}` |
| POST | `/upload` | multipart `file`，单文件 ≤20MB；返回 `{attachment:{id,filename,mime,size,url}}` |
| GET | `/files/:id?download=1` | 附件流；图片/PDF 内联，HTML/SVG 强制下载（`nosniff`） |
| POST | `/read` | 已读回执（把对端消息置 `readAt`） |
| POST | `/typing` | 「对方正在输入」瞬态事件（限流 12 次/10s） |
| GET | `/stream` | SSE：`hello` / `message` / `read` / `typing` / `presence` 事件，20s 心跳 |

上行全部 REST：权限、限流、校验只有一份实现；SSE 只负责下行推送。

服务端限流（内存桶）：发消息 40 条/分、上传 12 次/分、typing 12 次/10s，按身份计。

## 4. 前端

- 页面：`bobbychina-pages/chat/index.html` + `assets/chat.css` + `assets/chat.js`（零第三方脚本，
  EventSource 原生；SSE 失败自动 5s 轮询 `/messages` 兜底）。
- 入口：
  - 顶栏：`assets/site.js` 在 `/api/auth/identity/me` 返回 `isOwner || role==='subadmin'` 时注入「对话」；
  - 账号页 `/account/`：`/api/chat/access` 通过才显示「私线」卡片。
- i18n：`chat.*` 词条三语齐全（zh-CN / zh-TW / en），`node tools/i18n-check.mjs` 必须通过。
- 视觉：沿用站点印刷感的「纸片 + 印章」语言，不做圆角气泡；浅/深色都适配；手机 100dvh +
  safe-area，输入区贴底、iOS 字号 16px 防缩放；桌面居中 880px。

## 5. 建 tina 账号（`role=subadmin`）

```bash
# 本机（对 dev 库）：
cd backend
$env:CHAT_PEER_PASSWORD='至少10位的强口令'; node scripts/seed-chat-peer.mjs

# 服务器（容器内，口令不落盘）：
sudo docker cp seed-chat-peer.mjs sgp-backend:/tmp/seed-chat-peer.mjs
sudo docker exec -e CHAT_PEER_USERNAME=tina -e CHAT_PEER_EMAIL=tina@bobbycn.cc \
  -e CHAT_PEER_PASSWORD='…' sgp-backend node /tmp/seed-chat-peer.mjs
sudo docker exec sgp-backend rm -f /tmp/seed-chat-peer.mjs
```

脚本幂等：已存在就重置口令并纠正 role/status，不会建重复行；同时把「最早注册的身份」标成
`role=admin`（不改变站主判据）。默认邮箱 `tina@bobbycn.cc` 只是占位（用于页面显示与口令重置入口），
没有真实邮箱也能用「用户名 tina + 口令」登录；忘记口令时由站主重跑脚本重置。

## 6. 部署

1. **后端**：`powershell -File scripts/_sync-backend.ps1 -Prod`（源码同步 + 重建 `sgp-backend`，
   启动时 TypeORM synchronize 自动建 3 张表并加 `identities.role` 列）。
2. **nginx**：把 `deploy/nginx/chat.conf` 装到 `/etc/nginx/snippets/chat.conf`，并在
   `/etc/nginx/conf.d/portal.conf` 的 443 server 块里 `include /etc/nginx/snippets/chat.conf;`
   （或直接跑 `deploy/scripts/install-private-line.sh`，它幂等完成 1–2 步 + 建号 + 自检）。
   `^~ /api/chat/` 优先于门户的 `/api/` 中继；SSE 必须 `proxy_buffering off`。
3. **静态页**：把 `bobbychina-pages` 的 `chat/`、`assets/chat.{css,js}`、`assets/site.js`、
   `account/index.html`、三份 i18n 词典同步到 `/var/www/portal`（HTML 一律 no-cache，见 blog.conf 约定）。
4. 验收：`https://bobbycn.cc/chat/` 未登录 → 提示登录；tina 登录 → 能发消息/文件/链接/emoji；
   换个普通账号 → 403「这条线不通」。

## 7. 本地验收（本次已跑）

- 后端单测：`npm run build && npx jest src/modules/chat` → **20/20**；全量 **66 套 / 845 项**全绿。
- 端到端：`backend/scripts/chat-e2e.mjs`（需本机后端跑在 8099、`SQLITE_PATH` 指向临时库）→ **52/52**，
  覆盖访问控制、三方登录、文本/链接/文件收发、中文文件名、已读回执、分页游标、SSE 推送、非法输入。
- i18n：`node tools/i18n-check.mjs` → 三语键与占位符一致。
- 视觉：playwright-cli 桌面 1440×900 / 手机 390×844，深浅两色 + emoji 面板 + 未登录门；
  截图见 `docs/private-line-20261027/`。

## 8. 已知边界 / 后续

- 单人站，不做群聊、消息引用、撤回、端到端加密；附件明文存服务器数据卷（与云存档同级信任边界）。
- 附件上限 20MB；更大文件请发链接。
- 在线状态只按 SSE 连接判定（关掉页面即离线），不是「已读到哪条」的精确回执。
- 站主删除某条消息 / 清理聊天记录目前只能手工动库；需要时再加管理入口。

## 9. 上线记录（2026-10-27 20:20 +08）

| 步骤 | 结果 |
|---|---|
| 数据库备份 | `/opt/backups/stockgame-2026-10-27-1953.db.gz`（源库 822MB，`sqlite3 .backup` 一致性快照） |
| 回滚快照 | `/opt/stockgame/snapshots/private-line-20261027/`（旧 portal.conf + 被替换的 7 个静态文件 tar） |
| 后端重建 | `sgp-backend` 重建并 healthy；启动时自动完成 `identities.role` 加列 + 3 张 chat 表 |
| 账号 | `tina`（`subadmin`，邮箱 `tina@bobbycn.cc`）创建成功；最早身份标为 `admin` |
| nginx | `/etc/nginx/snippets/chat.conf` 已装，`portal.conf` 已 include，`nginx -t` 通过并 reload |
| 静态文件 | `/chat/`、`assets/chat.*`、`site.js`、账号页、三份词典、首页版本号已更新（md5 与本地一致） |
| 公网验收 | 容器内跑真实链路（CF → nginx → Nest）：**25/26** 通过；唯一「失败」是测试把 `/api/market/prices` 预期写成了后端直连（它本来就该走 Worker 中继返回 401，属预期行为，非回归） |
| 数据清理 | 验收写的 4 条测试消息 + 1 个附件（含磁盘文件）已删除，会话当前为空 |

补充核对：`/api/chat/*` 经 CF 命中本机 Nest（`server: cloudflare` + Nest 的 `{"message":"缺少会话令牌"}`）；`/api/market/prices` 仍返回 Worker 的 `{"error":"unauthorized"}`，说明门户老中继未被私线抢占。

回滚方式（如需）：

```bash
# 1) 代码/容器：用上一次镜像重建（或 git 回到上一提交后 _sync-backend.ps1 -Prod）
# 2) 静态文件与 nginx：
sudo tar xzf /opt/stockgame/snapshots/private-line-20261027/portal-files-before.tgz -C /var/www/portal
sudo cp /opt/stockgame/snapshots/private-line-20261027/portal.conf.bak /etc/nginx/conf.d/portal.conf
sudo nginx -t && sudo systemctl reload nginx
# 3) 数据：如需连聊天数据一起回退（会丢掉期间新消息）
#    sudo bash /opt/stockgame/deploy/scripts/backup-sqlite.sh   # 先留当前
#    再从 /opt/backups 恢复对应快照
```

运维提示：改 tina 口令只需重跑 `scripts/seed-chat-peer.mjs`（幂等）；新增第二个受邀账号时把新身份 `role` 设为 `subadmin`、重跑脚本即可（会新建第二条 thread）。

### 9.1 上线后修复：消息序号 seq（2026-10-27 20:30 +08）

上线后本地提交钩子跑全量测试时抓到：**同一毫秒内连发多条消息**，只按 `(createdAt, uuid)` 排序会把「先发的」排到后面（uuid 随机，不保序），分页游标在并列时间戳下也会跟着错位。

修复：`chat_messages` 增加 `seq`（integer）——`ChatService` 在单进程内严格递增发号（`Date.now()*1000 + 自增`），启动时从库里 `MAX(seq)` 续号（系统时钟回拨也不会把新消息排到旧消息前）；列表排序与分页游标只认 `seq`（客户端游标仍是消息 id，服务端换算）。已重建线上容器（`chat_messages` 自动加列、序号从 0 续号），并用「极速连发 5 条 + 三页分页」在公网复验：顺序与发送顺序一致、拼接无重无漏（7/7 通过，测试消息随后清理）。

回归：chat 单测 21 项（新增「同毫秒顺序稳定」「重启续号」两例），全量 66 套 / 846 项全绿。
