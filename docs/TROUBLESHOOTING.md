# 排气手册（TROUBLESHOOTING）

这里记的全是**搭建测试环境时真实踩过的坑**，不是凭空设想的清单。症状 → 真因 → 处置，
按症状查即可。

---

## 1. 容器一直 `Restarting`，日志报 `TICK_INTERVAL_MS=1000 < 60000 为沙盒高速回放…`

**真因**：应用有硬校验 —— `TICK_INTERVAL_MS < 60000` 必须同时显式设 `SANDBOX_FAST=true`，
否则构造 `MarketService` 时直接抛错退出（Nest 启动期就挂，所以表现为反复重启）。

**处置**：测试环境应当复现真实行情节奏，用 `60000`：

```bash
ssh -i keys/id_ed25519 ubuntu@43.133.165.97 \
  "sudo sed -i 's/^TICK_INTERVAL_MS=.*/TICK_INTERVAL_MS=60000/' /opt/stockgame/staging/prod.env && \
   cd /opt/stockgame/staging && sudo docker compose up -d"
```

> 改 `.env`/`prod.env` **必须重建容器**：环境变量在容器创建时固定，`docker restart` 不重读。

---

## 2. 容器"起来了"、接口也 200，但数据是空的（`users` 只剩 1 个）

**真因**：compose 用了**命名卷**（`sgp-staging-data:/app/data`），而快照是用
`sqlite3 .backup` 写到宿主目录 `/opt/stockgame/staging/data/` 的。容器读的是另一个空卷，
应用发现没库就自建表结构 → 看着"跑起来了"，其实数据一条没进来（那 1 个用户是应用自建的管理员）。

**处置**：数据库必须**绑定挂载**宿主机目录：

```yaml
volumes:
  - /opt/stockgame/staging/data:/app/data      # ✅ 绑定挂载
  # - sgp-staging-data:/app/data               # ❌ 命名卷：读不到快照
```

**怎么确认修对了**（宿主与容器必须是同一个 inode）：

```bash
ssh -i keys/id_ed25519 ubuntu@43.133.165.97 \
  "stat -c '%i %s' /opt/stockgame/staging/data/stockgame.db; \
   sudo docker exec sgp-backend-staging stat -c '%i %s' /app/data/stockgame.db"
# 两行数字必须完全相同
```

---

## 3. 脚本里 `[ -f "$路径/stockgame.db" ]` 判断不出文件，误报"线上没有库"

**真因**：`/var/lib/docker/volumes/...` 是 **root 权限**（`drwx------`），
非 root 用户连目录都进不去，`test -f` 自然为假 —— 但脚本却按"文件不存在"继续往下走，
还打印了误导性的"线上没有库（会自动建空库）"，把排查方向带偏。

**处置**：涉及 docker 卷的判断**一律加 sudo**：

```bash
sudo test -f "$VOL/stockgame.db"      # ✅
```

**附带坑**：幂等判据不要用 `-f`，要用 `-s`（存在**且非空**）。
上一次失败留下的 0 字节空壳会被 `-f` 判成"已就绪"，于是空库被当成快照用了。

---

## 4. 快照可能损坏 / 库里有 20MB WAL

**真因**：线上容器一直在写（tick 循环），`stockgame.db` 旁边有 `-wal` 与 `-shm`。
直接 `cp` 主库文件可能拿到损坏或不完整的页。

**处置**：用 SQLite 自己的备份命令，它会处理 WAL：

```bash
sudo sqlite3 "$线上库" ".backup /tmp/snapshot.db"
sqlite3 /tmp/snapshot.db "PRAGMA quick_check;"     # 必须返回 ok
```

`PRAGMA quick_check` 与"表数量/关键表行数"是这套流程的验收标准，别只看文件大小。

---

## 5. `nginx: [emerg] unknown directive "http2"`

**真因**：这台机是 **nginx 1.24**，而 `http2 on;` 是 nginx 1.25.1+ 才有的独立指令。

