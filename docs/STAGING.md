# StockSim Pro 测试环境（staging）

> 2026-10-07 建立。目的：让合作开发者能**自由部署、随便折腾后端**，而碰不到线上。
> 线上（`game.bobbycn.cc` / `bobbycn.cc`）与这里共用一台机器，但**容器、数据库、密钥、博客目录、入口全部隔离**。

## 0. 两条部署线各归各

| 你要改的东西 | 代码在哪 | 怎么上线 | 谁能部署 |
|---|---|---|---|
| 个人主页（bobbycn.cc 静态站） | `Bobbychina/Bobbychina.github.io` | push main → GitHub Actions 自动同步到 `/var/www/portal` | 有 write 权限的人都可以（部署前有 production 环境审批闸门） |
| 游戏前端 / 后端（game.bobbycn.cc） | `bobbychina32747/StockGameOnlinePro` | 见下方第 3 节：前端传 dist、后端重建 staging 容器 | 见「访问方式」 |
| 博客文章 | 站内写作台 `/admin/` 或 `bobbychina-blog` | 写作台点保存即发布（容器内渲染） | 只用网页，不需要服务器 |

主页那条线的流水线定义在仓库 `.github/workflows/deploy.yml`，回滚脚本是 `tools/rollback-portal.sh`（服务器上执行）。

## 1. 拓扑

```
                       Cloudflare（橙云）
                              │
                    43.133.165.97 · 宿主 nginx
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
  bobbycn.cc           game.bobbycn.cc      staging.bobbycn.cc
  /var/www/portal      /var/www/sgp         /var/www/sgp-staging
        │                     │                     │
        │              127.0.0.1:8000        127.0.0.1:8001
        │                     │                     │
        │            sgp-backend（线上）    sgp-backend-staging（测试）
        │            docker_sgp-data 卷     /opt/stockgame/staging/data
        └── 博客产物 /opt/stockgame/blog-dist（线下共用，测试环境另有独立 blog-dist）
```

**隔离点（逐条都可验证）**

| 维度 | 线上 | 测试 |
|---|---|---|
| 容器名 | `sgp-backend` | `sgp-backend-staging` |
| 端口（仅回环） | 8000 | 8001 |
| 数据库 | 卷 `docker_sgp-data` | 绑定挂载 `/opt/stockgame/staging/data` |
| `JWT_SECRET` / 管理员口令 | 生产值 | **另一套**（见 `.env`，与线上不同） |
| 邮件 | Resend（真发） | **无 `RESEND_API_KEY`** → LogMailer，只写容器日志 |
| Turnstile | 真实密钥 | Cloudflare 官方测试密钥（永远通过） |
| 博客目录 | `/opt/stockgame/blog{,-dist}` | `/opt/stockgame/staging/blog{,-dist}` |
| 入口 | 无口令 | **Basic 口令**（防搜索/路人） |

**同一棵源码树**：staging 容器的 build context 直接指向 `/opt/stockgame/backend`，复用线上那份 `Dockerfile.backend`。所以代码只有一份，不存在两处漂移；改完源码重建 staging 即可。

**博客目录为什么必须分开**：写作台的接口会往 `BLOG_DIR` 写 Markdown、再渲染进 `BLOG_DIST`。若两个环境共用，测试环境调一次接口就会改到**线上正在展示的文章**。

## 2. 访问方式

- 入口：`https://staging.bobbycn.cc/`
- Basic 口令：`staging` / `<口令>`（口令存在服务器 `/etc/nginx/.htpasswd-staging`，只给合作开发者）
- 管理员账号：`admin` / `<口令>`（在 `/opt/stockgame/staging/prod.env` 的 `ADMIN_PASSWORD`）
- **数据库是线上库的一次性快照**：真实游戏状态与账号都在，但之后两边各走各的，随便改。

> 注：`staging.bobbycn.cc` 需要在 Cloudflare 加一条 A 记录指向 `43.133.165.97`（橙云）才能公网访问。证书是 `*.bobbycn.cc` 通配，已覆盖。

## 3. 日常操作（在服务器上）

```bash
cd /opt/stockgame/staging

# 看状态 / 日志
sudo docker compose ps
sudo docker compose logs -f --tail 100 backend

# 改完源码后重建（源码在 /opt/stockgame/backend）
sudo docker compose up -d --build
sudo docker compose restart backend      # 只重启、不重建

# 重置数据库（回到快照之前的状态：删掉即重新拉一份线上快照，见 setup 脚本）
sudo rm /opt/stockgame/staging/data/stockgame.db
sudo bash /tmp/setup-staging.sh          # 幂等脚本，会重新做一次快照
```

