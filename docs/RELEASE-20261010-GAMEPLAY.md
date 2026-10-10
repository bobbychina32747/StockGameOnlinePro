# 2026-10-10 玩法修复生产发布

- 用户已明确同意生产发布及备份、数据库升级、后端重启和代码回退。
- 目标：`https://game.bobbycn.cc`，容器 `sgp-backend`。
- 发布目录：服务器 `/opt/stockgame/releases/gameplay-20261010-125246`。
- 新镜像：`sgp-gameplay:20261010-125246`。
- 旧镜像保留为 `sgp-gameplay-rollback:20261010-125246`。
- 发布覆盖文件 `new-image.yml` 设置 `DB_SYNCHRONIZE=false`，数据库由迁移脚本显式升级。

迁移新增 `positions.boughtDay`、`fund_navs.settledDay`、`fund_navs.basketPrices`。停写后生成 SQLite 一致性备份 `/app/data/stockgame.db.before-gameplay-fix.sqlite`；原库及备份均通过 `quick_check`，迁移前后账号和持仓数量一致。

第一次发布因 HTTP 自动跳转 HTTPS 导致页面校验失败，已自动回退到健康旧版本。改用本机 HTTPS 校验后第二次发布成功，数据库升级未重复执行。

公网验证：17 个前端文件 SHA-256 与本地发布产物一致，行情、基金及身份公钥接口均返回正常 JSON，新基金名称已生效。旧前端资源保留，避免已打开页面加载旧分块失败。

## 回退

服务器执行 `bash /opt/stockgame/releases/gameplay-20261010-125246/rollback-code.sh` 可恢复旧镜像及前端，并检查后端健康状态。该脚本保留当前数据库及新增列，避免丢失上线后的玩家操作；不自动恢复数据库备份。

备份源码和前端分别为发布目录中的 `backend-before.tar.gz`、`frontend-before.tar.gz`。后续部署应保留显式数据库迁移流程，当前生产启动采用基础 compose、生产覆盖文件及本次 `new-image.yml`。
