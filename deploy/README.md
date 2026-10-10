# 上云必知 + 部署手册（单文件版）

> StockGameOnlinePro + 个人主页门户的采购决策与上线手册。
> 目标形态：一台免备案海外轻量服务器，承载「个人主页 + 游戏 + API/WebSocket」。
> 配套执行文件（本目录）：`docker-compose.override.yml`、`nginx/portal.conf`、`nginx/game.conf`、`scripts/backup-sqlite.sh`。

---

## 0. 决策摘要（TL;DR）

| 项目 | 结论 | 花费 |
|---|---|---|
| 服务器 | 腾讯云轻量 · **海外（东京 · 东京二区）** · 入门型 · **2核8G / 80G SSD / 30M峰值 / 2560GB月流量** · 年付 | **≈734 元/年**（85 折）· **已购**：实例 `Bobbychina` / `43.133.165.97` / 到期 2027-09-28 |
| 域名 | **bobbycn.cc**（`.cn` 排除：含 `china` 关键词须权益主体，见 §2.1） | **已购**（阿里云，3 年，到期 2029-09-28）· ⚠ **待实名**，未实名会被暂停解析 |
| 实测线路（2026-09-28 晚） | 自家宽带 → `43.133.165.97`：ping 10/10、**均值 40ms**、0% 丢包；22 端口直连可用 | — |
| 备案 | **不做**。服务器在香港/海外，域名解析过去直接可用 | 0 |
| 边缘保护 | **Cloudflare 免费版（橙云）**：隐藏源站 IP + 免费 TLS + 静态缓存 + 基础 WAF，见 §11.5 | 0 |
| HTTPS | **CF Origin CA 证书（15 年，免续期）**；不再用 Let's Encrypt HTTP-01（源站只放行 CF 后它验不过） | 0 |
| 架构 | Cloudflare（橙云）→ 宿主 Nginx（门户 + 游戏静态）+ 单个后端容器（NestJS + SQLite） | — |

