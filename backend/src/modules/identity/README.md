# 统一身份模块（identity）

> 新增模块，与既有 `src/modules/auth/`（username + bcrypt + JWT）**并存**，既有鉴权代码与实体一行未改。
> 全部端点走 `main.ts` 的全局前缀规则：`app.setGlobalPrefix('api')` ⇒ `@Controller('auth')` = **`/api/auth/*`**。

---

## 1. 端点表

| 方法 | 路径 | 鉴权 | 请求体 | 成功响应 | 实现 |
|---|---|---|---|---|---|
| POST | `/api/auth/register` | 无 | `{email, password}` | `{success, message}`（**不含会话令牌**） | `IdentityController.register` → `IdentityService.register` |
| POST | `/api/auth/verify` | 无 | `{token}` | `{token, expiresAt, sessionId, identity}` | `verify` → `IdentityService.verify` |
| POST | `/api/auth/login` | 无 | `{email?, username?, password}` | `{token, expiresAt, sessionId, identity}` | `login` → `IdentityService.login` |
| POST | `/api/auth/logout` | Bearer 会话 | – | `{success:true}` | `logout` → `IdentityService.logout` |
| GET | `/api/auth/me` | Bearer 会话 | – | 白名单身份字段 | `me` → `toSafeIdentity` |
| POST | `/api/auth/password/reset-request` | 无 | `{email}` | `{success, message}`（**邮箱存在与否同响应**） | `resetRequest` → `requestPasswordReset` |
| POST | `/api/auth/password/reset` | 无 | `{token, password}` | `{success, revokedSessions}` | `resetPassword` → `resetPassword`（撤销**全部**会话） |
| POST | `/api/auth/password/change` | Bearer 会话 | `{oldPassword, newPassword}` | `{success, revokedSessions}` | `changePassword` → `changePassword`（撤销**其它**会话） |
| GET | `/api/auth/github/start` | 无 | – | **501** 占位 | `githubStart` |
| GET | `/api/auth/github/callback` | 无 | – | **501** 占位 | `githubCallback` |
| GET | `/api/auth/identity/.well-known/jwks.json` | **公开**（不读 Cookie） | – | `{keys:[JWK…]}` + `Cache-Control: public, max-age=300` + `ETag`（命中 `If-None-Match` → 304） | `jwks` → `KeysService.jwks` |
| POST | `/api/auth/identity/token` | 会话（Cookie `sid` 或 Bearer） | – | `{token, tokenType:'Bearer', expiresIn:600, kid}` | `token` → `TokenExchangeService.exchange` |
| POST | `/api/auth/identity/introspect` | **公开**（需 `body.token`） | `{token}` | `{active, sub, sid, exp}`；无效/过期/撤销一律 `active:false`（200） | `introspect` → `TokenExchangeService.introspect` |

> 路径口径：上表前 10 个端点的**实际挂载前缀是 `IDENTITY_ROUTE_BASE = 'auth/identity'`**（即 `/api/auth/identity/*`，见 `identity.controller.ts` 顶部注释），表中写成 `/api/auth/*` 是「正式切换后」的目标路径；阶段一新增的 3 个端点已按当前前缀写在表里。

- Bearer 令牌 = 不透明会话令牌（**不是 JWT**）：`Authorization: Bearer <token>` → `sha256` → 查 `sessions.tokenHash`。
- 全部请求经全局 `ValidationPipe({whitelist, forbidNonWhitelisted, transform})`；错误文案统一为「邮箱或密码错误」「链接无效或已过期」等，不区分「不存在 / 过期 / 已用过」，不泄露内部细节。
- 🚨 **路由遮蔽（必读）**：既有 `AuthController` 已占 `POST /api/auth/register` 与 `/api/auth/login`，Express **先注册者胜出**。`app.module.ts` 里 `AuthModule` 在 `IdentityModule` 之前 ⇒ 老 JWT 路由优先（老前端不受影响），本模块这两个路由在 HTTP 层被遮蔽（服务层与单测完全可用）。真机实测：`POST /api/auth/register {email,password}` 返回老 DTO 的 400（`property email should not exist … username must be a string`）。
  切换方式（一行）：把 `identity.controller.ts` 的 `IDENTITY_ROUTE_BASE` 从 `'auth'` 改成 `'auth/identity'`；或在正式切换时从 `AuthModule` 摘掉这两个路由。

