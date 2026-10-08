# 站点统一授权系统（Authorization / OAuth 2.0）

> 2026-10-08 起生效。把 `bobbycn.cc` 的**账号系统**升级成**可复用的授权系统**：
> 站内游戏、以后自己做的独立游戏、第三方应用，都通过同一套标准流程"用站点账号登录"。
> 实现位置：`backend/src/modules/identity/oauth.{service,controller,form}.ts` +
> 前端 SDK `bobbychina-pages/games/site-auth.js`、云存档 `games/site-saves.js`。

---

## 1. 一句话架构

```
    用户浏览器                                          站点后端（NestJS, 同 /api）
 ┌───────────────┐   ① GET /oauth/authorize  ┌──────────────────────────────────┐
 │  游戏页面      │ ────────────────────────► │ OauthService                     │
 │  site-auth.js │ ◄──── 同意页 / 302 回跳 ── │  · 客户端注册（oauth_clients）    │
 │  （PKCE）      │                           │  · 授权码（oauth_codes，120s）    │
 └───────┬───────┘   ② POST /oauth/token     │  · 授权关系（oauth_grants）       │
         │        ────────────────────────►  │  · 刷新令牌（oauth_refresh_tokens）│
         │        ◄── access/refresh/id_token │                                  │
         │   ③ GET /oauth/userinfo           │  Ed25519 签发（JWKS 公开）        │
         └───────────────────────────────►   └──────────────────────────────────┘
```

- **access token**：10 分钟 EdDSA JWT（`iss/aud/sub/sid/client_id/scope`）。
  下游可以完全不问服务端：拉一次 JWKS 本地验签即可（`/.well-known/jwks.json`）。
- **refresh token**：30 天不透明令牌，**一次性轮换** + 重放检测（用过的再来 → 整条授权作废）。
- **撤销**：用户解除授权（`/oauth/revoke-grant`）或登出 → 该应用的刷新令牌全废、旧 access token 立即被拒。

与 GitHub / 微软的对应关系：

| GitHub / Entra | 本站 |
|---|---|
| OAuth App / 应用注册 | `oauth_clients` 一行（`clientId` + `redirectUris` + `scopes`） |
| Public client (SPA) / Device | `type=public`（无 secret，**强制 PKCE S256**） |
| Confidential client | `type=confidential`（`clientSecretHash` = sha256，明文只出现一次） |
| `GET /login/oauth/authorize` | `GET /api/auth/identity/oauth/authorize` |
| `POST /login/oauth/access_token` | `POST /api/auth/identity/oauth/token` |
| `GET /user` | `GET /api/auth/identity/oauth/userinfo` |
| 已授权的 OAuth Apps 页 | `https://bobbycn.cc/account/` |

---

## 2. 端点表

所有端点挂在 `IDENTITY_ROUTE_BASE + 'oauth'` = **`/api/auth/identity/oauth/*`**。