**前端（Vite 产物）**

`frontend/src/services/api.client.ts` 里 `API_BASE = '/api'` 是相对路径，**同一份构建产物在线上与测试环境通用**，不需要按环境改配置。

```bash
# 本地构建
cd frontend && npm run build
# 上传（把 dist 解到测试环境的静态根）
tar -czf /tmp/sgp-frontend-dist.tgz -C dist .
scp -i <你的密钥> /tmp/sgp-frontend-dist.tgz ubuntu@43.133.165.97:/tmp/
ssh -i <你的密钥> ubuntu@43.133.165.97 \
  'sudo rm -rf /var/www/sgp-staging/* && sudo tar -xzf /tmp/sgp-frontend-dist.tgz -C /var/www/sgp-staging && sudo chown -R www-data:www-data /var/www/sgp-staging'
```

> `.env` 改动**必须重建容器**：环境变量在容器创建时固定，`docker restart` 不重读。改完用 `docker compose ps` 确认 `Up … (healthy)`。

## 4. 密钥与红线

测试环境用的都是**测试专用**值，与线上不同：

| 变量 | 测试环境取值 |
|---|---|
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | 独立随机值（在 `prod.env`） |
| `ADMIN_PASSWORD` | 独立口令（在 `prod.env`） |
| `TURNSTILE_SECRET` | `2x0000000000000000000000000000000AA`（Cloudflare 永远通过的测试密钥） |
| `RESEND_API_KEY` | **不配** → 邮件只进日志，不可能给真实用户发信 |

**红线（写进流程，不靠自觉）**

1. **不要动线上容器** `sgp-backend`，也不要动 `/var/www/portal`、`/opt/stockgame/backend/.env`。测试一律在 `sgp-backend-staging`。
2. **线上 `.env` 里的密钥不外传、不进仓库、不进 CI 日志**（其中的 `IDENTITY_JWT_KEY_FILE` 指向 `/opt/stockgame/keys/identity-ed25519.pem`，那是身份令牌签名私钥）。
3. 线上库是**唯一真源**。测试环境可以随便删表/改数据；线上库任何写操作都要先备份（每日 `.backup` 已在跑）。
4. 同一台机器只有 8GB 内存、2 核：staging 容器已限 `mem_limit: 700m`、Node 堆 512MB。不要在里面跑压力测试/大循环。

## 5. 排障（本次搭建踩过的坑，按症状查）

| 症状 | 真因 | 处置 |
|---|---|---|
| 容器 `Restarting`，日志报 `TICK_INTERVAL_MS=1000 < 60000 为沙盒高速回放…` | 应用有硬校验：`TICK_INTERVAL_MS < 60000` 必须显式 `SANDBOX_FAST=true` | 用 `60000` 与线上同口径（测试环境本就该复现真实节奏） |
| 容器"起来了"、接口 200，但数据是空的（users 只剩 1） | compose 用了**命名卷**，而快照写在宿主目录 → 容器读的是另一个空库并自建表 | 数据库必须**绑定挂载** `/opt/stockgame/staging/data:/app/data`；用 `stat -c '%i'` 对比宿主与容器 inode 确认是同一文件 |
| `[ -f "$路径/stockgame.db" ]` 判不出文件、脚本误报"线上没有库" | `/var/lib/docker/volumes/...` 是 root 权限，**不加 sudo 探测不到** | 卷相关判断一律 `sudo test`；幂等判据用 `-s`（存在且非空），失败留下的 0 字节空壳会被 `-f` 误判成"已就绪" |
| 快照可能损坏（容器正在写 + 20MB WAL） | 直接 `cp` 正在写的 SQLite 文件 | 用 `sqlite3 源库 ".backup 目标"`，并用 `PRAGMA quick_check` 验收 |
| `nginx: [emerg] unknown directive "http2"` | 本机 nginx 1.24，`http2 on;` 是 1.25.1+ 语法 | 用旧形式 `listen 443 ssl http2;` |

## 6. 相关文件

| 文件 | 位置 |
|---|---|
| 容器定义 | `/opt/stockgame/staging/docker-compose.yml` |
| 环境变量（0600） | `/opt/stockgame/staging/prod.env` |
| 数据库（快照） | `/opt/stockgame/staging/data/stockgame.db` |
| nginx vhost | `/etc/nginx/conf.d/30-staging.conf` |
| Basic 口令 | `/etc/nginx/.htpasswd-staging` |
| 前端产物 | `/var/www/sgp-staging/` |
| 搭建脚本（幂等） | 服务器 `/tmp/setup-staging.sh`；工作区备份 `bobbychina-pages/.staging/` |
