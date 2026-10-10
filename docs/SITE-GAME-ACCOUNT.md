# 游戏接入站点账号

游戏使用现有站点身份服务、域级 HttpOnly `sid` Cookie 和 10 分钟 Ed25519 访问令牌，不新增第三套账号密码。站点登录后，通过站内 `/api/auth/identity/game-return` 跳转回游戏；回跳目标采用完整 origin 白名单，不把令牌放进 URL。主站只把 `/api/auth/identity/` 转发给本机身份服务，其余 `/api/` 仍转发到旧云后端，因此回跳必须使用身份路径。

## 玩家流程

- 未登录站点：前往 `bobbycn.cc/login/`，登录成功自动回到游戏。
- 已绑定账号：打开游戏即可恢复登录，游戏定期续期，并在窗口重新获得焦点时检查站点会话。
- 首次使用：明确选择创建新游戏账户，事务内一次性创建 CN、HK、US 三个账户。
- 老玩家：选择绑定旧游戏账户并验证旧用户名、密码。绑定只增加站点身份映射，不更改用户 ID、角色、资金、持仓或历史。
- 同名账号不自动合并；已经绑定的身份或游戏账号不能被另一绑定覆盖。创建新账户后不能直接用旧账户覆盖绑定。
- 游戏的“退出站点账号”撤销当前站点会话；已签发的游戏访问令牌立即失效。

绑定后不再接受该玩家的旧独立游戏密码登录及旧 HMAC JWT。未绑定账号暂保留旧接口兼容性，供迁移过渡；前端只提供站点登录。

## 接口与鉴权

- `POST /api/auth/site-session`：Cookie 鉴权，默认返回已有游戏会话或 `needsAccountSetup`；只有 `{create:true}` 才创建账户。
- `POST /api/auth/site-link`：Cookie 鉴权及旧账号密码证明，返回绑定后的站点令牌和安全的游戏用户信息。
- `GET /api/auth/identity/game-return?origin=...`：固定 origin 白名单跳回 `/login`；游戏后端保留 `/api/auth/site-return` 别名。
- HTTP 与 WebSocket 均把已验签的站点 `sub` 映射为本地游戏用户 ID。HTTP 请求和 WS 建连检查站点会话撤销、身份状态及游戏账号状态。
- 不接受第三方 OAuth 客户端的访问令牌直接访问交易账户。
- 返回令牌的响应禁止缓存；站点 Cookie 请求不携带缓存的游戏 Bearer，防止错误地把游戏 JWT 当作站点会话令牌。
- 绑定复用旧账号防爆破计数，接口受 IP 限流及浏览器来源白名单约束。

## 发布

先备份生产库并暂停后端写入，在具备 Linux `better-sqlite3` 依赖的容器中运行：

```sh
node scripts/migrate-site-game-account.cjs --db /app/data/stockgame.db
```

该脚本先建立 `.before-site-game-account.sqlite` 一致性备份，再增加 `users.identityId` 可空列及唯一索引。多条旧账号的 NULL 不冲突；不读取或批量修改旧玩家映射。脚本必须从宿主挂入容器，因为当前 Dockerfile 不复制 scripts 目录。

保持 `DB_SYNCHRONIZE=false`。后端和前端须一起发布，站点主域与游戏子域必须反代到同一身份数据库。独立 staging/本地数据库需要自己的测试身份会话，不能拿生产 Cookie 直接访问另一份数据库。

回退代码可以保留新增列和当前数据，不自动恢复数据库备份，避免丢失发布后的玩家操作。已有绑定需要新版本鉴权逻辑；生产绑定开放后不要长期运行仅支持独立登录的旧版本。