## 2. 数据模型（四张表）

| 表 | 关键字段 | 约束与语义 |
|---|---|---|
| `identities` | `id`(uuid) / `email` / `emailVerifiedAt` / `username` / `provider`(`email`\|`github`) / `providerUid` / `status`(`pending`\|`active`\|`disabled`) / `pendingExpiresAt` / `createdAt` / `updatedAt` | `email` 唯一可空；`username` 唯一可空（pending 过期后被置 NULL 释放）；`UNIQUE(provider, providerUid)` 支撑 GitHub 绑定；SQLite 唯一索引视 NULL 互不相等，故「可空 + 唯一」成立 |
| `credentials` | `identityId`(唯一) / `passwordHash` / `totpSecretEnc` / `recoveryCodes` / 时间戳 | 与身份 1:1 拆表；`passwordHash` 为 argon2id PHC 串；`totpSecretEnc` 为 AES-256-GCM 密文（MVP 留空）；`recoveryCodes` 为哈希数组 JSON 文本 |
| `sessions` | `id` / `identityId` / `tokenHash`(唯一) / `expiresAt` / `revokedAt` / `ua` / `ip` | **只存 sha256 哈希**（64 hex），明文只在签发响应里出现一次；TTL 30 天（常量 `SESSION_TTL_MS`） |
| `identity_tokens` | `id` / `identityId` / `purpose`(`verify_email`\|`reset_password`\|`claim_account`) / `tokenHash`(唯一) / `expiresAt` / `usedAt` / `createdAt` | 一次性（`usedAt` 非空即废）；TTL 30 分钟（常量 `IDENTITY_TOKEN_TTL_MS`）；绑定 identity + purpose |

实体文件（新增，未改任何既有实体）：`identity.entity.ts` / `credential.entity.ts` / `session.entity.ts` / `identity-token.entity.ts`，均在 `src/infrastructure/database/entities/`，由 `TypeOrmModule.forFeature` + `autoLoadEntities` 自动注册。

### 令牌与口令规格（C10）
- 明文令牌：`crypto.randomBytes(32)` → base64url（**256bit ≥ 规格下限 128bit**），见 `token.service.ts`。
- 入库：只存 `sha256`（`token.service.ts#sha256`），任何日志与响应都不回显哈希。
- 一次一废：`consumeIdentityToken` **先写 `usedAt` 再执行业务**——并发双击时后到者必被拒（宁可多烧一个令牌，也不放行两次）。
- 口令：`@node-rs/argon2` **argon2id**（`m=19456KiB, t=2, p=1, out=32`，常量在 `password.service.ts#ARGON2ID_OPTIONS` 并注有 OWASP 依据）；`verify` 对未知/损坏哈希串一律判失败（不抛错、不放行）。

## 3. 限流（P1）

`rate-limit.service.ts`（独立 service，便于单测；不塞进 controller）：**IP + 账号双维度**，任一维度命中即拦。

| 参数 | 默认 | 说明 |
|---|---|---|
| `MAX_STRIKES` | 5 | 连续失败达到即锁定 |
| `LOCK_BASE_MS` / `LOCK_MAX_MS` | 60s / 15min | 短时锁定，二次锁定翻倍（递增惩罚） |
| `BASE_DELAY_MS` / `MAX_DELAY_MS` | 250ms / 4s | 失败后递增延迟（第 n 次 = `BASE*2^(n-1)`） |
| `WINDOW_MS` / `MAX_HITS_IN_WINDOW` | 5min / 30 | 滑动窗口体量限流（拦批量枚举） |
| `MAX_KEYS` / `SWEEP_INTERVAL_MS` | 5000 / 60s | 键上限 + 定期清理（定时器 `unref()`，不阻止进程退出；`onModuleDestroy` 亦清理） |