> 为什么是这个前缀：线上 nginx 只把 `^~ /api/auth/identity/` 反代到本机 Nest
> （`/etc/nginx/snippets/blog.conf`）。挂在这个前缀下**零 nginx 改动**就能上线。
> 将来要做标准短路径（`/oauth/*`），加一条 location 即可，客户端只需改基址。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/authorize` | 站点会话（Cookie `sid`）| 校验请求 → 已授权则直接发码；否则渲染同意页；未登录 302 到 `/login/?next=…` |
| POST | `/authorize` | 站点会话 | 同意页提交（`decision=allow\|deny`，form-urlencoded） |
| POST | `/token` | client（+ PKCE / secret） | `grant_type=authorization_code` 或 `refresh_token` |
| GET | `/userinfo` | `Bearer <access_token>` | 身份信息，按 scope 裁剪 |
| POST | `/revoke` | client | RFC 7009：撤销刷新令牌 = 解除整条授权 |
| GET | `/clients` | 公开只读 | 客户端目录 + scope 词典（SDK 用它探测能力） |
| GET | `/grants` | 站点会话 | 我授权过哪些应用 |
| POST | `/revoke-grant` | 站点会话 | 解除某应用授权 |

### scope

| scope | 含义 |
|---|---|
| `openid` | 身份标识（`sub`）；带它时令牌响应会附 `user` 快照 |
| `profile` | 用户名/昵称 |
| `email` | 邮箱与验证状态 |
| `saves` | 云存档读写（`/api/auth/identity/saves/*`） |
| `arcade` | 游戏厅统一登录（站点账号 → 游戏厅凭据） |

**未登记的 scope 一律 `invalid_scope` 报错**，绝不静默缩小：用户同意页上写的权限必须就是实际发出的权限。

---

## 3. 接入一个应用（三步）

### ① 注册客户端

站内游戏**不用手工开表**：在 `oauth.service.ts` 的 `builtinClients()` 里加一行
（`clientId` + 展示名 + 目录），启动时幂等写入 `oauth_clients`：

```ts
'my-new-game': { name: '我的新游戏', dir: '/games/my-new-game/' },
```

回调地址按**路径**登记（`oauth-callback.html`），对
`bobbycn.cc` / `www` / `staging` / `bobbychina.github.io` / `localhost:5180` 这些已知源同时生效——
同一份前端代码换域名不用改后端。

**第三方应用**（跨源）走手工注册：写一行 `type: 'confidential'` + 明确的 `redirectUris`
（精确地址，不支持通配）+ `clientSecretHash`。**不给自动放行**：跨源回调必须人来点头。

### ② 前端引 SDK

```html
<script src="/games/auth-config.js"></script>
<script src="/games/site-auth.js"></script>
<script>
  SiteAuth.ready().then(function () {
    var st = SiteAuth.status();                 // { available, signedIn, user, ... }
    if (!st.signedIn) btn.onclick = function () { SiteAuth.signIn(); };   // 整页跳转
    // 或弹窗版（游戏厅用，不刷新当前页）：await SiteAuth.signInPopup()
  });
  // 带令牌请求（过期自动刷新；401 自动重试一次）
  SiteAuth.authFetch('/api/auth/identity/saves?game=my-game');
</script>
```

### ③ 后端验令牌（两种，任选）

```ts
// A. 本地验签（不依赖本站，最快）：拉 JWKS → 验 EdDSA → 看 exp
//    claims: iss=https://bobbycn.cc, aud=bobbycn.cc, sub, sid, client_id, scope
// B. 问本站（强一致，能感知撤销）：
//    GET /api/auth/identity/oauth/userinfo  （Bearer）
```

同进程内的资源服务（如云存档）直接用 `OauthService.requireScope(token, 'saves')`。

---

## 4. 云存档（服务端托管密钥）

老方案：存档在浏览器侧用**游戏厅口令派生**的密钥加密 → 改口令换钥匙、换设备没口令就解不开、
第三方登录拿不到钥匙。新方案（`game-saves` 模块）：

| 端点 | 说明 |
|---|---|
| `GET /saves/key` | 下发该身份的存档密钥（32 字节 base64，AES-256-GCM） |
| `GET /saves?game=` | 槽位列表（`migrated` 标记老存档是否已搬过来） |
| `GET /saves/one?game=&slot=` | 取一份密文 |
| `PUT/POST /saves?game=&slot=` | 写入/覆盖（≤2MB，槽位 ≤200/身份） |
| `DELETE /saves?game=&slot=` | 删除 |
| `GET /saves/summary`、`/saves/migration` | 概览 + 迁移状态（前端据此决定要不要引导迁移） |

- 鉴权：`Bearer <access_token>` **且带 `saves` scope**（会话令牌不行，必须走授权令牌）。
- 服务端**只保管钥匙、不碰内容**：加解密在浏览器（`games/site-saves.js`），落库是密文。
- 主密钥：`SAVES_MASTER_KEY`（hex）优先，其次复用 `IDENTITY_ENC_KEY`，都没有则生成随机值写 `app_secrets`。
  **换过主密钥 → 旧身份密钥解不开 → 明确报错**（不静默换新钥匙，否则等于把所有人的存档作废）。
- 迁移：`Account.migrateLegacySaves(game)` 把老存档（本地明文 / 老云端密文）用新钥匙重新加密上传，
  打 `migrated=true`。**幂等**，老原件不删。

---

## 5. 安全口径（逐条对着代码看）

| 项 | 做法 |
|---|---|
| 开放重定向 | `redirect_uri` **精确匹配**（大小写敏感、不允许额外参数）；不可信时**不跳转**、直接 400 |
| PKCE | public 客户端强制；只接受 `S256`；`verifier` 43~128 字符；比较用定长 timing-safe |
| 授权码 | 120 秒、一次性（先烧后用）、绑定 client + redirect_uri + session；库里只存 sha256 |
| state | SDK 生成并校验（`sessionStorage`，随手清）；不匹配即中止 |
| 刷新令牌 | 30 天；一次性轮换；**重放检测** → 同 grant 全废；只存 sha256 |
| 客户端密钥 | 只存 sha256；比较 timing-safe；`public` 客户端不接受 secret |
| 拉不到密钥/降级 | 私钥缺失 → `/token` 503 `temporarily_unavailable`、JWKS 空 set，账号功能不受影响 |
| 令牌撤销延迟 | access token 是 10 分钟短 JWT（撤销上限 = TTL）；`userinfo`/资源服务额外查 `oauth_grants.revokedAt`，**立即生效** |
| 授权记录 | 用户可在 `/account/` 看到并一键解除 |
| 同意页 | 后端自己渲染（不引前端框架、不依赖门户页面）：授权页是最敏感的一屏，少一个依赖就少一处可被偷改跳转的地方 |
| 日志 | 授权码/令牌明文**绝不落日志**；错误响应不含内部细节 |

⚠️ **已知取舍**：服务端托管存档密钥 ⇒ 服务端理论上能解密存档内容（代价换来"换设备/换登录方式不丢档"）。
对个人站 + 游戏存档可接受；真要端到端零知识，必须让用户额外记一个独立口令 —— 那正是这次要消灭的东西。

---

## 6. 本地开发与验证

```powershell
# 1) 起本机后端（独立库 + 独立签名密钥，绝不碰线上/staging 的数据）
cd backend
npm run build
pwsh -File scripts\_local-oauth-server.ps1        # 监听 8099

# 2) 起门户静态站（SDK 与页面）
cd ../../bobbychina-pages
npx serve -l 5180 .

# 3) 真机冒烟（注册→验证→授权→兑换→userinfo→刷新→存档→撤销，23 项）
cd ../Games/stockGameOnlinePro/backend
$env:SMOKE_LOG='E:\Files\_local-be.log'
node tools\_oauth-smoke.mjs

# 4) 单测（授权链路 + 云存档，共 116 例）
npx jest src/modules
```

冒烟脚本里包含的**必须能力**：授权码一次性、PKCE 校验、redirect_uri 逐字一致、
刷新令牌轮换与重放检测、scope 裁剪、未登记 redirect_uri 返回 400 不跳转、
JWKS 本地验签、撤销后旧令牌立刻被拒。

---

## 7. 部署

| 环境 | 后端 | 前端 |
|---|---|---|
| 本机 | `scripts\_local-oauth-server.ps1`（端口 8099） | `npx serve -l 5180 .` |
| staging | `.partner-kit/scripts/deploy-backend.sh`（重建 `sgp-backend-staging`，8001） | rsync 门户静态文件到 `/var/www/sgp-staging`（**新目录，不影响线上 `/var/www/portal`**） |
| 线上 | 站主走既有发布流程重建 `sgp-backend` | 门户仓库 push → GitHub Actions 同步 `/var/www/portal` |

- **表结构**：`oauth_clients` / `oauth_codes` / `oauth_grants` / `oauth_refresh_tokens` /
  `game_saves` / `identity_secrets` 六张新表，靠既有 `autoLoadEntities + synchronize` 自动创建
  （与身份模块原来的四张表同一套口径）。生产若已 `DB_SYNCHRONIZE=false`，需要手工建表。
- **环境变量**：新功能不强制任何新变量。可选：
  `SAVES_MASTER_KEY`（存档主密钥，建议配）、`APP_BASE_URL`（邮件链接前缀）、
  `SITE_LOGIN_BASE`（登录页与授权端点不同源时才需要，本机开发用）。
- **前端静态资源的缓存（2026-10-09 实测踩到）**：Cloudflare 会给 `/games/`、`/i18n/*.js`
  这类静态资源加 4 小时 TTL，改了页面/词典后**线上可能要等几小时才变**。
  改词典时除了跳 `i18n.js` 里的 `VER`（同时跳页面里的 `?v=`），最好顺手在 CF 清一次缓存：
  Dashboard → Caching → Configuration → Purge Everything，或
  `curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" --data '{"purge_everything":true}'`。
- **回滚**：前端 `site-auth.js` 探测不到 `/oauth/clients` 会显示"站点登录暂不可用"并禁用按钮
  （**不会**偷偷退回本机账号）；后端把新端点当作纯新增，回滚镜像即恢复原状（新表留着不碍事）。
  线上后端发布 = 同步源码到 `/opt/stockgame/backend` 后
  `docker compose -f docker/docker-compose.yml -f deploy/docker-compose.override.yml up -d --build`
  （本机脚本：`powershell -File scripts/_sync-backend.ps1 -Prod`；不带 `-Prod` 只动 staging）。

---

## 8. 老账号与老存档怎么办

- **老游戏厅账号**（口令 + GitHub 绑定）不再出现在界面上，但它没有被删除：
  站点账号授权后，后端派发的游戏厅凭据仍然能登上同一个账号，**老存档、排行榜、Gist 备份全部还在**。
- **老存档迁移**：账号面板 → 「📦 迁移老存档到站点账号」→ `Account.migrateLegacySaves(game)`。
  迁移完，存档钥匙跟着站点账号走。
- **要退休的东西**（登记在 `~/.dsh/storages/tech-debt.md`）：
  游戏厅的派生口令桥、老 Worker 的云存档端点、GitHub/微软绑定。等真实用户都迁完再拆。
