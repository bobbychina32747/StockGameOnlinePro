#!/usr/bin/env bash
# SQLite(WAL) 安全备份：WAL 模式下直接 cp 数据库会拿到不一致快照，必须走 sqlite3 .backup
# 用法：sudo DB_AUTO=1 bash backup-sqlite.sh
# crontab：20 4 * * *  /opt/stockgame/deploy/scripts/backup-sqlite.sh >> /var/log/sgp-backup.log 2>&1
set -euo pipefail

DEST="${DEST:-/opt/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

# 自动定位数据库：优先 bind mount 路径，其次 docker 卷路径
DB="${DB:-}"
if [ -z "$DB" ]; then
  for c in /opt/stockgame/backend/data/stockgame.db \
           /var/lib/docker/volumes/sgp-data/_data/stockgame.db; do
    [ -f "$c" ] && DB="$c" && break
  done
fi
[ -n "$DB" ] && [ -f "$DB" ] || { echo "找不到 stockgame.db，请用 DB=/path/to/stockgame.db 指定"; exit 1; }

command -v sqlite3 >/dev/null || { echo "缺 sqlite3：apt-get install -y sqlite3"; exit 1; }

mkdir -p "$DEST"
OUT="$DEST/stockgame-$(date +%F-%H%M).db"

# .backup 会读一致性快照并自动处理 WAL，服务运行中也安全
sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"

# 备份前顺手回收 WAL（可选，长跑后 wal 文件会涨）
# sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);"

# 只留最近 KEEP_DAYS 天
find "$DEST" -name 'stockgame-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T') 备份完成：$OUT.gz  源库 $(du -h "$DB" | cut -f1)"

# ── 可选：上传到 OSS（异地容灾，强烈建议至少保留一份站外备份）──
# ossutil cp "$OUT.gz" oss://your-bucket/sgp-backup/ -f
