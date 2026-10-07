# 合作开发上手指南

> 给合作开发者（Liujiarui0301）。**2026-10-07 起你不再需要"求人帮你上线"**——两条线都能自己发布。
> 详细环境说明见 [`STAGING.md`](./STAGING.md)。

## 1. 你手上多了什么

| 能力 | 以前 | 现在 |
|---|---|---|
| 改主页 / 游戏厅静态站 | 能改代码，但 push 了线上不变（主站是自建服务器） | **push 到 main 即自动上线**，部署前有一个审批闸门 |
| 改游戏后端 | 只能本地跑，改了没法让别人看到 | **有自己的测试环境** `staging.bobbycn.cc`，随便部署随便折腾 |
| 看线上日志 | 没权限 | 需要服务器 SSH（见第 5 节，把你的公钥给站长） |

**测试环境与线上完全隔离**：独立容器、独立数据库（线上库的一次性快照）、独立密钥、独立博客目录。你在里面删表、改 schema、跑崩服务，都不影响 `game.bobbycn.cc` 和 `bobbycn.cc`。

## 2. 凭据

| 项 | 值 |
|---|---|
| 测试站地址 | `https://staging.bobbycn.cc/` |
| 站点口令（Basic Auth） | `staging` / **‹由站长私发›** |
| 管理员账号 | `admin` / **‹由站长私发›** |
| 服务器 | `ubuntu@43.133.165.97`（需先提交公钥） |

测试环境**故意没有配邮件密钥**：注册/找回口令的邮件只会写进容器日志（`docker compose logs backend`），这样测试绝不会给真实用户发信。Turnstile 用的是 Cloudflare 官方"永远通过"的测试密钥，所以人机校验不会挡你。

## 3. 本地开发

```bash
git clone git@github.com:bobbychina32747/StockGameOnlinePro.git
cd StockGameOnlinePro

# 后端
cd backend
npm ci
cp .env.example .env      # 按需改；本地默认 better-sqlite3 → ./data/stockgame.db
npm run start:dev         # 或回到仓库根执行 start.bat 一键起前后端

# 前端（另开一个终端）
cd frontend
npm ci
npm run dev               # http://localhost:3000，/api 与 /socket.io 已代理到 8000
```

改动提交前请过一遍 CI 同款检查（`.github/workflows/ci.yml` 里跑的就是这些）：

```bash
cd backend  && npm run build && npm test -- --runInBand
cd frontend && npm run lint && npx tsc -b && npm test -- --runInBand && npm run build
```

## 4. 发布

### 4.1 主页静态站（bobbycn.cc）

```bash
git push origin main        # 剩下的交给 GitHub Actions
```

流水线会：i18n 自检 → 必需文件存在性检查 → 打包 → 同步到服务器 `/var/www/portal` → 线上冒烟（四个 URL 必须 200）。
它在部署前会**留一份快照**在服务器 `/opt/stockgame/snapshots/`，回滚用 `tools/rollback-portal.sh`。

> 仓库里那些看起来"多余"的检查不是摆设：`favicon.svg`、`icon-*.png`、`assets/blog.js`、`mail/index.html` 这些文件**一度只存在于站长本机和服务器上、从未 `git add`**，任何一次"从 git 打包"的部署都会把它们从线上抹掉。存在性检查就是为了拦住这类事故——**别把它删了**。

### 4.2 游戏后端（staging）

后端代码在服务器上**不是 git 仓库**，是上传的源码树，所以流程是"传代码 → 重建容器"：

```bash
# 1) 同步后端源码到测试环境（保留服务器上的 .env 与 data，不要覆盖）
rsync -avz --delete \
  --exclude node_modules --exclude dist --exclude data --exclude .env \
  -e "ssh -i <你的密钥>" \
  backend/ ubuntu@43.133.165.97:/opt/stockgame/backend/

# 2) 重建测试容器
ssh -i <你的密钥> ubuntu@43.133.165.97 \
  'cd /opt/stockgame/staging && sudo docker compose up -d --build'

# 3) 验收（必须看到 healthy，别只看 ssh 的退出码）
ssh -i <你的密钥> ubuntu@43.133.165.97 \
  'sudo docker compose -f /opt/stockgame/staging/docker-compose.yml ps && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8001/api/market/prices'
```

### 4.3 游戏前端（staging）

```bash
cd frontend && npm run build
tar -czf /tmp/sgp-frontend-dist.tgz -C dist .
scp -i <你的密钥> /tmp/sgp-frontend-dist.tgz ubuntu@43.133.165.97:/tmp/
ssh -i <你的密钥> ubuntu@43.133.165.97 \
  'sudo rm -rf /var/www/sgp-staging/* && sudo tar -xzf /tmp/sgp-frontend-dist.tgz -C /var/www/sgp-staging && sudo chown -R www-data:www-data /var/www/sgp-staging'
```

前端 `API_BASE = '/api'` 是相对路径，**同一份产物线上/测试通用**，不需要分环境构建。

## 5. 需要站长配合的一件事：加你的 SSH 公钥

服务器现在只有两把钥匙（站长的 + GitHub Actions 部署用的）。把你的公钥发过来，站长执行一次即可：

```powershell
# 在站长机器上（把 <你的公钥> 换成你发来的那一行）
ssh -i $env:USERPROFILE\.ssh\Main.pem ubuntu@43.133.165.97 `
  "printf '%s\n' '<你的公钥>' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"
```

没有公钥时你仍然能：改代码、push（主页自动上线）、在本地跑全部测试；只是**没法把后端部署到测试环境**。

## 6. 不要做的事

1. **不要碰线上容器与线上目录**：`sgp-backend`、`/var/www/portal`、`/opt/stockgame/backend/.env`、`/opt/stockgame/keys/`。测试一律用 `sgp-backend-staging`。
2. **不要把线上 `.env` 的内容复制进仓库/issue/CI 日志**（里面有 JWT、管理员口令、Resend key、身份签名私钥路径）。
3. **不要用 `rsync --delete` 同步前端到 `/var/www/sgp`（线上）**——只同步到 `/var/www/sgp-staging`。
4. **不要删主页仓库里的存在性检查、也不要删 `.deploy-key/` 的 gitignore 条目**（前者防抹掉线上文件，后者防私钥入库）。
5. 同一台机器只有 8GB 内存 / 2 核，且跑着线上服务：别在服务器上跑压测或长时间满载任务。
