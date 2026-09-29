# 身份接入契约 v1（冻结）

> 适用对象：`bobbycn.cc` 自身、`game.bobbycn.cc`（NestJS）、游戏厅云后端（Cloudflare Worker），以及**以后任何新加的服务**。
> 结论先行：**主域登录一次 → 各服务本地验签 → 用 `sub` 映射自己的记录**。不新增常驻服务、不需要 Redis/独立 IdP。
> 本文件里的路径、Cookie 名、claims 是**冻结项**：改动属于破坏性变更，必须评审 + 同步所有接入方。
> 产生依据：选型会 `room-mulcj9v2-4`（2026-09-28，5 人 100% 附修订通过）。

---

## 0. 一句话架构

```
                    ┌── bobbycn.cc（门户/博客/写作台）—— 同源，直接用会话 Cookie
浏览器 ──登录──► 身份服务（本机 NestJS /api/auth/identity/*）
   │ 域级 Cookie  │        ├── 签发 Ed25519 JWT（10 分钟）
   │  Domain=     └── JWKS 静态发布（公钥，可缓存）
   │  .bobbycn.cc
   ├──► game.bobbycn.cc（NestJS）：拿 Cookie 静默换令牌 → 本地验签 → sub 映射本地 user
   └──► 游戏厅云后端（Worker）：同上（WebCrypto 验签）
```

**判据**：日常读路径**零网络跳**（只本地验签）；只有**写路径**才回源查撤销（强一致）。

---

## 1. 冻结项（不得各自实现）

| 项 | 冻结值 |
|---|---|
| 会话 Cookie 名 | `sid` |
| Cookie 域 | `.bobbycn.cc`（`Domain=.bobbycn.cc`），`Path=/`，`HttpOnly`，`Secure`，`SameSite=Lax` |
| 唯一登录入口 | `https://bobbycn.cc/login/`（**任何服务不得自渲染登录表单**；未认证一律 302 回主域并带 `return_to`） |
| 注册 | `https://bobbycn.cc/register/` → 邮件验证落地页 `https://bobbycn.cc/verify-email?token=…` |
| 口令重置 | `https://bobbycn.cc/reset-password?token=…` |
| **exchange 端点** | `POST https://bobbycn.cc/api/auth/identity/token`（带 Cookie 或 Bearer）→ `{ token, tokenType:"Bearer", expiresIn, kid }` |
| **JWKS** | `GET https://bobbycn.cc/api/auth/identity/.well-known/jwks.json`（公开、可缓存、支持 ETag） |
| **introspect** | `POST https://bobbycn.cc/api/auth/identity/introspect` body `{token}` → `{active, sub, sid, exp}`（**写路径必查**） |
| 令牌算法 | `EdDSA`（Ed25519），header 含 `kid` |
| 令牌 TTL | **600 秒**，硬上限；**禁止**签发 > 1 小时的令牌 |
| claims | `iss=https://bobbycn.cc`、`aud=bobbycn.cc`、`sub=<identity id>`、`sid=<session id>`、`iat`、`exp` |
| 跨域要求 | 跨子域请求必须 `credentials: 'include'`；CORS 必须回**具体 Origin**，禁止 `*`（回 `*` 时浏览器不会带 Cookie） |

---

## 2. 新服务接入（三步 + 回滚声明）

```js
// ① 拿令牌：带上主域 Cookie（同机服务也可直接读 Cookie 头）
const r = await fetch('https://bobbycn.cc/api/auth/identity/token',
  { method: 'POST', credentials: 'include' });          // 浏览器侧；服务端侧转发 Cookie 头
const { token } = await r.json();

// ② 拉/缓存 JWKS（建议缓存 ≥5 分钟；未知 kid 才重拉，且必须限频+冷却，防伪造 kid 打爆）
const jwks = await (await fetch('https://bobbycn.cc/api/auth/identity/.well-known/jwks.json')).json();

// ③ 本地验签（Ed25519），校验 iss/aud/exp，然后按 sub 映射本地记录
//    Node：crypto.verify(null, data, publicKey, sig)   Worker：crypto.subtle.verify('Ed25519', key, sig, data)
```