- 锁定检查先于一切查库与 argon2（锁定期不跑哈希，省 CPU 且不可被计时旁路）；不存在的账号同样计数（防枚举）。
- 成功登录**只清账号维度**，不清 IP 维度（否则攻击者用自己账号成功登录一次即可洗白）。
- 应用点：`login` / `register` / `password/reset-request` / `password/reset` / `github(claim)`；`verify` 不参与限流（令牌本身一次性）。
- ⚠️ 与 `main.ts` 里既有的 `express-rate-limit`（`/api/auth` 全前缀 10 次/分/IP）叠加：上线前建议把它收窄到 `/api/auth/login|register`，否则 `verify` 与 GitHub 回调也会被一起限住（见「待办」）。

## 4. 邮件发送

`mailer.service.ts` 暴露 `Mailer.send({to, subject, html})`，由 `identity.module.ts` 的工厂按环境变量挑选实现：

- `LogMailerService`（默认）：只写 Nest logger（正文含一次性链接，便于本机排查），**不真发**。
- `ResendMailerService`：当 `RESEND_API_KEY` 存在时启用，直接 `fetch https://api.resend.com/emails`，发信人 `MAIL_FROM`（默认 `no-reply@em.bobbycn.cc`）。

密钥只从环境变量读，代码中无任何密钥常量；发信失败只记日志、不让注册/重置整体失败（`safeSend`）。

### 相关环境变量（均**未**写入 `.env`，按需在部署侧提供）
| 变量 | 默认 | 用途 |
|---|---|---|
| `RESEND_API_KEY` | 空 | 有值 → 启用 Resend 真实发信；无值 → LogMailer |
| `MAIL_FROM` | `no-reply@em.bobbycn.cc` | 发信人 |
| `APP_BASE_URL` | `http://localhost:5173` | 邮件里验证/重置链接的前缀 |
| `IDENTITY_ENC_KEY` | 空 | TOTP 密钥加密密钥（32 字节 hex）；调用 TOTP 加解密时必须配置 |
| `IDENTITY_RECOVERY_PEPPER` | 空 | 恢复码哈希 pepper（高熵码，HMAC-SHA256 足够） |
| `GH_CLIENT_ID` / `GH_CLIENT_SECRET` | 空 | GitHub OAuth 正式实现的凭据（当前仅占位） |
| `IDENTITY_JWT_PRIVATE_KEY` | 空 | Ed25519 私钥 PEM **内联**（优先级最高，兼容 `\n` 单行写法）；缺失即降级为「不签发令牌」 |
| `IDENTITY_JWT_KEY_FILE` | `/opt/stockgame/keys/identity-ed25519.pem` | 私钥文件路径（未配内联时使用）；目录里额外的 `*.pub.pem` 会被当作轮换期旧公钥一并发布 |
| `IDENTITY_JWT_PREV_KEYS` | 空 | 轮换期旧公钥 JSON 数组 `[{"kid":"…","publicPem":"-----BEGIN PUBLIC KEY-----…"}]` |
| `TURNSTILE_SECRET` | 空 | Cloudflare Turnstile 服务端密钥；**代码里无任何密钥常量**，只从环境变量读 |
| `TURNSTILE_MODE` | `optional` | 人机验证模式：`off` / `optional` / `required`（取值非法时退回 `optional`） |
| `TURNSTILE_HOSTNAMES` | `bobbycn.cc,game.bobbycn.cc` | 允许的 widget 站点清单（逗号分隔，纵深校验用）；**生产不得含 localhost** |

### 阶段一：跨服务统一身份（别的服务"一次登录、本地验签"）

- 算法 **Ed25519 / EdDSA**（Node 内置 `crypto`，**未新增任何依赖**）；`kid = sha256(公钥 SPKI DER)` 前 16 位 hex，因此同一把公钥在任何机器/任何次重载下 kid 都相同。
- 令牌 claims：`{iss:'https://bobbycn.cc', aud:'bobbycn.cc', sub:identityId, sid:sessionId, iat, exp}`，**TTL 硬上限 600 秒**（`JWT_TTL_SEC`，签发与验签两侧都校验）；下游只需「拉 JWKS → 本地验签 → 看 exp」，需要撤销语义时再调 `/introspect`（同库强一致）。
- 轮换：把新私钥换到 `IDENTITY_JWT_KEY_FILE`（或 `IDENTITY_JWT_PRIVATE_KEY`），旧公钥转存为同目录 `*.pub.pem` 或写进 `IDENTITY_JWT_PREV_KEYS` → 调 `KeysService.reload()`（或等 30s 自愈重扫）即可**不重启**双 kid 并行发布；签发始终只用当前私钥。
- **降级是硬要求**：私钥缺失/格式非法/PEM 解析失败都不阻断启动——`jwks` 回空 set、`/token` 回 **503**，其余身份功能与全站不受影响（error 日志只打一次）。
- 生成密钥（部署侧一次性，**不要**把私钥放进仓库）：
  ```bash
  openssl genpkey -algorithm ED25519 -out /opt/stockgame/keys/identity-ed25519.pem
  chmod 600 /opt/stockgame/keys/identity-ed25519.pem
  ```