**处置**：用旧形式 ——

```nginx
listen 443 ssl http2;      # ✅ 1.24 可用
# http2 on;                # ❌ 1.25.1+
```

改完必须 `sudo nginx -t` 再 `sudo systemctl reload nginx`；`nginx -t` 不过就不要 reload。

---

## 6. `rsync` 之后服务器上的 `.env` 被覆盖，容器起不来

**真因**：`/opt/stockgame/backend/.env` 就躺在**源码树根目录**。
同步源码时不排除它，本地的 `.env`（或不同内容）就会盖掉服务器上的密钥文件。
服务器上留着的 `.env.bak.2026*`、`.env.clobbered.20260929-030229` 就是历史证据。

**处置**：同步必须排除（`scripts/deploy-backend.sh` 已内置）：

```
--exclude '.env' --exclude '.env.*' --exclude data --exclude node_modules --exclude dist
```

**如果已经被覆盖**：容器日志会报环境变量缺失/鉴权失败。
从备份恢复：`sudo cp /opt/stockgame/backend/.env.bak.<最新> /opt/stockgame/backend/.env`，
然后 `docker compose up -d`（重建，不是 restart）。恢复后**务必核对 `users` 行数没变**。

---

## 7. 页面出来了但样式/脚本是旧的

**真因**：Cloudflare 会按扩展名缓存静态文件（实测 `.js` 被 HIT 4 小时）。

**处置**：仓库里 `index.html` 引用 `/assets/site.css?v=<日期>` 这类带版本号的 URL，
改了文件就把 `?v=` 改掉（这会强制 CF 重新取）。`/i18n/*.js` 另给了 1 小时缓存。

另外 **HTML 一律 `no-cache`**（nginx 配置里已设），所以刷新就能拿到新 HTML。

---

## 8. 前端传上去了但接口 404/401

**排查顺序**：

1. 确认测试后端活着：`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8001/api/market/prices`
   （在服务器上执行；从本机访问 8001 是不通的，它只监听回环）
2. 确认 nginx 把 `/api/` 打到了 **8001** 而不是 8000 —— `/etc/nginx/conf.d/30-staging.conf`
   里 `proxy_pass http://127.0.0.1:8001;`。**写成 8000 就会打到线上后端**（症状是：数据看着正常，
   但其实是线上的数据，你改的东西完全没生效）。
3. 确认前端产物确实是新的：抓 `assets/index-<hash>.js` 的文件名，跟本地 `dist/` 对一下。

**这条最危险**：测试环境误连线上后端的症状是"一切正常"，而不是报错。

---

## 9. 测试环境彻底坏了，想从零重建

见 `docs/STAGING-REBUILD.md`。核心思路：测试环境的一切都可重建 ——
容器来自源码、库来自线上快照、前端来自构建产物。**弄坏了不用慌，也不用找站主修。**

---

## 10. ★ SSH 连不上：按这个顺序查，别跳步（2026-10-07 一次连环故障的完整教训）

那天所有外部客户端（站主、合作者、手机热点三个不同网络）一律 `Connection refused`，
而服务器控制台里一切正常。排查走了两次弯路，**真因是 sshd 只监听了 IPv6**。

**正确的排查顺序（从下往上，最快的先做）：**

```bash
# ① 先看有没有 IPv4 监听者 —— 这一步应该在查任何防火墙之前做
sudo ss -4 -ltnp | grep ':22'          # 空 = 没有 IPv4 监听者 → 后面都不用查了
sudo ss -ltnp  | grep ':22'            # 显示 [::]:22 = 只绑 IPv6；显示 *:22 = 双栈

# ② 服务器内部自测（绕开安全组/运营商，直接暴露服务本身）
ssh -o StrictHostKeyChecking=no ubuntu@127.0.0.1 "echo IPV4_OK"
#    refused → 服务没在 IPv4 上监听（回 ①）
#    Permission denied (publickey) → 握手是通的，只是这把钥匙没装（正常现象，别误判）

# ③ 才轮到查防火墙/封禁
sudo ufw status | grep 22
sudo fail2ban-client status sshd
sudo iptables -L INPUT -n --line-numbers | head -20
```

