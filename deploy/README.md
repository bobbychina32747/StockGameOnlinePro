# 上云必知 + 部署手册（单文件版）

> StockGameOnlinePro + 个人主页门户的采购决策与上线手册。
> 目标形态：一台免备案海外轻量服务器，承载「个人主页 + 游戏 + API/WebSocket」。
> 配套执行文件（本目录）：`docker-compose.override.yml`、`nginx/portal.conf`、`nginx/game.conf`、`scripts/backup-sqlite.sh`。

---

## 0. 决策摘要（TL;DR）

| 项目 | 结论 | 花费 |
|---|---|---|
| 服务器 | 腾讯云轻量 · **海外（东京）** · 入门型 · **2核8G / 80G SSD / 30M峰值 / 2.5TB月流量** · 年付 | **≈734 元/年**（85 折，续费同价） |
| 域名 | **bobbychina.cn**（备选 bobbychina.com） | 42 元/年（.com 则 95 元/年） |
| 备案 | **不做**。服务器在香港/海外，域名解析过去直接可用 | 0 |
| HTTPS | acme.sh + Let's Encrypt，自动续期 | 0 |
| 架构 | 宿主 Nginx（门户 + 游戏静态）+ 单个后端容器（NestJS + SQLite） | — |

```
bobbychina.cn        ──► 宿主 Nginx ──► /var/www/portal   （个人主页，静态单文件）
game.bobbychina.cn   ──► 宿主 Nginx ──► /var/www/sgp      （游戏前端，本地构建的 dist）
                            └── /api/  /socket.io/ ──► 127.0.0.1:8000（sgp-backend 容器 + SQLite 卷）
```

只跑一个容器：前端产物是纯静态，宿主 Nginx 直接托管更省内存、更少故障面。

---

## 1. 服务器：买哪台、为什么

**买：腾讯云轻量应用服务器 · 地域选东京 · 入门型 · 2核8G / 80G SSD / 30M峰值 / 2560GB月流量 · 一次性买 1 年。**

官方定价（腾讯云轻量定价文档）72 元/月；香港与海外地域「12 个月及以上 85 折」**只适用于 2核8G 及以上**（入门型/通用型）或 4核8G 及以上锐驰型——所以这台年付 ≈ 72×12×0.85 = **734.4 元**，且**新购与续费同享折扣，续费不涨**。

### 1.1 关键的两个机制（决定了为什么不是别的档）

1. **折扣门槛造成价格倒挂**：2核4G 无折扣 = 54×12 = 648 元；2核8G 打折 = 734 元。**多花 86 元，内存翻倍**。整张表里 2核8G 入门型是性价比最高点。
2. **香港入门型被官方排除**：定价文档原文「中国香港入门型套餐无法保障中国内地与中国香港之间的跨境公网质量，在跨境连接时可能出现较大的网络延迟和丢包」。面向国内玩家的游戏**不能选香港入门型**；海外（东京/首尔）入门型没有这条警告。

### 1.2 候选对比（腾讯云官方定价，Linux 套餐）

| 方案 | 配置 | 月价 | 年付 | 判断 |
|---|---|---|---|---|
| **海外（东京/首尔）入门型** | **2核8G** / 80G / 30M峰值 / 2.5TB | 72 | **≈734**（85折） | ★ 选它 |
| 海外 入门型 | 2核4G / 70G / 30M峰值 / 2TB | 54 | 648 | 无折扣，只便宜 86 元，不值 |
| 海外 入门型 | 2核2G / 50G / 30M峰值 / 1TB | 33 | 396 | 无折扣，构建靠 swap 硬扛 |
| 海外 通用型 | 2核8G / 120G / 30M峰值 / 3.5TB | 105 | 1071 | 超预算 |
| 中国香港 入门型 | 2核2G / 50G / 30M峰值 / 1TB | 54 | 648 | ⚠ 官方点名不保障跨境质量 |
| 中国香港 锐驰型 | 2核2G / 40G / 200M峰值 / 无限流量 | 55 | 660 | 香港唯一没被警告的档，但只有 2G 内存、无折扣 |
| Oracle Cloud Always Free | 4 OCPU ARM / 24G / 200G | — | 0 | 需信用卡验证、ARM 常缺货、有封号风险 |

**地域优先级（给国内玩家）**：东京 ≈ 首尔 > 新加坡 > 香港（仅锐驰型可考虑）>> 硅谷/法兰克福（150ms+，别选）。

### 1.3 其它价格事实