### 阶段二：Cloudflare Turnstile 人机验证（注册 / 忘记口令）

应用点：`POST register`、`POST password/reset-request`（`login` **暂不强制**，仅 DTO 收得下 `cfToken`，避免把已注册用户挡在门外；见 controller 内 TODO）。

| `TURNSTILE_MODE` | 行为 |
|---|---|
| `off` | 完全跳过（本机开发；连 token 都不看） |
| `optional`（默认） | **仅在「配了 `TURNSTILE_SECRET`」且「前端带了 `cfToken`」时才校验**；没配密钥或没带 token 一律放行（CF 侧还没配好的过渡期）；一旦带了 token 校验不过就 400 |
| `required` | 必须带 token 且校验通过，否则 400；**未配密钥时 fail-closed 400**（配置事故不能静默把注册口敞开） |

- 校验请求：`POST https://challenges.cloudflare.com/turnstile/v0/siteverify`，`application/x-www-form-urlencoded`，字段 `secret` / `response` / `remoteip`（可选），5s 超时；只回 `{ok, errorCodes, action, hostname}`，**不落库、不记 token/secret**。
- **站面纵深校验**（CF 官方 frontend-edit 契约）：`success:true` 之后还要核对 CF 回报的 `action` == 该页面 widget 的 `data-action`（注册页 `register`、忘记口令 `password-reset`），且 `hostname` ∈ `TURNSTILE_HOSTNAMES`——免得「别的站点/别的页面签出的 token」被搬过来复用（token 单次有效，但同一页面 5 分钟内可重复提交）。字段缺失时**不拦**（CF 某些模式不回报），避免把注册口打死。
- 失败一律 400 + 统一文案「人机验证未通过，请刷新页面后重试」（不区分「没带 token」与「token 无效」，不暴露配置状态）。
- CF 不可达（超时/网络异常）时：`optional` 放行（不能因为 CF 抖动封死注册口，会打 warn 日志）、`required` 拦截。
- 前端字段名固定为 **`cfToken`**：全局 `ValidationPipe` 开了 `whitelist + forbidNonWhitelisted`，DTO 已为三个入口声明该字段（`dto/identity.dto.ts` 的 `TurnstileTokenField` 基类），否则前端一挂 widget 就会被 400 拒掉。
- **上线顺序**：① 在 CF 后台建 Turnstile widget，拿到 **site key + secret** → ② 服务端配 `TURNSTILE_SECRET`（保持默认 `optional`，此时行为完全不变）→ ③ 前端挂 widget、把 token 放进 `cfToken` 提交（此时开始真正校验，失败会 400，可回滚成 `off`）→ ④ 观察无误后再把 `TURNSTILE_MODE` 切成 `required` 上硬闸。任一步出问题：`TURNSTILE_MODE=off` 一键回退。
- **生产现状（2026-09-28）**：①②③④ 全走完，线上跑 **`required`**。验收证据见 `deploy/README.md` §14.4（密钥有效性用 CF siteverify 假 token 探针判定、真浏览器拿 752 字符真 token 提交 200、同 token 重放 400、硬闸后再回归 200）。

## 5. 单测

```bash
npm run build                 # 单测 require dist/ 产物，必须先构建
npx jest src/modules/identity # 6 个 suite / 54 个用例
```