**接入方必须同时声明自己的单服务回滚路径**（`legacy_verify` 开关 + 一页 runbook）。没有回滚开关的服务**不许上线**。

---

## 3. 读路径 vs 写路径

| | 要求 | 失败时 |
|---|---|---|
| 读 / 游玩（看榜、读存档、行情、页面） | 只本地验签（零网络跳）；允许撤销延迟（≤令牌 TTL 10 分钟） | 照常可用 |
| 写（云存档写入、改密、删号、换绑、任何状态变更） | **必须**调 `introspect` 或等价强一致源，确认 `active:true` | **fail-closed**：拒绝这次写 + 返回明确错误码；**禁止**静默丢写 |

- 注销顺序固定：**先写撤销并确认可读 → 再清 Cookie/会话**。
- 写失败的前端表现：只提示"稍后重试"，**不得**渲染登录墙、**不得**打断正在进行的游戏局。
- 令牌临近过期由中间件静默续期（重新 exchange）；只有主域会话也失效才回主域登录页。

---

## 4. 密钥交付与轮换

| 项 | 约定 |
|---|---|
| 私钥 | 仅 `IDENTITY_JWT_PRIVATE_KEY`（PEM 内联）或 `IDENTITY_JWT_KEY_FILE`（默认 `/opt/stockgame/keys/identity-ed25519.pem`，`0600`，目录 `0700`），容器**只读**挂载 |
| 仓库红线 | 私钥**不得**出现在任何提交/分支/标签历史与 CI 日志里；仓库内零副本（含加密副本、样例文件） |
| 轮换 | **双 kid 热轮换**：先发布新公钥（进 JWKS）→ 再切签发私钥 → 宽限期 ≥ 2×TTL（20 分钟）→ 撤旧 kid。**轮换不需重启任何服务** |
| 收敛上限 | 紧急撤 kid 的收敛时间上限 = 验签端 JWKS 缓存 TTL，**该 TTL ≤ 10 分钟**；超限的缓存实现不许接入 |
| JWKS 不可用 | 身份服务挂了，已签发且未过期的令牌在验签端照常可用（**降级**）；只有新登录会失败 |

---

## 5. 存量账号：只关联，不迁移

- StockGame：`users` 表加**可空** `identity_id` 列；Worker KV 加同样映射。
- 老用户首次用新身份登录时**静默认领**（后端完成），绑不上继续用旧登录。
- `legacy_verify` 开关：**每个服务独立**、只切后端验签路径（**不得**复活旧登录 UI），带到期日 + 审计 + 一页可单人执行的回滚 runbook。
- 退出条件（三者同时满足才关旧路径）：存量账号登录失败率为 0、旧登录确认无人使用、迁移负责人签字。
- 迁移期间**任一存量账号不得登不进去**。

---

## 6. 审计与告警（必须有）

密钥全生命周期（生成/注入/切换/紧急撤 kid）；撤销集 TTL 清理；`legacy_verify` 使用；JWKS 重拉与冷却；**存量账号登录失败率**、**认领绑定失败率**、**回主域登录页跳转率**（用数据盯登录墙回潮）。

---

## 7. 本契约的已知欠账（未验证，实施时补）

1. Cloudflare D1 作为跨服务强一致撤销源的可行性**未验证**；当前同机服务（game.bobbycn.cc）直接用本机 NestJS 的 `introspect`（同库、强一致）。
2. Worker 侧「拿 Cookie 静默 exchange」在跨子域下的实测未做（CORS 具体 Origin + `credentials:'include'`）。
3. 存量认领的冲突规则（一个身份绑多个旧账号 / 旧账号已被认领 / 重试申诉）未细化。