- 超额流量 0.8 元/GB（东京/首尔/新加坡/法兰克福/雅加达），香港 1.0 元/GB，硅谷 0.5 元/GB。2.5TB/月 对个人站用不完。
- 加盘很贵：港澳台及海外云硬盘约 1 元/GB/月，**别加**，80G 够。
- 自定义镜像每地域 5 个免费配额，超出 0.01 元/小时；备份点配额约 0.11 元/GB/月。
- 线路：境外轻量是普通 BGP（非 CN2），跨境晚高峰会有波动，这是免备案的固有代价。

### 1.4 明确不要买的

- **阿里云「99 上云套餐」**：其中 ALB 按量付费、按小时收实例费且**实例不释放就一直扣**（约 0.08 元/小时 ≈ 700 元/年，比服务器本身贵 7 倍）；WoSign DV 证书 190.8 元/年也没必要（Let's Encrypt 免费）；阿里云盘企业版与部署无关。单机项目 Nginx 就是全部反代需求。
- **阿里云 99 元 ECS / 腾讯云内地轻量**：只在 9 个大陆地域售卖，买了就必须 ICP 备案，与本方案互斥。
- **非标端口绕备案**（域名解析到大陆 IP 走 8443 之类）：违规用法，被抽查会要求整改甚至关停，别赌。

---

## 2. 域名：买哪个、实名与过户

### 2.1 结论

- **首选 `bobbychina.cn`**：首年 38，**续费 42/年**，5 年 206 元。后缀短、国内解析与实名最顺。
- **备选 `bobbychina.com`**：首年 85，**续费 95/年**。`.com` 保值、通用、换服务器不用换域名，长期做个人品牌（简历/作品集）更合适。
- 两个都还空着，都是干净的名字。**不要买带 `32747` 的版本**——数字后缀在域名这一层没有价值：别人得对着屏幕抄，念出来是"三二七四七"，语音/名片/口语传播必崩。`32747` 留在 GitHub 和游戏 ID 那一层就好。

### 2.2 只看续费价：首年价全是钓饵

| 后缀 | 首年 | 续费 | |
|---|---|---|---|
| .cn / .com.cn / .net.cn | 38 | **42** | 续费最友好 |
| .top | 14 | 39 | 友好 |
| .ren | 35 | 39 | 友好 |
| .vip / .work | 34 / 15 | 45 | 友好 |
| .com | 85 | 95 | 正常 |
| .net | 95 | 105 | 正常 |
| .cc | 32 | **80** | 第二年 2.5 倍 |
| .me | 39 | **135** | 3.5 倍 |
| .xyz | 6 | **120** | 20 倍 |
| .icu | 6 | **125** | 21 倍 |
| .store | 8 | **139** | 17 倍 |
| .club | 10 | **128** | 13 倍 |
| .info | 23 | **180** | 8 倍 |
| .tech | 8 | **259** | 32 倍 |

**不买「组合购买」**（如 .cn+.ren+.info+.ltd 首年 60 元）：送你几个用不上的后缀，每个都是续费刺客。
**不买「15 元 AI 建站送 .CN」**：你不需要建站工具，送的那年域名第二年照收 42。

### 2.3 实名、备案、过户——三件事要分清

- **域名实名认证 ≠ 备案**。境内注册商（阿里云/腾讯云）注册的域名强制实名：填一个持有者信息模板 + 传身份证照片即可，**不需要人脸核验、不需要管局审核、不是备案**。境外注册商（Porkbun、Cloudflare Registrar、Namecheap 等）不受工信部管辖，**连实名都不需要**（支付一般要信用卡/PayPal）。
- **本方案不备案**：服务器在东京，域名解析过去即可访问，无需任何备案流程。
- **域名将来可以过户到你名下**：同一注册商内改持有者（阿里云叫"域名持有者信息修改"），免费、不影响解析与已签发证书。`.cn` 由 CNNIC 管，过户要提交双方身份证明走审核（1–3 工作日）；域名信息变更后短期内不能转出注册商，但同注册商内过户不受影响。
  - 顺带记住：**将来若要备案，备案主体必须与域名持有者一致**。域名在你爸名下 → 他做主体；过到你名下 → 你才能自己备案。
- **服务器无法"过户"**：云账号的实名主体改不了，跨账号资源转移通常要求双方实名一致（父子不同实名走不通）。但你不需要它——项目是 Docker + 一个 SQLite 文件，等你满 18 自己开账号时：新机 → 传代码 + 传最新 db 备份 → 切 DNS，半小时的事。想省事还可以用**自定义镜像跨账号共享**。
- **域名一定开自动续费**：任何一年忘续，宽限期一过就被释放，谁都能抢，那才是真没了。

