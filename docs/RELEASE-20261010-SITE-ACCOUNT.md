# 2026-10-10 站点账号接入生产发布

用户已明确同意备份、账号映射迁移、前后端发布、后端重启及代码回退。

- 目标：`https://game.bobbycn.cc`。
- 发布目录：服务器 `/opt/stockgame/releases/site-account-20261010-140959`。
- 最终镜像：`sgp-site-account:20261010-140959-r2`。
- 启动覆盖文件：发布目录中的 `new-image.yml`，保持 `DB_SYNCHRONIZE=false`。
- 旧镜像保留为 `sgp-site-account-rollback:20261010-140959`，旧源码、前端均已备份。

停写后，迁移脚本先生成 `/app/data/stockgame.db.before-site-game-account.sqlite` 一致性备份，再添加可空的 `users.identityId` 和唯一索引 `IDX_users_site_identity`。原库及备份均通过 `quick_check`，所有业务表记录数量一致；没有批量绑定、合并或重置玩家账户。

公网校验发现主站 `/api/auth/site-return` 被既有 Nginx 通用 API 路由转发到旧云后端。修复为 `/api/auth/identity/game-return` 后发布 r2，复用主站现有身份服务路由，没有修改 Nginx 配置，数据库没有重复迁移。

构建及本地验证：后端全量 751 项、前端全量 119 项通过；回跳修复后，后端专项 27 项、前端专项 13 项及前后端构建再次通过。真实 HTTP 测试覆盖站点 Cookie、Ed25519 令牌、游戏账号映射、旧账号资产保留与站点退出后的访问撤销。

生产只执行公开页面、静态资源、匿名鉴权、回跳及健康检查，不用真实玩家凭证进行测试登录或创建测试账号。

公网验证通过：17 个前端文件与本地发布产物 SHA-256 一致；站点登录页及游戏登录页正常；主站回跳返回 302 到游戏登录页，非法目标返回 400；行情、基金和公钥接口正常，匿名游戏账户及站点会话请求返回 401。

## 回退

服务器执行 `bash /opt/stockgame/releases/site-account-20261010-140959/rollback-code.sh` 可恢复接入前的镜像和前端，保留当前数据库与新增列，不自动恢复数据库备份。旧版本不支持站点账号登录，回退用于应急恢复，已有绑定应尽快恢复运行支持统一登录的版本。

r2 前的站点接入镜像及前端也已单独保留，修复构建及发布记录位于发布目录的 `r2/` 子目录。

登录修复：生产遗漏 `COOKIE_DOMAIN`，导致主站登录签发的 sid 为 host-only，游戏子域无法接收。现已在生产 Compose 覆盖与仓库部署配置补齐 `COOKIE_DOMAIN=.bobbycn.cc`、`COOKIE_SECURE=1`，保持镜像、数据库及其他配置不变。已有主站登录需要重新登录以签发共享 Cookie。
