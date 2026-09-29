#!/usr/bin/env bash
# SQLite(WAL) 安全备份 —— WAL 模式下 cp 数据库会拿到不一致快照，必须走 sqlite3 .backup
#
# 用法：sudo bash backup-sqlite.sh            # 手动跑
#      crontab: 20 4 * * *  /opt/stockgame/deploy/scripts/backup-sqlite.sh >> /var/log/sgp-backup.log 2>&1
#
# 2026-09-28 修订：
#   · 卷路径不再写死 /var/lib/docker/volumes/sgp-data/...（compose 项目名前缀会让它变成 docker_sgp-data），
#     改用 `docker volume inspect` 解析挂载点，找不到就报错退出，绝不静默备份到别处。
#   · 失败落 /opt/backups/LAST-FAILURE.txt（cron 没 MTA，靠标记文件 + 日志排障）。
#   · 媒体目录（若有 /opt/stockgame/media）一起打 tar —— 博客配图走 git，不进这里。
set -uo pipefail

DEST="${DEST:-/opt/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date '+%F %T')"

fail() { echo "$STAMP [FAIL] $*"; echo "$STAMP $*" > "$DEST/LAST-FAILURE.txt" 2>/dev/null; exit 1; }
mkdir -p "$DEST"
rm -f "$DEST/LAST-FAILURE.txt"

# ── 定位数据库 ──
DB="${DB:-}"
[ -z "$DB" ] && [ -f /opt/stockgame/backend/data/stockgame.db ] && DB=/opt/stockgame/backend/data/stockgame.db
if [ -z "$DB" ] && command -v docker >/dev/null 2>&1; then
  for v in $(docker volume ls -q 2>/dev/null | grep -E 'sgp-data$' || true); do
    p="$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null || true)"
    if [ -n "$p" ] && [ -f "$p/stockgame.db" ]; then DB="$p/stockgame.db"; VOL="$v"; break; fi
  done
fi
[ -n "$DB" ] && [ -f "$DB" ] || fail "找不到 stockgame.db（可用 DB=/path/to/stockgame.db 指定）"
command -v sqlite3 >/dev/null || fail "缺 sqlite3：apt-get install -y sqlite3"

OUT="$DEST/stockgame-$(date +%F-%H%M).db"

# ── 1. 数据库：.backup 读一致性快照，服务运行中也安全 ──
sqlite3 "$DB" ".backup '$OUT'" || fail "sqlite3 .backup 失败"
gzip -f "$OUT" || fail "gzip 失败"
DB_SIZE="$(du -h "$DB" | cut -f1)"

# ── 2. 媒体（用户上传/生成物；博客配图不在此列，走 git）──
MEDIA_TAR=""
if [ -d /opt/stockgame/media ]; then
  MEDIA_TAR="$DEST/media-$(date +%F-%H%M).tar.gz"
  tar -czf "$MEDIA_TAR" -C /opt/stockgame media || fail "媒体打包失败"
fi

# ── 3. 保留策略 ──
find "$DEST" -name 'stockgame-*.db.gz' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -name 'media-*.tar.gz'    -mtime +"$KEEP_DAYS" -delete

echo "$STAMP [OK] 备份完成：$OUT.gz（源库 $DB_SIZE，卷 ${VOL:-bind}）${MEDIA_TAR:+；媒体 $MEDIA_TAR}"

# ── 4. 异地（§13.5 gate：服务器不存唯一副本）──
# 目标待定，二选一（装上对应工具后取消注释即可）：
#   · Cloudflare R2 / S3 兼容：rclone copy "$OUT.gz" r2:sgp-backup/
#   · 腾讯云 COS：ossutil cp "$OUT.gz" oss://<bucket>/sgp-backup/ -f
# 现在至少做到：把「最后成功备份时间」写出来，供外部探针核对是否按时备份。
date '+%F %T' > "$DEST/LAST-SUCCESS.txt"