---

## 3. 服务器初始化

```bash
# 时区（业务是中国 A 股口径，宿主和容器都要钉死北京时间）
timedatectl set-timezone Asia/Shanghai

apt update && apt install -y nginx sqlite3 rsync

# 8G 内存本可不用 swap，留 2G 兜底构建峰值（80G 盘不缺这点空间）
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf

# Docker
curl -fsSL https://get.docker.com | sh
```

**防火墙/安全组只放 22 / 80 / 443**（腾讯云轻量在控制台「防火墙」里配，默认可能多开了端口，去核对一遍）。SSH 建议改非默认端口 + 禁用密码登录（用密钥）。

---

## 4. 代码与配置

```bash
mkdir -p /opt/stockgame && cd /opt/stockgame
git clone <你的仓库地址> .          # 或本地 tar 上传

cp backend/.env.example backend/.env
```

`backend/.env` 生产必改项：

```ini
NODE_ENV=production
PORT=8000
# 强随机密钥，后端会拒绝弱密钥启动
# 生成：node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=<48 字节随机 hex>
JWT_REFRESH_SECRET=<另一串 48 字节随机 hex>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<>=12 位强密码，别用示例值>
# 保持真实节奏；快档必须同时 SANDBOX_FAST=true，生产不要开
TICK_INTERVAL_MS=60000
SANDBOX_FAST=
```

**数据库迁移（可选）**：想让线上延续本地那 103MB 真实数据，先导出干净副本再上传，**不要直接拷 `.db-wal` / `.db-shm`**：

```powershell
# 本地 Windows（WAL 模式下直接复制 db 文件会得到不一致快照）
sqlite3.exe E:\Files\Games\stockgameonlinepro\backend\data\stockgame.db ".backup E:\Files\sgp-prod.db"
scp E:\Files\sgp-prod.db root@<IP>:/opt/stockgame/seed.db
```

```bash
# 服务器：灌进容器卷（首次启动前执行）
docker volume create sgp-data
docker run --rm -v sgp-data:/data -v /opt/stockgame:/seed alpine \
  sh -c 'cp /seed/seed.db /data/stockgame.db && chown -R 1000:1000 /data'
```

从空库开始则跳过这一步。

---

## 5. 起后端

```bash
cd /opt/stockgame
DOCKER="docker compose -f backend/docker/docker-compose.yml -f deploy/docker-compose.override.yml"
$DOCKER up -d --build

# 验证（公开无认证端点）
curl -s localhost:8000/api/market/prices | head -c 300
$DOCKER logs -f --tail=100 backend
```

override 做了四件事：端口只绑 `127.0.0.1`、内存上限 1100M + Node 堆 900M、日志轮转 10M×3、`TZ=Asia/Shanghai`。

> 若 `npm ci` 阶段 better-sqlite3 报 node-gyp/编译错误：`node:22-alpine` 缺构建工具链，把 `Dockerfile.backend` 的基础镜像换成 `node:22-slim`（glibc 有官方 prebuilt），或临时 `apk add --no-cache python3 make g++`。

---

## 6. 起前端（本地构建，服务器只收产物）

```powershell
cd E:\Files\Games\stockgameonlinepro\frontend
npm ci
npm run build
# 用 tar 管道直传，避开 PowerShell 不展开通配符的坑
tar -czf - -C dist . | ssh root@<IP> "mkdir -p /var/www/sgp && tar -xzf - -C /var/www/sgp"
```

Vite `base` 保持默认 `'/'`（游戏走子域名，PWA 的 `scope` 才不会错位）。**前端永远在本地构建**，服务器只跑产物。

---

## 7. 个人主页

主页是纯静态单文件，放到 `/var/www/portal/index.html`（`deploy/nginx/portal.conf` 已把「看 Blog」301 到 GitHub Pages，不必另做博客系统）。

```powershell
scp .\index.html root@<IP>:/var/www/portal/index.html
```

---

## 8. Nginx + 免费 HTTPS

