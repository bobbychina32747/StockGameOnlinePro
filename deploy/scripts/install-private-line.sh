#!/usr/bin/env bash
# 站内私线：服务器端安装（2026-10-27）
#
# 做四件事，全部幂等：
#   1. 安装 nginx 片段 chat.conf 到 /etc/nginx/snippets/chat.conf
#   2. 在 /etc/nginx/conf.d/portal.conf 里补 include（已存在则跳过），nginx -t 通过才 reload
#   3. 在后端容器里创建/更新受邀账号（默认 tina，role=subadmin），口令从环境变量读
#   4. 本机自检：/api/chat/access 未登录应 401，SSE 端点应返回 event-stream
#
# 由站主确认后由部署方执行；脚本本身不联网、不打印口令。
#
# 用法（在服务器上，产物已 scp 到 /tmp/private-line/）：
#   sudo CHAT_PEER_PASSWORD='**********' bash /tmp/private-line/install-private-line.sh
# 可选环境变量：
#   CHAT_PEER_USERNAME=tina  CHAT_PEER_EMAIL=tina@bobbycn.cc  CHAT_PEER_PASSWORD=...
#   CONTAINER=sgp-backend    NGINX_PORTAL=/etc/nginx/conf.d/portal.conf
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${CONTAINER:-sgp-backend}"
NGINX_PORTAL="${NGINX_PORTAL:-/etc/nginx/conf.d/portal.conf}"
USERNAME="${CHAT_PEER_USERNAME:-tina}"
EMAIL="${CHAT_PEER_EMAIL:-tina@bobbycn.cc}"
PASSWORD="${CHAT_PEER_PASSWORD:-}"

say() { printf '\n=== %s ===\n' "$1"; }

if [ -z "$PASSWORD" ]; then
  echo "缺少 CHAT_PEER_PASSWORD（受邀账号的登录口令，至少 10 位）。" >&2
  exit 2
fi

say "1/4 安装 nginx 片段"
install -m 0644 "$HERE/chat.conf" /etc/nginx/snippets/chat.conf

say "2/4 在门户 vhost 里补 include"
if grep -q 'snippets/chat.conf' "$NGINX_PORTAL"; then
  echo "已存在 include，跳过"
else
  cp -a "$NGINX_PORTAL" "$NGINX_PORTAL.bak.$(date +%Y%m%d-%H%M%S)"
  # 插在 blog.conf 那行之后；找不到就追加到最后一个 include 之后（仍保持在 server 块内）
  if grep -q 'snippets/blog.conf' "$NGINX_PORTAL"; then
    sed -i '/snippets\/blog.conf/a\    include \/etc\/nginx\/snippets\/chat.conf;' "$NGINX_PORTAL"
  else
    echo "未找到 blog.conf include，追加到文件末尾（若不在 server 块内请手工调整）" >&2
    printf '\n    include /etc/nginx/snippets/chat.conf;\n' >> "$NGINX_PORTAL"
  fi
fi
nginx -t
systemctl reload nginx
echo "nginx 已 reload"

say "3/4 创建/更新受邀账号 $USERNAME（容器内执行，口令不落盘）"
docker cp "$HERE/seed-chat-peer.mjs" "$CONTAINER:/tmp/seed-chat-peer.mjs"
docker exec -e CHAT_PEER_USERNAME="$USERNAME" -e CHAT_PEER_EMAIL="$EMAIL" -e CHAT_PEER_PASSWORD="$PASSWORD" \
  "$CONTAINER" node /tmp/seed-chat-peer.mjs
docker exec "$CONTAINER" rm -f /tmp/seed-chat-peer.mjs

say "4/4 自检"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8000/api/chat/access || true)
echo "GET /api/chat/access 匿名 → $code（期望 401）"
[ "$code" = "401" ] || { echo "自检失败：期望 401" >&2; exit 3; }
ctype=$(curl -s -o /dev/null -D - --max-time 10 http://127.0.0.1:8000/api/chat/stream | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2; exit}')
echo "GET /api/chat/stream 匿名 → content-type: ${ctype:-<none>}（期望 application/json 的 401，鉴权在前）"

echo
echo "完成。浏览器打开 https://bobbycn.cc/chat/ 用 $USERNAME 登录验收。"
