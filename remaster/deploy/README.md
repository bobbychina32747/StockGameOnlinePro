> 2026-10-11：测试引擎已留档，正式部署使用 [unified-compose.yml](unified-compose.yml)。`/remaster/` 转到统一入口。以下保留原测试部署记录，不再启动为第二个正式账本。

# 重制版测试部署

入口：**https://game.bobbycn.cc/remaster/**。这是独立沙盒测试，所有资金均为模拟资金。旧站仍使用原后端与原数据库。重制版复用现有站点身份服务，独立保存每区角色；不替换旧站后端。

2026-10-10 公网验收：HTTPS 健康检查、沙盒登录、138 支股票 / 23 行业、206 根测试标的日线、10 股市价成交、同键重复请求返回原订单、实际 WebSocket 快照、390px 手机布局和 `/remaster/` Service Worker 均通过；浏览器未捕获脚本异常。

## 2026-10-10 第二次试玩更新

注册选择固定区服，每区 138 支股票，总计 414 支；行情刷新保留缩放，交易页固定在视口内。目录升级以事务补充新股票，保留已有现金、持仓和订单数据；升级前的 SQLite 备份为测试卷内 `/app/data/pre-realms-20261010.sqlite`，不导出到本机或仓库。

分钟历史升级为 SQLite 归档，热状态保留 120 根；旧分钟历史在同一事务中完整保留。基础目录每区 138 支，已有 IPO 另计，升级不删除旧新股。

## 构建与启动

Docker Compose 从独立 `package-lock.json` 安装依赖，在 Node.js 22 Alpine 中构建。服务以非 root 用户运行，宿主端口只绑定 `127.0.0.1:8320`，持久化数据位于独立 Docker 卷 `sgp-remaster-test_remaster-test-data`。

```bash
cd /opt/stockgame/remaster-test-20261010
docker compose -p sgp-remaster-test -f deploy/compose.yml up -d --build
curl --fail http://127.0.0.1:8320/api/v2/health
docker ps --filter name=sgp-remaster-test
```

宿主 Nginx 在 `game.bobbycn.cc` 的 HTTPS server 块中包含 `nginx-locations.conf`；该文件将 `/remaster/` 转发到独立服务并去掉前缀。`nginx-rate.conf` 放入 `conf.d/` 定义限流区域。变更前备份 game 配置，先执行 `nginx -t`，成功后 reload。

页面构建参数 `REMASTER_WEB_BASE=/remaster/` 会同步接口、Socket.IO、图标、安装清单和 Service Worker；离线缓存只作用于此路径。API 仅接受指定来源，沙盒 cookie 为 HttpOnly、Secure、SameSite=Strict，路径限定为 `/remaster/`。测试入口限制单 IP 请求频率并标注禁止索引。

## 运行边界

- `NODE_ENV=test` 与 `REMASTER_SANDBOX=true` 表示加速模拟行情；`REMASTER_AUTH_MODE=site` 表示使用真实站点身份。沙盒在 `NODE_ENV=production` 下拒绝启动。
- 站点角色绑定与资产保存在独立 SQLite 中，每个身份每区最多一个角色。游戏短时会话分区保存 HttpOnly Cookie，刷新与重登恢复同一角色；退出一个角色不撤销站点登录和其他区角色。
- 引擎每 2 秒推进一个模拟交易分钟，交易日可以加速跨过；启动后运行固定种子的模拟世界。
- 独立容器加入现有 `docker_default` 网络，仅调用统一身份服务的 token / me / JWKS / introspect 接口；旧后端和旧数据库不迁移。
- `REMASTER_HOST` 支持回环或容器绑定；`REMASTER_ALLOWED_ORIGINS` 用逗号分隔精确的可信来源。默认本地配置仅允许回环来源。

## 回退

先从 game 的 HTTPS server 块移除测试路径 include，再 `nginx -t && systemctl reload nginx`；随后执行下列命令停止测试容器。**不加 `-v`**，保留测试数据卷。旧站一直使用旧服务，因此不需要恢复旧版玩家数据库。

```bash
docker compose -p sgp-remaster-test -f deploy/compose.yml down
```

Nginx 的部署前备份保存为 `/etc/nginx/conf.d/game.conf.bak.remaster-20261010`。其他部署若已修改该配置，应只移除测试 include，避免覆盖新配置。