```bash
cp deploy/nginx/portal.conf /etc/nginx/conf.d/portal.conf
cp deploy/nginx/game.conf   /etc/nginx/conf.d/game.conf
sed -i 's/YOUR_DOMAIN/bobbychina.cn/g' /etc/nginx/conf.d/*.conf   # 换成你的域名
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot

# 免费证书，一张覆盖主域 + www + game 子域，自动续期
curl https://get.acme.sh | sh -s email=你的邮箱
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
mkdir -p /etc/nginx/ssl/bobbychina.cn
~/.acme.sh/acme.sh --issue -d bobbychina.cn -d www.bobbychina.cn -d game.bobbychina.cn -w /var/www/certbot
~/.acme.sh/acme.sh --install-cert -d bobbychina.cn \
  --key-file       /etc/nginx/ssl/bobbychina.cn/privkey.key \
  --fullchain-file /etc/nginx/ssl/bobbychina.cn/fullchain.crt \
  --reloadcmd      "systemctl reload nginx"

nginx -t && systemctl reload nginx
```

域名解析：`@` 和 `www` 指向服务器公网 IP，`game` 加一条 A 记录指向同一 IP。**免备案，解析生效即可访问**（境内 DNS 通常几分钟内生效）。

---

## 9. 备份（103MB 真实用户数据，别省）

```bash
mkdir -p /opt/backups
cp deploy/scripts/backup-sqlite.sh /opt/stockgame/
chmod +x /opt/stockgame/backup-sqlite.sh
crontab -e
# 每天 04:20 备份，保留 14 天
20 4 * * * /opt/stockgame/backup-sqlite.sh >> /var/log/sgp-backup.log 2>&1
```

脚本用 `sqlite3 .backup`（WAL 模式下 `cp` 会拿到不一致快照），自动定位卷路径，可选 `ossutil` 上传 OSS 做异地容灾。**应用内导出/赛季重置前先手动跑一次。**

---

## 10. 日常运维

```bash
DOCKER="docker compose -f backend/docker/docker-compose.yml -f deploy/docker-compose.override.yml"
$DOCKER ps                      # 状态
$DOCKER logs -f --tail=200 backend
free -h ; df -h                 # 2核8G + 80G 盘
docker stats --no-stream
docker system prune -f          # 镜像/构建缓存最容易吃满盘
```

更新流程：`git pull` → `$DOCKER up -d --build` → 本地重新 `npm run build` + 上传 dist。

---

## 11. 坑清单（全部）

1. **时区**：容器不设 `TZ` 就是 UTC，A 股开盘/收盘/交易日判断会整体偏 8 小时。override 已处理，别删。
2. **8000 端口不要出现在防火墙里**：override 已把容器端口绑到 `127.0.0.1`，公网只经 Nginx。
3. **`TICK_INTERVAL_MS < 60000` 必须同时 `SANDBOX_FAST=true`**，否则后端拒绝启动——改配置别只改一半。
4. **`infra/docker-compose.yml` 是 LEGACY**（Postgres/Redis 时代遗留，构建引用已失效），现役编排只有 `backend/docker/docker-compose.yml`。
5. **别在服务器上跑 `infra/` 里的 Prometheus + Grafana**：8G 内存塞得下但没必要，用云厂商监控或 Uptime Kuma 更省。
6. **带宽**：30M 峰值（≈3.7MB/s）不宽裕。echarts 已分包但首屏 JS 仍有约 1MB，靠 gzip + PWA 缓存顶住；图多了就把 `assets/` 挂 CDN。
7. **磁盘**：80G 不是问题，Docker 构建缓存才是。定期 `docker system prune -f`。
8. **SQLite 备份只能 `.backup`**，不能 `cp`（WAL 模式）。
9. **境外线路晚高峰会抖**：这是免备案的固有代价，不是配置问题。
10. **域名忘续 = 永久失去**，一定开自动续费。
11. **静态缓存头**：`/assets/*`（Vite hash 产物）配 `Cache-Control: public, max-age=31536000, immutable` 长缓存；`index.html` 与 `sw.js` **必须 `no-cache`**（`no-store` 亦可）——否则浏览器/CDN 缓存旧壳，发版后新 `sw.js` 拿不到、新 hash 资产也引用不上（PWA 表现为长时间停在旧版本）。

---

## 12. 现在该做什么

- [ ] 腾讯云下单：轻量 · **东京** · 入门型 · **2核8G / 80G / 30M峰值** · 一次性买 1 年（确认结算页 85 折生效 ≈734 元）
- [ ] 注册域名：`bobbychina.cn`（38 首年）或 `bobbychina.com`（85 首年），用你爸的身份信息建实名模板，**开自动续费**
- [ ] 解析：`@` / `www` / `game` 三条 A 记录指向服务器 IP
- [ ] 提供主页三要素：显示的名字、联系方式、Blog 去向（跳 GitHub Pages 还是站内） → 然后按第 1 节开始部署