**真因与修法**：`ssh.socket` 的单位里 `BindIPv6Only=ipv6-only`（这是它的默认值之一），
导致 socket 只绑 IPv6。修法是覆盖成双栈：

```bash
# /etc/systemd/system/ssh.socket.d/*.conf 里加一行
[Socket]
BindIPv6Only=both
ListenStream=
ListenStream=22
```

**症状为什么反直觉**：`ss` 看起来在监听（`[::]:22`）、控制台内部能操作、
只有外部 IPv4 客户端被内核回 RST。任何正常的排查思路（查防火墙 → 查 fail2ban →
查云安全组 → 查运营商）都会一路查错方向。

## 11. ★ 改 sshd 时把自己锁在外面（socket 激活的重启顺序陷阱）

**症状**：`sudo systemctl restart ssh.socket` 之后，22 端口变成
`No connection could be made because the target machine actively refused it`，
但 `ss` 显示端口在监听。

**真因**：这台机用**socket 激活**（`ssh.socket` enabled + active，`Accept=no`）。
只重启 socket 而不重启 service 时，systemd 认为 `ssh.service` 仍在运行，
于是新连接没有监听者接。

**正确顺序（务必记住）**：

```bash
sudo systemctl stop ssh.service
sudo systemctl restart ssh.socket
sleep 2
sudo systemctl start ssh.service
```

**改之前的硬检查项**（做远程访问配置前必须确认，否则等于蒙眼拆炸弹）：
`systemctl is-enabled ssh.socket` —— 若为 enabled，就是 socket 激活模式，
`sshd_config` 里的 `Port` **不生效**，端口由 socket 的 `ListenStream` 决定。

## 12. ★ 腾讯云有三层防火墙，安全组只是其中一层

排查"端口不通"时，这台机器上有三层，顺序从上到下：

| 层 | 在哪看 | 症状 |
|---|---|---|
| **1. 腾讯云安全组** | 控制台 → 防火墙/安全组 | 端口**超时**（包被丢） |
| **2. 腾讯云主机安全/防暴破** | 控制台 → 主机安全（独立于安全组） | 可能直接封源 IP，控制台看不到 |
| **3. 系统内 ufw / iptables** | `ufw status` / `iptables -L` | 通常表现为 refused 或 drop |

**关键区分**：`timeout` 多半是上层（安全组/运营商）丢包；**`refused` 是服务器主动发的 RST**，
说明包已经到达服务器，问题在服务本身或系统内规则。

**教训**：那天我改了 ufw（第 3 层）就以为放行了端口，实际安全组（第 1 层）没开；
后来安全组开了，又因为 IPv4 没监听（见 §10）而依然 `refused`。
**三层都要过，任何一层没配都表现为"连不上"，而三层的行为各不相同。**

## 13. 高频 SSH 连接会触发平台保护（也会连累别人）

一天之内对这台机开了 100+ 次 SSH 连接（每条命令一个新连接），
可能触发腾讯云的主机安全保护，表现为"自己突然连不上、而别人正常"。

**怎么做**：
- 部署脚本用**单条连接内跑完整个流程**，不要"一条命令一次 ssh"
- 失败时不要连续重试（那正是触发保护的行为），等几十秒再试一次
- 参考 `partner-kit/scripts/` 里的写法：`ssh ... 'bash -s' < 脚本文件`

## 14. 我需要做的事超出了这份包

- 改线上 nginx / 开端口 / 动防火墙 → 找站主
- 新增子域名、证书、服务 → 找站主
- 线上出 bug 且不是你引入的 → 记 issue，**不要直接改线上**
- 需要更多服务器权限（比如跑一个常驻进程）→ 找站主评估，不要自己开
