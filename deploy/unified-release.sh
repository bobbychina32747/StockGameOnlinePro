#!/usr/bin/env bash
set -euo pipefail
release=/opt/stockgame/releases/unified-formal-20261011
mkdir -p "$release/archives"
chmod 700 "$release/archives"
if [ -f "$release/deployed" ]; then echo 'Release already deployed; refusing replay'; exit 1; fi
# Data stays on the original host. Never include these backups in a source archive.
if [ ! -f "$release/archives/formal.sqlite" ]; then
docker exec -i sgp-backend node <<'NODE'
const Database=require('better-sqlite3'),fs=require('fs'),crypto=require('crypto');
(async()=>{const db=new Database('/app/data/stockgame.db');await db.backup('/app/data/pre-unified-formal-20261011.sqlite');
const manifest={};for(const table of ['accounts','positions','fund_holdings','orders','transactions','season_entries','achievements']){
 const rows=db.prepare('SELECT * FROM '+table+' ORDER BY id').all();manifest[table]={count:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
}fs.writeFileSync('/app/data/pre-unified-formal-20261011.manifest.json',JSON.stringify(manifest));db.close();console.log('Original formal ledger backed up');})().catch(e=>{console.error(e.message);process.exitCode=1;});
NODE
docker cp sgp-backend:/app/data/pre-unified-formal-20261011.sqlite "$release/archives/formal.sqlite"
docker cp sgp-backend:/app/data/pre-unified-formal-20261011.manifest.json "$release/archives/formal-manifest.json"
fi
# Stop the independent test writer gracefully; its original volume is retained.
docker stop sgp-remaster-test
if [ ! -f "$release/archives/remaster-test.sqlite" ]; then
docker run --rm --network none --entrypoint node \
 -v sgp-remaster-test_remaster-test-data:/archive:ro -v "$release/archives:/backup" \
 stockgame-remaster:20261010 --require /app/tooling/runtime.cjs -e \
 'const D=require("better-sqlite3"); (async()=>{const db=new D("/archive/remaster.sqlite",{readonly:true});await db.backup("/backup/remaster-test.sqlite");db.close();const copy=new D("/backup/remaster-test.sqlite",{readonly:true});if(copy.pragma("integrity_check",{simple:true})!=="ok")throw Error("Test archive integrity check failed");copy.close();console.log("2.0 test ledger archived independently and verified");})().catch(e=>{console.error(e.message);process.exitCode=1;});'
fi
chmod 600 "$release/archives/"*
sudo cp /etc/nginx/conf.d/game.conf "$release/previous-game.conf"
sudo cp /etc/nginx/snippets/stockgame-remaster-locations.conf "$release/previous-remaster-locations.conf"
sudo cp -a /var/www/sgp "$release/previous-frontend"
docker image tag sgp-game-credentials:20261011 sgp-before-unified:20261011
docker build -f "$release/backend/docker/Dockerfile.backend" -t sgp-unified-ledger:20261011 "$release/backend"
docker compose -p sgp-unified -f "$release/remaster/deploy/unified-compose.yml" build
cat > "$release/new-image.yml" <<'YAML'
services:
  backend:
    image: sgp-unified-ledger:20261011
    environment:
      - FORMAL_CONTINUOUS_SIMULATION=true
YAML
docker compose -p docker -f /opt/stockgame/backend/docker/docker-compose.yml \
 -f /opt/stockgame/deploy/docker-compose.override.yml \
 -f /opt/stockgame/releases/site-account-20261010-140959/new-image.yml \
 -f /opt/stockgame/releases/game-credentials-20261011/new-image.yml \
 -f "$release/new-image.yml" up -d --no-deps backend
for attempt in $(seq 1 90); do
 if curl -fsS http://127.0.0.1:8000/api/market/stocks -o "$release/stock-count-check.json"; then break; fi
 sleep 2
done
docker cp "$release/stock-count-check.json" sgp-backend:/tmp/unified-stock-check.json
docker exec -i sgp-backend node - /tmp/unified-stock-check.json < "$release/check-stock-counts.cjs"
docker compose -p sgp-unified -f "$release/remaster/deploy/unified-compose.yml" up -d
for attempt in $(seq 1 30); do
 if curl -fsS http://127.0.0.1:8321/api/v2/health -o /dev/null; then break; fi
 sleep 2
done
curl -fsS http://127.0.0.1:8321/api/v2/config -o "$release/formal-config-check.json"
# Copy the verified root-base bundle while retaining the complete previous frontend.
docker cp sgp-unified-formal:/app/apps/web/dist/. "$release/new-frontend"
sudo cp -a "$release/new-frontend/." /var/www/sgp/
sudo cp "$release/retire-remaster-sw.js" /var/www/sgp/retire-remaster-sw.js
sudo python3 "$release/switch-nginx.py" "$release"
sudo nginx -t
sudo systemctl reload nginx
touch "$release/deployed"
echo 'Unified formal release active; previous images, frontend and independent ledgers retained'