```
访客 ──HTTPS──► Cloudflare 边缘（橙云，bobbycn.cc / *.bobbycn.cc）
                    │ 回源（只允许 CF 回源段）
                    ▼
              东京 43.133.165.97 · 宿主 Nginx
bobbycn.cc        ──► /var/www/portal   （个人主页，静态单文件）
game.bobbycn.cc   ──► /var/www/sgp      （游戏前端，本地构建的 dist）
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

- **实际买的是 `bobbycn.cc`**（阿里云，2026-09-28 注册，3 年到 2029-09-28）。原首选 `.cn` 走不通：`bobbychina.cn` 在注册商侧显示「限制域名，不可注册，部分限制域名仅限指定权益主体申请」——含 `china` 关键词的 `.cn` 本来就要权益主体资质，不是"被别人占了"。`.com/.net/.io` 没有这条关键词审查。
- **`bobbychina.com` 仍然空着**（Verisign RDAP 实测 404）。想和 GitHub / 游戏 ID 那个名字对齐就补一个，不补则 `bobbycn.cc` 就是正式主线。
- **续费锚点**：`.cc` 首年 32 / **续费 80**（第二年起 2.5 倍，已用 3 年买断这轮涨价）；对照 `.com` 95、`.cn` 42。**开自动续费**——未实名的域名连续费都做不了。**不要买带 `32747` 的版本**——数字后缀在域名这一层没有价值：别人得对着屏幕抄，念出来是"三二七四七"，语音/名片/口语传播必崩。`32747` 留在 GitHub 和游戏 ID 那一层就好。

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
sed -i 's/YOUR_DOMAIN/bobbycn.cc/g' /etc/nginx/conf.d/*.conf   # 换成你的域名
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot

# 免费证书，一张覆盖主域 + www + game 子域，自动续期
curl https://get.acme.sh | sh -s email=你的邮箱
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
mkdir -p /etc/nginx/ssl/bobbycn.cc
~/.acme.sh/acme.sh --issue -d bobbycn.cc -d www.bobbycn.cc -d game.bobbycn.cc -w /var/www/certbot
~/.acme.sh/acme.sh --install-cert -d bobbycn.cc \
  --key-file       /etc/nginx/ssl/bobbycn.cc/privkey.key \
  --fullchain-file /etc/nginx/ssl/bobbycn.cc/fullchain.crt \
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
12. **SSH 加固文件的排序**（本机实测踩过）：`sshd_config` 是「**第一个取到的值生效**」，而 `Include /etc/ssh/sshd_config.d/*.conf` 在主配置顶部按文件名排序加载——`99-hardening.conf` 会被 `50-cloud-init.conf` 里的 `PasswordAuthentication yes` 抢先，看起来 reload 成功其实没生效。加固文件必须用 **`00-` 前缀**，改完用 `sudo sshd -T | grep -E '^passwordauthentication'` 复核，别只看 `reload ok`。
13. **CF 回源白名单不能用 `allow/deny`**（本机实测踩过，详见 §11.5.3）：realip 还原后 `$remote_addr` 已经是真实访客 IP，`allow <CF段>; deny all;` 会连 CF 流量一起 403。判定要用 `$realip_remote_addr`（geo 变量）。改完必须两侧都验：经 CF **200**、直连 IP **403**。
14. **Healthcheck 别写成 exec 形式的 `||`**（本机实测踩过）：compose 里 `test: ["CMD", "wget", …, "||", "exit", "1"]` 会把 `||` / `exit` / `1` 当参数传给 wget，容器永远 `unhealthy`。用 `CMD-SHELL` 或干脆去掉这段。
15. **容器内对挂载点做"先删目录再重建"必然失败**（本机实测踩过）：产物目录一旦是 docker 挂载点（如 `/blog-dist`），`fs.rmSync(dir)` 报 `EBUSY`，把临时目录放在挂载点**隔壁**（`/blog-dist.tmp`）再 `rename` 又会 `EXDEV`（跨设备）。正确做法：临时目录放在挂载点**内部**（`/blog-dist/.build-tmp`），成功后只清挂载点的内容（跳过临时目录本身）再把条目搬上来。
16. **门户 vhost 的 `/api/*` 是"游戏厅云后端"中继，不等于本机 NestJS**（本机实测踩过）：写作台（`/api/admin/blog/*`）、统一身份（`/api/auth/identity/*`）、写作台登录（`/api/auth/login`）与 `/api/user/profile` 都在本机容器里，必须在 `blog.conf` 里用 `^~` 前缀单独反代到 `127.0.0.1:8000`（nginx 取最长前缀匹配，与 include 顺序无关）。症状很有迷惑性：请求打到 Worker，返回 `{"error":"unauthorized","message":"没登录或会话过期"}`，看起来像"后端守卫正常"，其实是走错了地方。
17. **CF 按扩展名缓存静态文件，改前端必须跳版本号**（本机实测踩了三次）：`.js`/`.css` 会被 CF 缓存 4 小时（实测 `cf-cache-status: HIT`、`Age: 1066`），改了文件线上不生效。约定：
    - `/assets/*`、`/i18n/*` 引用时带 `?v=<日期+字母>`；
    - **改 `i18n.js` 或词典 → 页面里的 `?v=` 要跳**（i18n.js 文件本身变了）；
    - **只改词典 → 还要跳 `i18n.js` 里的 `VER` 常量**（词典 URL 由它决定，且**首屏同步加载**那条 `document.write` 也要带版本号 —— 只补异步那条会漏，这是最阴的一处）；
    - HTML 一律 `Cache-Control: no-cache`（否则浏览器启发式缓存会一直给旧页）；
    - 想立刻生效也可以去 CF 控制台 Purge Everything，但跳版本号更可靠。
18. **PowerShell 脚本里 `$ErrorActionPreference='Stop'` + 原生命令的 stderr = 半途中断**（2026-09-28 实测）：`ssh … docker compose up -d` 时 compose 把 `Container sgp-backend  Recreate` 写到 **stderr**，PS 5.1 会把它变成 ErrorRecord 并**在脚本中途抛错退出**；但远端 `up -d` 才刚跑到 Recreate —— 结果容器停在 `Created` 状态、站点 502，本地只看到一行「NativeCommandError」，看起来像 SSH 挂了。两个教训：① 这类脚本**不要**设 `ErrorActionPreference='Stop'`（或对原生命令用 `2>&1 | Out-File` 明确吞掉）；② 远端拉起容器后**必须回查 `docker ps`**，别信 `ssh` 的退出码。
19. **改 `.env` 必须重建容器**：环境变量在容器创建时就固定了，`docker restart` 不重读 `.env`。`docker compose up -d` 发现 env 变化会自动 recreate；改完一律 `docker ps` 看 `Up … (healthy)` 再验收，冷启动约 30s。
20. **tar 部署绝不能带 `backend/.env`**（2026-09-29 真实事故，损失约 4 分钟线上降级）：本地 `backend/.env` 是 8 月的开发配置，打包时没排除 → 解包直接**覆盖服务器 `.env`** → `RESEND_API_KEY`、`TURNSTILE_SECRET/MODE/HOSTNAMES` 全部消失。症状很有欺骗性：站点照常 200，但 ①Turnstile 硬闸**静默失效**（mode 回落 `optional`，无 token 也能注册）②邮件退回 `LogMailer`，注册信只进容器日志，用户收不到。
21. **门户的 nginx 片段在 `/etc/nginx/snippets/blog.conf`，不是 `conf.d/blog.conf`**（2026-09-29 踩过，白查了半小时）：`portal.conf` 里 `include /etc/nginx/snippets/blog.conf;`，往 `conf.d/` 里放同名文件既不会被加载、`nginx -t` 也不会报错（`conf.d/*.conf` 倒是会被加载，所以一个"没被 include 的文件"躺在那里完全不响）。**判断依据**：改完用 `sudo nginx -T | grep -A3 'location 名字'` 确认运行配置里真的有这段，再看一眼 `curl -sI` 的响应头；`reload` 之后第一秒可能还命中旧 worker，别急着下结论。
22. **静态页面的 HTML 也要 `no-cache`，包括博客产物**：少这一个头，浏览器会按启发式缓存把旧页一直用下去，产物更新了用户看到的还是旧的（站主「博客依然没有 icon」就是这个）。HTML 一律 `add_header Cache-Control "no-cache" always;`，别靠"我改了文件它应该会变"。
    - **正确打包**：`tar --exclude=backend/.env --exclude="backend/.env.*" …`，并**打包后自检** `tar -tzf pkg | grep backend/.env` 为空再传；现成脚本 `archive/sessions/2026-10/scripts/deploy-sgp.ps1`。
    - **部署后体检**（三行，缺一不可）：`docker ps` 看 healthy、`docker exec sgp-backend printenv | grep -c RESEND_API_KEY`、启动日志看 `邮件通道：Resend`。
    - **恢复顺序**：服务器 `.env.bak.*` 是按时间戳逐次备份的（改一次备一次），取**最后一个内容完整的备份**回滚，再从本地保险库重传密钥；切完必须用「真 token 注册 → 200」验证硬闸真的在。
    - **判据**：`required` 模式下「无 token → 400」既可能是"校验生效"，也可能是"密钥丢了 fail-closed"，**单看这个 400 分不出来**；只有真 token 能过才算健康。

---

## 11.5 Cloudflare 层（源站保护 + 证书）

> 站前挂一层 CF：隐藏源站 IP、免费 TLS、静态缓存、基础 WAF。免费版即可。
> **`game.` 必须一起橙云**——任何一个子域灰云直连，源站 IP 就从那里泄露，门户那层的保护同时失效。

### 11.5.1 接入（阿里云 DNS → CF）

1. CF 控制台 Add site → `bobbycn.cc` → Free 计划 → 拿到两个 NS。
2. 先在 CF 里把记录建好（**切 NS 前**）：
   - `A @    43.133.165.97`  🟠 Proxied
   - `A www  43.133.165.97`  🟠 Proxied
   - `A game 43.133.165.97`  🟠 Proxied
   - **AAAA 不要加**：源站 IPv6 还没配，加了 CF 会走 v6 回源失败。
3. 阿里云域名控制台 → DNS 修改 → 把 NS 换成 CF 那两个（域名实名不受影响；`.cc` 注册局 NS 变更一般几分钟到几小时）。
4. SSL/TLS 模式 = **Full (strict)**；打开 Always Use HTTPS、Automatic HTTPS Rewrites；HSTS 后开。

### 11.5.2 证书：CF Origin CA，不用 Let's Encrypt

源站只放行 CF 回源段之后，**Let's Encrypt 的 HTTP-01 会被挡死**（验证节点不在 CF 段里）。所以：

1. CF → SSL/TLS → Origin Server → Create Certificate：域名填 `bobbycn.cc` + `*.bobbycn.cc`，有效期 15 年。
2. 落到服务器：`/etc/nginx/ssl/bobbycn.cc/fullchain.crt`（Origin Certificate）与 `privkey.key`。
3. nginx 指这两个文件，reload。**从此没有续期这件事。**

（哪天想回 LE：走 DNS-01（`--dns dns_cf` + CF API Token），别用 HTTP-01。）

### 11.5.3 源站只允许 CF 回源

```bash
sudo bash deploy/scripts/cf-allowlist.sh                                  # 生成两个 snippet
sudo EXTRA_ALLOW="你家宽带公网IP" bash deploy/scripts/cf-allowlist.sh      # 想留直连自测通道就带这个
```

生成三份文件（都被 `portal.conf` / `game.conf` 引用）：

| 文件 | 层级 | 作用 |
|---|---|---|
| `/etc/nginx/conf.d/01-cf-geo.conf` | http | `geo $realip_remote_addr $cf_edge_ok {...}` —— CF 段 + 本机回环 + `EXTRA_ALLOW` |
| `/etc/nginx/snippets/cf-only.conf` | server | `if ($cf_edge_ok = 0) { return 403; }` —— 非 CF 回源一律拒 |
| `/etc/nginx/snippets/cf-realip.conf` | server | `set_real_ip_from` + `real_ip_header CF-Connecting-IP` —— 日志/限流看到真实访客 IP |

⚠️ **判定源必须是 `$realip_remote_addr`，不能用 `allow/deny`（2026-09-28 实测踩过）**：`allow/deny` 看的是 `$remote_addr`，而 realip 模块已经把它改写成**真实访客 IP** 了 —— 用 CF 段去 allow 真实访客，结果是**全站 403**（连 CF 流量一起被挡）。`$realip_remote_addr` 是改写**之前**的对端地址，对 CF 回源而言就是 CF 边缘 IP，这才是要判定的东西。改完必须两侧都验：经 CF **200** + 直连 IP **403**。

CF IP 段偶有变动，**每月跑一次** `sudo bash deploy/scripts/cf-allowlist.sh && sudo systemctl reload nginx` 即可。

腾讯云那侧防火墙 80/443 保持 0.0.0.0/0（CF 回源 IP 段太多，云层白名单不现实），真正的白名单在 nginx 这层。

### 11.5.4 免费版的边界（心里有数）

- **国内延迟可能反而变差**：CF 免费版没有中国节点（中国网络要企业资质 + 备案），国内访客通常落到香港/洛杉矶等境外边缘——直连东京实测 40ms，经 CF 可能变成 150~250ms。静态页吃缓存感觉不明显，**API/WebSocket 要晚高峰实测**。备选是只让门户橙云、`game.` 灰云，但那等于半保护（源站 IP 从 game 泄露）。
- **WebSocket 免费版可用**：socket.io 默认 25s ping，远小于 CF 的 100s 空闲断连阈值。
- **单请求上传上限 100MB**（免费版）：云存档几 MB，无碍。
- **Bot Fight Mode 可能误伤非浏览器客户端**：浏览器前端没事；以后写脚本调 API 要加 Bypass 规则。
- 缓存按 origin 的 `Cache-Control` 走：`/assets/*`（hash 产物）会被缓存，`index.html` / `sw.js` 的 `no-cache` **必须保住**（见坑清单 11）。
- **别开 Development Mode 忘记关**（它会让 CF 不缓存、直接把所有请求打到源站）。

---

## 12. 现在该做什么

- [x] 腾讯云下单：轻量 · **东京二区** · 入门型 · **2核8G / 80G / 30M峰值 / 2560GB月流量** · 1 年（到期 2027-09-28）· 镜像 `Ubuntu Server 24.04 LTS 64bit` · 实例 `Bobbychina` / `43.133.165.97`
- [x] 注册域名：`bobbycn.cc`（阿里云 3 年，到期 2029-09-28）
- [ ] **域名实名认证**：已提交（2026-09-28，审核中）→ 通过后回域名控制台确认状态、**开自动续费**（未实名状态连续费都做不了）
- [x] 服务器初始化与加固（2026-09-28，脚本 `archive/sessions/2026-10/scripts/setup-remote.sh`）：时区 `Asia/Shanghai` / nginx / sqlite3 / rsync / 2G swap / Docker + compose v2 / `ufw`（22、80、443）/ `fail2ban` / 关密码登录 / 目录 `/var/www/{portal,sgp,certbot}` + `/opt/stockgame`
- [ ] **Cloudflare 层**（§11.5）：Add site → 建 `@`/`www`/`game` 三条**橙云** A 记录 → 阿里云改 NS → SSL = Full (strict) → 签 **Origin CA 证书**（15 年）
- [ ] 源站白名单：`sudo EXTRA_ALLOW="自家公网IP" bash deploy/scripts/cf-allowlist.sh` → `nginx -t && systemctl reload nginx`（之后直连 IP 应返回 403，说明保护生效）
- [ ] 部署后端容器 + 前端 dist（第 3 节起），先在 CF 前用 `https://game.bobbycn.cc/api/health` 验收
- [ ] 提供主页三要素：显示的名字、联系方式、Blog 去向（跳 GitHub Pages 还是站内） → 然后按第 3 节开始部署

---

## 13. 站点完整版规划（2026-09-28 选型会 · room-mul9e9wn-2）

> 议题：这台东京单机怎么承载「门户 + 博客 + 游戏 + 未来服务」。五名成员（内容/自研/运维/作品集/安全）带红线开会，结论 = **条件共识**，逐条 gate 见下。原始决议：`C:\Users\lenovo\.dsh\storages\teams\room-mul9e9wn-2\result.md`。

### 13.1 架构基线（C1）

```
CF 橙云（缓存/防打/证书）
 └─ 宿主 nginx：/（门户静态）· /posts /diary /feed.xml /sitemap.xml（博客静态产物）· game.（游戏前端静态）
      └─ 127.0.0.1:8000  单个 NestJS 容器：游戏 API/WS + 站点 API + 博客构建模块（无状态）
           └─ SQLite 卷（游戏库）+ 宿主媒体目录
```

**不上**：第二运行时（Ghost / PHP / WordPress）、Postgres、Redis、K8s、sidecar。

### 13.2 博客形态（C2 + C4）

- 内容 = **Markdown 源进 git**（私有仓库，**远端即异地备份**），配图同仓；
- 构建期产出静态 HTML / RSS / sitemap，宿主 nginx 直出 —— **容器挂了文章照读**；
- URL 构建期固定：`/posts/{slug}/`；已发布 URL 只允许 301，构建时做断链检查；
- NestJS 在博客上只干三件事：拉源 → 渲染 → 写宿主静态目录（webhook / 定时补构建）。**不碰登录、不碰编辑器。**
- 构建必须原子化：先写临时目录、成功再切换；构建失败保留上一版，绝不出现已发布页面 404/500/空白。

### 13.3 写作入口（C3，上线 gate）

- 用**现成 git-based CMS**：优先 **Pages CMS**（GitHub App，零自托管）；若用 Decap，OAuth proxy 托管在 Cloudflare Worker，**不落东京机**（东京机上不得为 CMS 新增任何进程/流水线）；
- 验收标准：**手机 3 分钟内**完成 新建 → 插图 → 预览 → 草稿 → 发布，全程不出现 git / 分支 / commit 字样；
- 草稿必须**服务端持久化**（editorial workflow），不接受只存 localStorage 的假草稿。

### 13.4 安全（C5 + C8）

- 认证只用 GitHub OAuth / CF Access，**不自研口令哈希**；绑定的那个 GitHub/CF 账号**自身必须开 2FA**，无第二因素不得进；
- 上传目录落宿主独立目录 + `noexec`；密钥/凭据宿主 `0600`、不进镜像、不进 git、容器只读挂载；写 git 用**单仓最小权限 GitHub App**；
- 游戏库与站点进程：分文件、权限 `0600`、站点侧只读 —— 这是**权限/代码边界，不是物理隔离**，README 如实标注，防恢复时误判；
- **安全上线 gate**（任一不过，博客不上线）：① 非 CF 网络直连源站 IP，80/443 必须拒绝或仅白名单；② 无凭据访问后台与构建 webhook 返回 401/403，且 webhook 验签；③ 上传目录 `noexec` 可核验。

### 13.5 备份与恢复（C6）

- 游戏库：`sqlite3 .backup`（WAL 下不能 `cp`）+ 媒体 tar + 本地/异地双份 + cron 每天 + **失败告警**；
- 博客源与媒体以 **git 远端为异地备份**（服务器不存唯一副本）；
- **两套媒体口径**写进 README：博客配图进 git（可从 git 重建，不进备份）；游戏/用户上传落宿主目录（不进 git，由媒体 tar 覆盖）；
- **上线前必做演练**：空机 → `compose up` → 恢复脚本 → 可写可玩 **≤10 分钟**，步骤进 README；演练中核验备份产物**不含** `.env` / token 等凭据。

### 13.6 资源纪律（C7）

- 容器内存上限 `1100M` / Node 堆 `900M`；日志轮转 `10M×3`；`TZ=Asia/Shanghai`；
- 镜像不含媒体；每月 `docker system prune`（**prune 前确认不误删备份卷与媒体**）+ 更新 CF IP 段；
- 不在这台机跑 Prometheus / Grafana（用云厂商监控或 Uptime Kuma）。

### 13.7 落地顺序

1. **门户静态上线** —— ✅ 2026-09-28 完成：`bobbychina-pages` 整站迁入 `/var/www/portal`（见 §13.8）
2. **游戏后端 + 前端** —— ✅ 2026-09-28 完成：`sgp-backend` 容器（`127.0.0.1:8000`）+ `/var/www/sgp`
3. **博客** —— 🟡 2026-09-28 首版上线：内容仓 `E:\Files\bobbychina-blog`（`content/posts/*.md` + 零依赖 `build.mjs`），产物 `/posts/`、`/feed.xml`、`/sitemap.xml` 已部署进 `/var/www/portal`；手机写作入口 = Pages CMS（`.pages.yml` 已配好，待授权安装 App）。**日记页默认不构建**（要发布得显式 `node build.mjs --with-diary`）——`bobbychina-diary` 是私有仓库，是否公开由站主决定。
   → **2026-09-28 晚追加（站主改需求）**：改为**站内写作台**（`/admin/`），登录后直接在站上写，不用碰 GitHub。存储 = 同一个 SQLite 库的 `blog_posts` 表（每日备份覆盖）；发布时容器内跑同一份 `build.mjs` 渲染到 `/opt/stockgame/blog-dist`，nginx 直出。详见 §13.10。**偏离了会上 C2「内容源在 git」**，补偿：库在备份范围内；git 镜像列为第二步（服务器代提交）。
4. **日记喂进博客**：`bobbychina-diary` 的 `diary.json` 作为内容源之一 → 构建出 `/diary/`（流程现成，零额外维护）
5. 恢复演练 + 安全 gate 核验（非 CF 直连拒绝 / 后台 401 / 上传 noexec）

---

## 14. 账号体系统一（identity 模块 · 2026-09-28 选型会 room-mulb1sui-3）

**融合前是两套并行账号**：
① 游戏厅（CF Worker KV）——客户端 PBKDF2 `verifier` + `salt` + 恢复码 + `wrap`，GitHub 绑定供私有 Gist 云存档，20 个 `/api/*` 端点；
② StockGame（NestJS + SQLite）——`users` 表（`username` 唯一 / `password`=bcrypt / `role` / `isActive`）+ 16 张业务表 + JWT，且 **AI 机器人 `bot_*` 与真人共用同一张 users 表**（迁移时必须区分）。

**目标**：邮箱为主身份，GitHub 只是 `identities` 表里一行（`provider=github` + `providerUid`）的**可选绑定**；站内一律走 `/api/auth/*`；不新增常驻容器、身份数据单一真源。

| 条款 | 内容 |
|---|---|
| C1–C2 | 邮箱为主路径；注册页默认**不出现** GitHub 按钮；任何"不绑 GitHub 就不能玩"的表述不得进入方案 |
| C3 | 现有 NestJS 进程内新增 identity 模块；`identities` / `credentials` / `sessions`（+ 令牌表，见模块 README 的**有意偏离**说明） |
| C4 | 口令一律**服务器侧 argon2id**；存量 PBKDF2 verifier **不平移**进新表 |
| C5 | 会话在服务端**只存哈希、可撤销**；TOTP secret 加密存；2FA 只做 TOTP + 一次性恢复码（不做短信/WebAuthn） |
| C6 | TOTP 强制范围：**GitHub 绑定账号与管理员强制，普通玩家自愿** |
| C7 | 未验证邮箱**不发会话、不占账号名**（pending + TTL 回收）；**但不阻断 C8 的存量认领**（否则无邮箱老账号被事实锁号） |
| C8 | 存量迁移：停机窗口一次性导入 + **旧库只读保留**；老账号首登**双入口认领**——旧口令一次性校验通过→立即换发 argon2id、旧 verifier 当场作废且永不入新表；邮件令牌作兜底 |
| C9 | 迁移前全量备份 + 可恢复校验（行数/抽样校验和/演练记录）；ID 映射表幂等可重跑；两条回滚开关（新旧登录入口切换 + 导入脚本回退） |
| C10 | 令牌：CSPRNG ≥128bit、**落库只存哈希**、TTL ≤30 分钟、绑定 identity+用途、**一次一废**、发放端点独立限流 |
| C11 | 邮件：**不自建 Postfix**；发信走专业服务（Resend 起步 / 量大转 SES），**发信子域 `em.bobbycn.cc`**，主域只收不发；收信走 Cloudflare Email Routing；**SPF/DKIM/DMARC 先上再发第一封**，DMARC 先 `p=none` 挂 rua |
| C12 | 发信治理：退信/投诉 webhook 落库，硬退信与日发送量达阈值告警、超限自动降级排队；**发信密钥只走环境变量**，不进仓库/CI 日志/备份产物 |
| C13 | 注册到能玩 **≤3 步**（邮箱+口令 → 点邮件链接 → 落地即登录），不再叠加第二个验证码 |
| C14 | 登录限流：**IP + 账号双维度**，失败递增延迟 + 短时锁定（别锁成对所有人的 DoS） |

**会后未决**（实施到对应阶段时必须先定）：GitHub 在注册页的呈现形式；旧口令认领窗口期限（建议 90 天）；既无有效邮箱、旧口令也不可用的孤账号如何处置；DMARC 收紧与切换 SES 的量化阈值。

**实施顺序**：`0` identity 骨架（表 + 令牌 + argon2id + 限流 + 单测）→ `1` 发信通道（DNS 三条 + Resend）→ `2` 迁移脚本与双入口认领 → `3` 客户端改造（游戏厅 `account.js`、StockGame 前端）。

### 14.1 骨架落地实录（2026-09-28）

- 代码：`backend/src/modules/identity/**`（10 个源码 + 4 个实体 + 5 个测试文件）+ `@node-rs/argon2@2.2.1`
- 验证：`npm run build` 退出 0；identity **4 suites / 32 用例** 全绿；全仓 **41 suites / 602 用例** 全绿（零回归）
- **端点位置：`/api/auth/identity/*`**（不是 `/api/auth/*`）。原因：既有 `AuthController` 占着 `POST /api/auth/register|login`，Express 先注册者胜出，同路径会让新模块"上线了但摸不到"。正式切换时才改回 `auth` 并摘掉老路由。
- 真机全链路（bobbycn.cc 经 CF，2026-09-28 22:09）：注册 200 不发会话 → 邮件令牌 **43 字符 base64url（256bit）** → verify 200 签发会话 → **同令牌二次使用 400** → 登录 200 → `/me` 200；库内 `sessions.tokenHash` / `identity_tokens.tokenHash` 均为 **64 位 hex**，明文不落库；测试身份已清理。
- 已知未做（照 C 条款登记）：GitHub OAuth 正式实现（501 占位）、TOTP 业务流程、迁移脚本、`pending` 后台回收（仅惰性 sweep）、会话续期/设备列表、多实例限流。
- **发信仍是 `LogMailer`**：验证链接只写容器日志，等站主提供 Resend key + DNS 记录后再切 `ResendMailer`（`RESEND_API_KEY` 一进环境变量就自动生效）。

### 14.2 全站登录态：域级 Cookie 会话（2026-09-28）

登录态要"整个站点"共用，但子域之间不共享 localStorage —— 所以会话做成**域级 Cookie**：

| 项 | 值 |
|---|---|
| Cookie | `sid=<明文会话令牌>`（服务端仍只存 sha256，见 C10） |
| 属性 | `Path=/; Domain=.bobbycn.cc; HttpOnly; SameSite=Lax; Secure`（`COOKIE_DOMAIN` 控制；本地/无域名时自动省掉 Domain/Secure） |
| 时长 | 跟随会话 `expiresAt`（默认 30 天）；登出即清 Cookie + 撤销服务端会话 |
| 兼容 | `Authorization: Bearer` 仍保留（脚本 / 移动端 / 写作台）；守卫 `extractSessionToken()` 先看 Bearer 再看 `sid` Cookie，手写解析不引 cookie-parser |
| 下发点 | `verify` 与 `login` 成功时 `Set-Cookie`；`logout` 清空 |
| 实测 | Set-Cookie 属性齐全；**只带 Cookie** 取 `/me` → 200；无凭据 → 401 |

- 前端：`/login/`（全站登录页）+ 首页右上角登录态（读 `/api/auth/identity/me`）。
- **尚未覆盖**：`game.bobbycn.cc`（NestJS 游戏站自己的 JWT）与游戏厅云后端（Cloudflare Worker 的 PBKDF2 账号）。要让"一个登录态走全站"真正成立，需游戏站 guard 接受 identity 会话、Worker 侧接受 identity 签发令牌（或按 §13 把云后端搬进 NestJS）。**这是账号统一的下一步，未做。**

### 14.3 站内写作台（/admin/）

| 项 | 实现 |
|---|---|
| 前端 | `/var/www/portal/admin/index.html`（源在 `bobbychina-pages/admin/`）：登录 → 列表 → 编辑 → 实时预览 → 保存即发布；零第三方脚本、零外联 |
| 后端 | `backend/src/modules/blog-admin/**`：`GET/POST/DELETE /api/admin/blog/posts`、`POST /api/admin/blog/rebuild`；`JwtAuthGuard` + **role=ADMIN 显式校验** |
| 存储 | 同一个 SQLite 库的 `blog_posts` 表（草稿/发布、slug 唯一）；**草稿保存不动线上产物** |
| 渲染 | 容器内跑 `/blog/build.mjs`（与本地构建同一份代码）→ 产物 `/opt/stockgame/blog-dist` → nginx 直出 `/posts/`、`/feed.xml`、`/sitemap.xml`、`/media/` |
| 登录 | 暂用既有管理员账号（`ADMIN_USERNAME` / `ADMIN_PASSWORD`，bcrypt+JWT）；identity 正式切换后同一路径自动升级 |
| 挂载 | `sgp-data:/app/data`、`/opt/stockgame/blog:/blog`、`/opt/stockgame/blog-dist:/blog-dist`（`volumes: !override` 显式列全） |

**上线验证（经 CF，2026-09-28 22:09）**：`/`、`/posts/`、文章页、`/feed.xml`、`/sitemap.xml`、`/admin/` 全 **200**；无凭据 `POST /api/admin/blog/posts` → **401**；`/api/auth/login` 与 `/api/user/profile` 确认打到本机 NestJS（不是游戏厅 Worker），游戏厅 `/api/health` 仍走 Worker。

### 14.4 Cloudflare Turnstile 人机验证（2026-09-28 上线并切成硬闸）

| 项 | 实现 |
|---|---|
| 前端 | `/register/`（`data-action="register"`）与 `/login/` 忘记口令框（`data-action="password-reset"`）各挂一个 widget，site key `0x4AAAAAAFG_gA9qpBv-0gsz`（公开值，写在页面里）；**失败后自动 `turnstile.reset()`**，重试不用刷新 |
| 后端 | `backend/src/modules/identity/turnstile.service.ts`：`POST challenges.cloudflare.com/turnstile/v0/siteverify`（`secret`/`response`/`remoteip`，5s 超时）→ 再核 **`action` 与 `hostname`**（纵深校验，防「别的站点/别的页面签出的 token」搬来复用） |
| 模式 | 生产 **`TURNSTILE_MODE=required`**（2026-09-28 23:1x 切换）：注册 / 忘记口令无 token 或校验失败一律 **400**；`off` 一键回退，`optional` 为过渡档 |
| 密钥 | `TURNSTILE_SECRET` 只存在服务器 `/opt/stockgame/backend/.env`（0600、非 git）；**代码里零密钥常量**，日志只记错误码不记 token/secret |
| 白名单 | `TURNSTILE_HOSTNAMES=bobbycn.cc,game.bobbycn.cc`；生产不得含 localhost |

**上线验收（全为线上实测，2026-09-28 22:5x–23:2x）**

1. 密钥有效性：真 secret + 假 token → `invalid-input-response`（**不是** `invalid-input-secret`）；对照 CF 官方测试密钥 → `success:true`（证明请求形状正确）。
2. 真浏览器（Thorium 有头，持久 profile）打开 `/register/`：widget 自解 → **752 字符真 token**，界面显示 `✅ 成功！`。
3. 真 token 提交 → `POST /api/auth/identity/register => 200`，服务端建 pending 身份并发出验证邮件（日志 23:07:13）。
4. **一次性语义**：同一 token 第二次提交 → **400「人机验证未通过」**。
5. 假 token 直连 API → **400**；切 `required` 后无 token 直连 → **400**（注册与忘记口令两处都拦）。
6. 切 `required` 后再跑真浏览器回归 → 仍然 **200**（硬闸不影响正常用户）。

**代价（明确登记）**：`required` 模式下 CF 侧超时/不可达会**拦住注册**（`optional` 会放行）。这是硬闸的固有取舍；CF 大故障时一条命令回退：`sudo sed -i 's/^TURNSTILE_MODE=required/TURNSTILE_MODE=optional/' /opt/stockgame/backend/.env && cd /opt/stockgame && sudo docker compose -f backend/docker/docker-compose.yml -f deploy/docker-compose.override.yml up -d`。

**探针身份自回收**：验收期间用过 `probe-*@example.com`（pending、未验证），30 分钟后由身份回收任务自动清理，无需手工删库。

### 14.5 Resend 真实发信（2026-09-29 上线）

| 项 | 内容 |
|---|---|
| 发信域名 | `em.bobbycn.cc`（Resend 侧 `verified`；区域 us-east-1，实测 CNAME 解析到东京 `rsend-apne1`） |
| DNS 记录 | `rsend.em` CNAME → `rsend-apne1.forge.rmta.net`；`send.em` CNAME → `send.forge.rmta.net`；`resend._domainkey.em` TXT → `p=MIGf…`（218 字符）；`_dmarc` TXT → `v=DMARC1; p=none;` |
| 发信人 | `MAIL_FROM=bobbycn.cc <no-reply@em.bobbycn.cc>`（带显示名，客户端里显示「bobbycn.cc」而不是一串地址） |
| 邮件品牌 | 主题与正文按**站点**写：`【bobbycn.cc】验证你的邮箱` / `【bobbycn.cc】重置密码`（2026-09-29 从 `【StockSim Pro】` 改过来——身份系统覆盖全站，不该只挂股票游戏的名字） |
| 发信日志 | `ResendMailerService` 成功时打 `[Resend] 已受理 id=… to=… subject=…`：投递有疑问拿 id 去 Resend 侧查，日志里始终不出现密钥 |
| 密钥 | `RESEND_API_KEY` 在服务器 `.env`（**Sending access 权限**：最小权限，代价是**不能用 API 建/查域名**，改域名配置要去面板） |
| 通道切换 | `identity.module.ts` 工厂：有 `RESEND_API_KEY` → `ResendMailerService`（直调 `POST api.resend.com/emails`，零 SDK 依赖），否则退回 `LogMailerService`；启动日志打 `邮件通道：Resend（RESEND_API_KEY 已配置）` |

**上线验收（线上实测，2026-09-29）**

1. 公网 DNS 独立核对（Cloudflare DoH，不看面板绿勾）：4 条记录全部生效，**DKIM 的 218 字符与面板给出值逐字符相等**（先比对再让 Resend 验，防"复制少一截"）。
2. 用 `no-reply@em.bobbycn.cc` 真发一封 → Resend 返回邮件 id、HTTP **200**（域名未验证会 403，故 200 即验证通过）。
3. 容器日志出现 `邮件通道：Resend`，`docker ps` = `Up (healthy)`。
4. 端到端：真实浏览器过 Turnstile → `POST /api/auth/identity/register` **200**，容器日志随即出现 `[Resend] 已受理 id=… subject=【bobbycn.cc】验证你的邮箱`（**注意**：`safeSend` 会吞掉发信异常只记 error 日志，所以接口 200 **不等于**信发出去了——要以容器日志里那条 `[Resend] 已受理` 为准）。
5. 前端旧文案（「当前尚未接入发信服务」）已删，`/register/` 改为「没收到先翻垃圾箱 / 广告邮件」——HTML 走 `no-cache`，无需跳 `?v=`。

**注意**：`_dmarc` 加在**主域** `bobbycn.cc` 上，是全域策略记录（`p=none` 只观察不拦截）。以后换发信服务别重复添加第二条同名 TXT。

**回滚**：`sudo sed -i '/^RESEND_API_KEY=/d' /opt/stockgame/backend/.env && cd /opt/stockgame && sudo docker compose -f backend/docker/docker-compose.yml -f deploy/docker-compose.override.yml up -d` → 邮件重新只进容器日志（`LogMailer`）。

### 14.6 站点图标（2026-09-29）

原本 `/favicon.ico` 是 404（浏览器控制台可见），标签页只有个默认地球。补齐一套：

| 文件 | 说明 |
|---|---|
| `/favicon.ico` | 32×32（PNG 塞进 ICO 容器），**兜住所有没写 icon 链接的页面**——包括博客 `/posts/**` 与各游戏子页，一处生效全站 |
| `/favicon.svg` | 矢量版，主页面（首页 / 登录 / 注册 / 验证邮箱 / 重置口令 / admin）显式 `<link rel="icon">` |
| `/apple-touch-icon.png` | 180×180，iOS 加到主屏用 |

设计沿用皮肤三色：深底 `#121110` + 衬线 `B`（`--ink #EAE5DD`）+ 朱砂点（`--seal #D4553F`）；生成脚本 `archive/sessions/2026-10/scripts/make-icons.ps1`（System.Drawing，改色改字号都在那）。
`games/` 与 `secret/` 页面另有内联 data-URI 图标（终端绿主色），属有意保留的分区视觉，未统一。

### 14.7 博客：浏览量 + 评论（2026-09-29）

| 项 | 实现 |
|---|---|
| 后端 | `backend/src/modules/blog-public/**`（读接口无鉴权；写要登录） |
| 表 | `blog_views`（slug 主键 + count）、`blog_comments`（uuid、slug 索引、identityId、author、body、status、ipHash）——TypeORM synchronize 自动建 |
| 接口 | `POST /api/blog/view`（计数，`(slug, ipHash)` 30 分钟去重）、`GET /api/blog/views?slugs=a,b`（列表页批量）、`GET /api/blog/comments?slug=`、`POST /api/blog/comments`（**必须登录** + Turnstile 软校验） |
| 审核 | `GET /api/admin/blog/comments`、`POST /api/admin/blog/comments/:id/status`、`DELETE /api/admin/blog/comments/:id`（JwtAuthGuard + ADMIN；**后台 UI 尚未接**，目前用接口调） |
| 前端 | `/assets/blog.js?v=…`（约 9KB）：文章页计数 + 目录 + 评论区；列表页批量填 `[data-pv]`。评论一律 `textContent` 渲染（后端存原文、不转义） |
| 隐私 | 不落原始 IP（只存 sha256 前 32 位用于限流）；默认昵称 = 用户名，没用户名则邮箱前缀打码（`cmt***st`） |

**为什么评论要登录**：本站已有统一身份（邮箱验证 + 域级会话），复用同一套就是零额外成本的最强反垃圾；匿名评论得另建一套对抗体系，不划算。

**Turnstile 用「软校验」**（`assertHumanOptional`）：登录已是硬门槛，Turnstile 带 token 就必须过、没带也放行——避免 CF 抖动把评论区一起锁死。注册 / 忘记口令仍是硬闸（`required`）。

**nginx 必配**：`location ^~ /api/blog/` 反代到本机 Nest，否则会打到游戏厅 Worker，症状是 401「没登录或会话过期」（2026-09-29 踩过）。

### 14.8 版式加宽 + 全局去 BETA 条（2026-09-29）

- **`.wrap` 容器 760 → 1120px**（站主："空间利用率过低"）。宽屏下文章页是**两栏**：正文 `minmax(0,760px)` + 侧栏 248px（目录 / 全部文章 / 回到顶部），`justify-content:center`；<1000px 自动回到单栏。实测 1440 视口：容器 1120、正文列 760、侧栏 248。
- **正文行长与容器解耦**：`p,blockquote,article li{max-width:78ch}`——容器变宽是为了利用率，段落仍保持可读行长（避免「一行 100+ 字符」）。实测首页段落宽 672px。
- 改 `site.css` 必须**跳版本号**：全站页面与博客模板统一到 `?v=20260929a`（见坑 17）。
- **BETA 警示条全局移除**：`games/index.html`、`oauth-callback.html`、`dreamcore/`、`vampire-survivors/` 删掉 `<script src="/beta-notice.js">`；`zombie-survival`（打包产物、源码在另一条流水线）用一条 `html{--beta-h:0px!important} #beta-notice{display:none!important}` 压制（`--beta-h` **必须** `!important`，否则盖不过脚本写的行内样式）。`beta-notice.js` 文件保留（`tools/edge-block-check.ps1` 还在探它），但已无人引用。
- **博客页必须 `no-cache`**：`/posts/` 原先没有 Cache-Control，浏览器启发式缓存会一直渲染旧 HTML——站主反馈「博客依然没有 icon」的根因就是它（产物里早有 `<link rel="icon">`，浏览器看的是缓存副本）。已在 `blog.conf` 的 `/posts/` 补 `add_header Cache-Control "no-cache" always;`。

### 14.9 游戏厅账号并入站点身份（2026-09-29）

站主看到游戏厅页面同时出现"站点账号已登录"和"注册 / 登录"两套入口，问「两个账号系统？？」。**为什么不能简单让 Worker 认站点 JWT**：游戏云存档是**浏览器侧加密**的（密钥由游戏厅口令派生），恢复码、GitHub Gist 备份、两个游戏的打包产物全建立在这条链上；只给 Worker 一个 JWT，客户端手里没有那把口令，云端老存档当场解不开（zombie-survival 的存档代码还是压缩包，改不动）。所以走**凭据派生**：

| 环节 | 实现 |
|---|---|
| 派生 | `GET /api/games/arcade`（SessionAuthGuard）= `{name, password, auto, autoName}`；`password = base64url(HMAC-SHA256(key, identityId))` |
| 密钥 | `app_secrets: arcade.derive`（**存库**，随每日备份走）。为什么不放 `/keys`：那是容器**只读挂载**，写不进去；写不进去就只能退回进程内随机键 → 重启后派生口令变化 → 已自动开的号被锁在门外（实测踩过） |
| 自动开号 | 身份首次进游戏厅 → 名字 `u_<sha256(identityId)[0:8]>`，客户端用派生口令走**原有的** `/api/register` |
| 自动登录 | `account.js` 新增 `signInSite()`：站点身份在且游戏厅没登录时静默登录（失败不打扰，照常显示登录入口） |
| 并入老账号 | `linkExisting(name, password)`：旧口令登录 → `changePassword` 换成派生口令 → `POST /api/games/arcade/link` 记下绑定。老存档 / 榜单 / Gist 全保留（账号没变，只是换了把钥匙） |
| 前端 | 账号条：站点身份在、游戏厅没登录 → 「站点账号 X 已登录；游戏厅云存档要另登一个」+「登录游戏厅账号」；已自动接通 → 徽标加一枚**「站点账号已接通」**（`u_xxx` 这名字本身看不出是什么）。登录面板里多一条「有旧的游戏厅账号？**并进站点账号**」 |
| nginx | `location ^~ /api/games/` 打本机 Nest（与 `/api/blog/` 同理） |

**线上验收（2026-09-29）**：接口 200/401、派生口令**跨容器重启完全一致**（真实 restart 验证）、库里 `arcade.derive` 长度 64 hex；浏览器实测（真登录站点身份 → 重载游戏厅）账号条变成「已登录 u_26c0adcb」+「站点账号已接通」，无需第二次登录。

**坑**：`games/account.js` 也得跳 `?v=`（坑 17 的老毛病）——只 bump `site.js` 忘了它，浏览器拿的是 4 小时缓存的旧文件，症状是 `A.signInSite is not a function`、账号条永远停在"正在读账号状态…"。

### 14.10 评论机器人审核 + 写作台零口令（2026-09-29）

**机器人审核**（站主："添加一个机器人审核评论，禁止 dddd 那些违规内容" + "不要让我自己审核，我懒"）：
`blog-moderation.service.ts`，规则引擎（不调大模型：低价值高频输入、可解释、不加外部依赖），**只有两档结论、没有人审队列**：

| 拦下（400，附可读理由） | 放行 |
|---|---|
| 纯灌水（整条只有 `d/顶/1/6/哈/啊/。` 之类）、单字符连打 ≥6、字符重复度 <25%、违禁词（加微信/代刷/博彩/色情…）、只有符号表情、一次 ≥3 个外链、全大写英文长串、长度 <2 | 其余一切，**包括带 1~2 个链接的**（链接渲染成纯文本、点不了也没 SEO 收益，误杀正常读者更亏） |

`赌博` 故意不在违禁词里（正常讨论游戏机制会用到）。另有既有的两道网：评论必须登录（邮箱验证过的身份）、同身份 20 秒 1 条 / 同 IP 每小时 12 条。后台仍可手动 hide/delete（`/api/admin/blog/comments`）。
实测：`dddd`/`顶顶顶顶`/`1111111111`/`哈哈哈哈`/`加微信…`/3 外链 → **400**；正常中文 → **200**。

**写作台零口令**（站主："我如何写博客"）：`BlogAdminGuard` 让**站点身份优先**——登录站点账号后打开 `/admin/` 直接进编辑器，不用再记 `ADMIN_USERNAME/ADMIN_PASSWORD`（旧 JWT 通道保留给脚本）。站主判据：`ADMIN_EMAILS`（可选）命中，或**最早注册且已验证的身份**（个人站，第一次注册的就是本人；判定缓存 60 秒）。实测：匿名 401、非站主身份 401、库里的最早身份 = 站主本人。

**踩坑**：新 service 忘了加进 `providers` → Nest 启动直接崩、容器 `Restarting`、全站 502。症状是日志里 `Nest can't resolve dependencies of ... (?,)`；改完 module 一定要重启容器看 `healthy`，别只看 `npm run build` 通过。

### 14.11 站内发信（写作台里的「✉ 发信」）（2026-09-30）

需求链：站主要"以 `contact@bobbycn.cc` 回信" → Cloudflare **Email Routing 只收不发** → 新版 QQ 邮箱把"自定义域发信"做成了**付费会员**功能（免费的「其他邮箱」入口已下线）→ 所以直接在站上做一个发信页。

| 项 | 实现 |
|---|---|
| 后端 | `backend/src/modules/webmail/**`：`GET /api/admin/mail/config`、`POST /api/admin/mail/send`（走 Resend API，From = `WEBMAIL_FROM`，默认 `contact@bobbycn.cc`） |
| 鉴权 | 复用 `BlogAdminGuard`（站点身份=站主 或 写作台管理员 JWT）——**必须在 BlogAdminModule 里把 guard 和它注入的 JwtAuthGuard 都 export**，且 WebmailModule 要自己 import IdentityModule |
| 前端 | **并入写作台**（站主要求"只记一个页面"）：`/admin/` 右上角「✉ 发信」，`#mailView` 与文章编辑器互斥切换；`/mail/` 只留一个跳转到 `/admin/` 的页面（旧书签不失效） |
| nginx | `location ^~ /api/admin/mail/` 打本机 Nest（漏了就会命中门户的 `/api/` 中继 → Worker 401） |
| 接收侧 | CF Email Routing：`contact@bobbycn.cc → bobby_minecraft@qq.com`（destination 必须 Verified，否则 CF 在 SMTP 层直接拒，Resend 侧记 `bounced`，之后还会把该地址拉进**抑制名单**继续 `suppressed`） |

**线上验收**：`/admin/` 200 且点「✉ 发信」切换正常（浏览器实测：点击后 mailView 显示、editView 隐藏）；匿名调接口 401；管理员令牌 → config 显示 `Bobby · bobbycn.cc <contact@bobbycn.cc>`；**真发一封到站主 QQ 成功**（`{"ok":true,"id":"01a0f12b-…"}`）；非法收件人 400。

**踩坑（本轮两次 502 都是它）**：跨模块复用 guard 时，Nest 在**导入方模块的上下文**里实例化它 —— 需要 `exports` 里有 guard 本身、它注入的依赖（JwtAuthGuard）、以及那些依赖的来源模块（IdentityModule）。少一个就是启动期 `Nest can't resolve dependencies` + 容器 `Restarting`。

### 13.8 个人主页站迁移实录（2026-09-28）

来源仓库 `bobbychina-pages`（原 GitHub Pages 主站），落点 **`/var/www/portal`**（62 个文件 / 3.0MB）。
打包时排除 `functions/`、`tools/`、`.git`、`.wrangler`、`.probe` —— 它们是 Pages 运行时与本地工具，不属于静态产物。

**原 Cloudflare Pages Functions 的两块服务端逻辑已在 nginx 复刻**（`deploy/nginx/portal.conf`）：

| 原实现 | 现在 | 说明 |
|---|---|---|
| `functions/[[path]].js` 的 `/api/*` 分支 | `location /api/` → `proxy_pass $api_up$request_uri` | 上游仍是那台 Worker；**将来把云后端搬进本机 NestJS，只需把 `$api_up` 换成 `http://127.0.0.1:8000`** |
| 同文件的 `ALLOW` 表（OAuth 两条） | `location = /oauth/access_token`、`= /login/device/code` → github.com | 只允许 POST；OPTIONS 204、其余 405（与函数一致） |
| 同文件的 `ALLOW_ORIGINS` | `map $http_origin $origin_ok`（`deploy/nginx/site-maps.conf`） | 白名单外 403；Origin 缺失（curl 自测）放行 |
| `functions/_middleware.js`（macOS 403） | `map` 判定 + `if ($block_mac) { return 403; }` + `error_page` → `/.deny/mac-403.html` | 2026-10-10 已在部署源配置与主站生产环境关闭平台拦截，所有平台放行；已备份旧配置，`nginx -t` 与 reload 通过。 |

**客户端配置改动**（`bobbychina-pages/games/auth-config.js`）：`relay` 由 `bobbychina-games.pages.dev` → `https://bobbycn.cc`；`redirect` → `https://bobbycn.cc/games/oauth-callback.html`。
⚠️ **GitHub OAuth App 的 Authorization callback URL 要同步改成新域名**，否则授权码流程回不来（设备码流程不受影响）。

**镜像关系**：GitHub Pages 端只做静态镜像（同一份文件）；主站 = 本机 nginx，云能力 = 经 `/api` 中继。

安装文件（`deploy/nginx/`）：`portal.conf`、`site-maps.conf`（装到 `/etc/nginx/conf.d/00-site-maps.conf`）、`mac-403.html`（装到 `/var/www/portal/.deny/`）。

