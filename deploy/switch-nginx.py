import pathlib
import sys

release = pathlib.Path(sys.argv[1]).resolve()
source = (release / 'previous-game.conf').read_text(encoding='utf-8')
source = source.replace('include /etc/nginx/snippets/stockgame-remaster-locations.conf;', '''location = /remaster { return 302 /; }
    location = /remaster/sw.js { alias /var/www/sgp/retire-remaster-sw.js; add_header Cache-Control "no-store"; }
    location ^~ /remaster/ { return 302 /; }
    location ^~ /api/v2/ {
        proxy_pass http://127.0.0.1:8321;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 64k;
        proxy_read_timeout 30s;
        limit_req zone=remaster_test burst=60 nodelay;
        limit_req_status 429;
    }''')
# Only the game's WebSocket goes to v2; original /api identity/admin endpoints stay intact.
marker = 'location /socket.io/ {'
position = source.index(marker)
if '--legacy-ui' not in sys.argv:
    source = source[:position] + source[position:].replace('proxy_pass http://127.0.0.1:8000;', 'proxy_pass http://127.0.0.1:8321;', 1)
pathlib.Path('/etc/nginx/conf.d/game.conf').write_text(source, encoding='utf-8')