- 装置：`__tests__/_harness.js` —— 真实 TypeORM `DataSource`（better-sqlite3 **内存库**）+ 手工装配服务（不引 `@nestjs/testing`，与仓库既有单测风格一致）；邮件用假 mailer 收集正文，并从邮件里回读令牌，顺带验证「邮件里的链接真的可用」。
- 覆盖：注册→验证→登录全链路、未验证不发会话、pending 过期释放账号名与邮箱、同邮箱重复注册的幂等/静默、令牌过期/二次使用/用途绑定/库里只有哈希、登录连续失败锁定（IP+账号双维度）、改密撤销其它会话、重置撤销全部会话、argon2id PHC 前缀、TOTP 加解密、恢复码哈希。
- 阶段一：`__tests__/jwt-keys.test.js`（JWKS 结构与 kid 稳定性、ETag/304、签发→验签与篡改/alg:none/未知 kid、TTL 硬上限 600s、introspect 的撤销与失效矩阵、私钥缺失降级与 503、双 kid 轮换；密钥全部现场 `generateKeyPairSync('ed25519')` 生成到临时目录，仓库/日志/响应内无任何私钥）。
- Turnstile：`__tests__/turnstile.test.js`（模式矩阵、校验请求形状、失败与网络异常策略、DTO `cfToken` 契约、注册/忘记口令端点接入、login 不强制）。
- 为让 `npx jest src/modules/identity` 能匹配到用例，`jest.config.js` 的 `testMatch` **追加**了一条 `<rootDir>/src/**/*.test.js`（纯新增，既有 `test/**/*.test.js` 行为不变）。

## 6. 有意的偏离（Against the original spec）

1. **新增第 4 张表 `identity_tokens`**（规格原文只列了 identities / credentials / sessions）。
   理由：规格同时要求「验证/重置令牌」与 C10「令牌必须落库且只存哈希 + 一次一废」。没有这张表，令牌要么无状态（无法一次一废、无法撤销）要么存明文，两者都违背 C10。表内 `purpose` 兼顾后续 `claim_account`（账号认领/GitHub 绑定）流程。
2. **`migrations` 未提供**：本仓库 `synchronize` 由 `DB_SYNCHRONIZE` 控制；生产若为 `false`，需要自行建表（见待办）。
3. **额外新增 `jest.config.js` 一行 `testMatch`**：为满足「`npx jest src/modules/identity` 必须通过」这一验收命令（否则该路径下无用例可匹配，jest 直接以「No tests found」失败）。
4. **注册端点用「静默受理」替代显式冲突错误**：重复注册（含邮箱已激活）统一返回 `{success:true}`，不区分「已存在 / 可注册」，与既有 `auth.service.register` 的防枚举口径一致；pending 未过期时幂等重发邮件并作废旧链接。
5. **口令兜底**：`@node-rs/argon2@2.2.1` 在本机**安装成功**（含 `argon2-win32-x64-msvc` 预编译包），真机实测落库串为 `$argon2id$v=19$m=19456,t=2,p=1$…` ⇒ **本机已满足 argon2id 规格，未启用兜底**。`password.service.ts` 仍保留 `crypto.scrypt` 兜底路径（原生模块在目标平台加载失败时降级并**打 error 日志**），此时须在本 README「未达规格」条目标注；`PasswordService.algorithm` 可直接读出当前生效算法，单测对此有断言。

## 7. 授权系统（OAuth 2.0，2026-10-08 追加）

> 账号 → **可复用的授权系统**。站内游戏与以后自己做的独立游戏都用"站点账号授权登录"，
> 不再各自维护账号表。架构与接入指南见仓库 `docs/AUTHORIZATION.md`；这里只列与身份模块的接线点。

| 文件 | 职责 |
|---|---|
| `oauth.service.ts` | 客户端注册/种子、`/authorize` 校验、授权码、令牌兑换、刷新轮换、`/userinfo`、撤销 |
| `oauth.controller.ts` | HTTP 层 + **同意页**（后端自己渲染的 HTML，不依赖门户页面） |
| `oauth-form.ts` | 表单体解析（RFC 6749 要求 `application/x-www-form-urlencoded`） |
| `entities/oauth-{client,code,grant,refresh-token}.entity.ts` | 四张新表 |

端点前缀：`/api/auth/identity/oauth/*`（复用既有 nginx 反代规则，零 nginx 改动）。

**与既有能力的关系（都保持向后兼容）**：

