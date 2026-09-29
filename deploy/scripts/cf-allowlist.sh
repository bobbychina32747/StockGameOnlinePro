#!/usr/bin/env bash
# 生成「只允许 Cloudflare 回源」所需的三份配置，并重载 nginx
#   用法：sudo bash cf-allowlist.sh
#   可选：sudo EXTRA_ALLOW="1.2.3.4 5.6.7.8" bash cf-allowlist.sh   # 额外放行的自家 IP（空格分隔）
#
# ⚠️ 关键坑（2026-09-28 实测踩过）：
#   allow/deny 用的是 $remote_addr，而 realip 模块会把它**改写成真实访客 IP**（这正是我们想要的日志效果），
#   于是「只允许 CF 段」的 allow/deny 会把所有访客一起 deny 掉（全站 403）。
#   正确判定源是 $realip_remote_addr —— 即 realip 改写**之前**的对端地址，对 CF 回源来说就是 CF 边缘 IP。
#
# 产出：
#   /etc/nginx/conf.d/01-cf-geo.conf      http 级 geo（判定变量 $cf_edge_ok）
#   /etc/nginx/snippets/cf-only.conf      server/location 级守卫（if ($cf_edge_ok = 0) return 403）
#   /etc/nginx/snippets/cf-realip.conf    server 级真实 IP 还原（set_real_ip_from + real_ip_header）
set -euo pipefail
EXTRA_ALLOW="${EXTRA_ALLOW:-}"
SNIP=/etc/nginx/snippets
CONFD=/etc/nginx/conf.d
mkdir -p "$SNIP" "$CONFD"

tmp4=$(mktemp); tmp6=$(mktemp)
curl -fsS https://www.cloudflare.com/ips-v4 -o "$tmp4"
curl -fsS https://www.cloudflare.com/ips-v6 -o "$tmp6"
n4=$(grep -c . "$tmp4"); n6=$(grep -c . "$tmp6")

{
  echo "# 自动生成（cf-allowlist.sh $(date -Iseconds)）：Cloudflare 边缘段"
  echo "# 判定源必须是 \$realip_remote_addr（realip 改写前的对端地址），不能用 \$remote_addr —— 那已被还原成访客 IP"
  echo 'geo $realip_remote_addr $cf_edge_ok {'
  echo '    default 0;'
  echo '    127.0.0.1/32 1;'
  echo '    ::1/128 1;'
  while read -r cidr; do [ -n "$cidr" ] && echo "    $cidr 1;"; done < "$tmp4"
  while read -r cidr; do [ -n "$cidr" ] && echo "    $cidr 1;"; done < "$tmp6"
  for ip in $EXTRA_ALLOW; do echo "    $ip 1;"; done
  echo '}'
} > "$CONFD/01-cf-geo.conf"

{
  echo "# 自动生成（cf-allowlist.sh）：只允许 Cloudflare 回源，其余 403"
  echo "# 判定变量与段列表见 /etc/nginx/conf.d/01-cf-geo.conf（http 级 geo）"
  echo 'if ($cf_edge_ok = 0) { return 403; }'
} > "$SNIP/cf-only.conf"

{
  echo "# 自动生成（cf-allowlist.sh）：真实访客 IP 还原"
  while read -r cidr; do [ -n "$cidr" ] && echo "set_real_ip_from $cidr;"; done < "$tmp4"
  while read -r cidr; do [ -n "$cidr" ] && echo "set_real_ip_from $cidr;"; done < "$tmp6"
  for ip in $EXTRA_ALLOW; do [ -n "$ip" ] && echo "set_real_ip_from $ip;"; done
  echo 'real_ip_header CF-Connecting-IP;'
} > "$SNIP/cf-realip.conf"

rm -f "$tmp4" "$tmp6"
echo "CF 段：IPv4 $n4 条 / IPv6 $n6 条；额外放行：${EXTRA_ALLOW:-（无）}"
nginx -t && echo "nginx 语法 OK（记得 reload 生效）"
