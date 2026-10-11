#!/usr/bin/env bash
set -euo pipefail
release=/opt/stockgame/releases/unified-formal-20261011
test -f "$release/previous-frontend/index.html"
# Keep the compatible expanded ledger backend: players may now own new symbols.
# Never restore a pre-release database over post-release trades.
sudo cp -a "$release/previous-frontend/." /var/www/sgp/
sudo python3 "$release/switch-nginx.py" "$release" --legacy-ui
sudo nginx -t
sudo systemctl reload nginx
echo 'Previous UI restored; current ledger and expanded instrument registry retained'