- `jwt.service.ts#issue()` 新增可选的 `client_id` / `scope` 两个 claim；不传时行为与以前**逐字节一致**
  （`/auth/identity/token` 与 `/introspect` 的契约不变）。
- 令牌仍是同一把 Ed25519 密钥、同一份 JWKS —— 授权流程与"下游本地验签"共用一条信任链。
- `identity.controller.ts` 的 `github/start|callback` 仍是 501 占位：**GitHub 只作为登录方式时的
  备选**，现在的主路径是站点账号本身（`provider=email`）。

**实测踩到的两个坑（别再踩）**：

1. `repository.save()` 在 SQLite 下会因"datetime 列读回来是字符串"判定"没变化"而**跳过 UPDATE** ——
   授权撤销一度完全写不进库。凡是要改 datetime 列，用 `repository.update()`（见 `oauth.service.ts` 注释）。
2. Nest 默认的 body-parser 在这套组合里收不到表单体（流被消费、`req.body` 变空对象，
   表现为"参数全缺"）。`main.ts` 因此改为 `NestFactory.create(AppModule, { bodyParser: false })`
   并自行按「json → 表单体」装载解析器（`oauth-form.ts#formBodyMiddleware`）。

新增单测：`__tests__/oauth-flow.test.js`（授权码/PKCE/刷新轮换/撤销/scope 裁剪/降级共 60+ 例）、
`__tests__/_oauth-harness.js`（带授权表的公共装置）、
`src/modules/game-saves/__tests__/game-saves.test.js`（云存档密钥托管与迁移）。

---

## 8. 待办 / 风险
- [ ] **GitHub OAuth 正式实现**：`/github/start` 与 `/github/callback` 目前恒 501。需要 `GH_CLIENT_ID` / `GH_CLIENT_SECRET` + 已注册的回调地址；实体侧 `provider`/`providerUid` + `UNIQUE(provider, providerUid)` 已就绪，`claim_account` 用途枚举已预留。
- [ ] **TOTP**：`credentials.totpSecretEnc`、`IDENTITY_ENC_KEY`、`PasswordService.encryptTotpSecret/decryptTotpSecret`、`recoveryCodes`（哈希数组 + `hashRecoveryCode/verifyRecoveryCode`）均已就绪，缺 2FA 业务流程（绑定/校验/恢复码一次性消费）。
- [ ] **迁移脚本**：`DB_SYNCHRONIZE=false` 的生产环境需要建表 SQL / TypeORM migration（四张表 + 三个唯一索引）。
- [ ] **路由遮蔽决策**：见第 1 节 🚨；在切换前，`register`/`login` 只有服务层可用。
- [ ] **`main.ts` 全前缀限流收窄**：`express-rate-limit` 现挂在 `/api/auth`（10 次/分/IP），会把 `verify`、`github/callback` 一并限住。
- [ ] **多实例部署**：限流是进程内 Map，横向扩容需换 Redis（或粘性会话）。
- [ ] **`pending` 清理触发点**：`sweepExpiredPendings` 在 `register` 时惰性执行（每次最多 500 行）；无后台定时任务，长时间无注册则过期行不会被回收（`login`/`verify` 已各自拦住过期身份，不影响安全）。
- [ ] **会话续期 / 设备管理**：MVP 无滑动续期，无「登出其它设备」列表接口。
- [ ] **JWKS 的 ETag 只做等值比较**：不解析 `W/` 前缀与多值 `If-None-Match`；CDN 若改写 ETag 会退化为每次 200（功能正确，仅少一层缓存收益）。
- [ ] **验签时钟偏移**：`IdentityJwtService` 的 `CLOCK_SKEW_SEC = 60` 是硬编码常量；下游机器时间漂移 > 60s 会全量验签失败（排障先查时钟）。
- [ ] **introspect 的「强一致」前提**：依赖「同一进程直查同一库」；将来若拆库/加缓存或横向扩容到多库，撤销语义会退化（需改为事件推送或共享存储）。
- [ ] **登录端点未接人机验证**（有意）：DTO 已能接收 `cfToken`，待前端全量上线后再决定是否开启。
- [ ] **Turnstile 未做服务端限流配合**：目前只有 `optional/required` 开关；若被刷，建议叠加现有 `RateLimitService` 的阈值调整或 CF WAF 规则。
