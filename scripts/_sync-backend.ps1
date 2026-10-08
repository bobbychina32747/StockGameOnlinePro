# Manual backend source sync to the server (no bash/rsync locally: Windows tar + ssh, same excludes).
# Usage: powershell -File scripts\_sync-backend.ps1 -DryRun   |   powershell -File scripts\_sync-backend.ps1
#
# Keeps the same exclusions as .partner-kit/scripts/deploy-backend.sh (all of them are past incidents):
#   node_modules  local Windows native modules would pollute the Linux build
#   dist          the image builds it itself
#   data          * on the server this dir holds the staging database; overwriting = wiping game state
#   .env*         ** server backend/.env holds production secrets and lives in the source tree root
#   .git          not needed, large
# Only rebuilds the STAGING container (sgp-backend-staging). The production container is not touched.
param(
    [switch]$DryRun,
    [switch]$Prod,
    [string]$RepoRoot = 'E:\Files\Games\stockGameOnlinePro',
    [string]$Key = 'E:\Files\bobbychina-pages\.partner-kit\keys\id_ed25519',
    [string]$SshHost = 'ubuntu@43.133.165.97'
)
$ErrorActionPreference = 'Stop'
$backend = Join-Path $RepoRoot 'backend'
$tarball = Join-Path $env:TEMP 'sgp-backend-sync.tar.gz'
$exclFile = Join-Path $env:TEMP 'sgp-backend-excludes.txt'
$tar = Join-Path $env:SystemRoot 'system32\tar.exe'

$excludes = @(
    'node_modules', '*/node_modules', '*/node_modules/*',
    'dist', '*/dist', '*/dist/*',
    'data', '*/data', '*/data/*',
    '.env', '.env.*', '*/.env', '*/.env.*',
    '.git', '*/.git', '*/.git/*',
    '.local-oauth', '*/.local-oauth', '*/.local-oauth/*'
)
[IO.File]::WriteAllLines($exclFile, $excludes, [Text.UTF8Encoding]::new($false))

Write-Host "=== [1/4] packaging backend source (excluding node_modules/dist/data/.env/.git) ==="
if (Test-Path $tarball) { Remove-Item $tarball -Force }
& $tar -czf $tarball -X $exclFile -C $backend .
if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
$size = (Get-Item $tarball).Length
Write-Host ("  archive {0:N1} MB" -f ($size / 1MB))
if ($size -gt 60MB) { throw "archive too big ($([math]::Round($size/1MB))MB) - exclusions probably failed, aborting" }

$list = & $tar -tzf $tarball
$bad = $list | Where-Object { $_ -match '(^|/)node_modules/|(^|/)\.git/|(^|/)data/stockgame|\.env$' }
if ($bad) { throw ("archive contains forbidden entries:`n" + (($bad | Select-Object -First 5) -join "`n")) }
Write-Host ("  {0} files, exclusion check passed" -f $list.Count)

if ($DryRun) { Write-Host '(DryRun: packaged only, nothing uploaded)'; exit 0 }

# 目标环境：默认只动 staging；-Prod 才碰线上（线上数据卷 sgp-data = 真实玩家账号与游戏状态）
$container = if ($Prod) { 'sgp-backend' } else { 'sgp-backend-staging' }
$rebuild = if ($Prod) {
    # 线上用基础 compose + 覆盖文件（不要把 sgp-data 卷与密钥挂载搞丢）
    'cd /opt/stockgame/backend && sudo docker compose -f docker/docker-compose.yml -f /opt/stockgame/deploy/docker-compose.override.yml up -d --build 2>&1 | tail -8'
} else {
    'cd /opt/stockgame/staging && sudo docker compose up -d --build 2>&1 | tail -6'
}

Write-Host "=== [2/4] upload to /tmp and extract into /opt/stockgame/backend ==="
$remote = '/tmp/sgp-backend-sync.tar.gz'
$pipeline = "`"$tar`" -czf - -X `"$exclFile`" -C `"$backend`" . | ssh.exe -i `"$Key`" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new $SshHost `"cat > $remote`""
& cmd.exe /c $pipeline
if ($LASTEXITCODE -ne 0) { throw "upload failed (exit $LASTEXITCODE)" }
& ssh.exe -i $Key -o IdentitiesOnly=yes $SshHost "ls -la $remote; sudo tar xzf $remote -C /opt/stockgame/backend --no-same-owner && sudo chown -R ubuntu:ubuntu /opt/stockgame/backend && rm -f $remote && echo SYNC_OK"
if ($LASTEXITCODE -ne 0) { throw "remote extract failed (exit $LASTEXITCODE)" }

Write-Host ("=== [3/4] rebuilding {0} (60-180s) ===" -f $container)
& ssh.exe -i $Key -o IdentitiesOnly=yes $SshHost $rebuild
if ($LASTEXITCODE -ne 0) { throw "rebuild failed (exit $LASTEXITCODE)" }

Write-Host "=== [4/4] waiting for health ==="
$health = 'unknown'
for ($i = 1; $i -le 40; $i++) {
    $health = (& ssh.exe -i $Key -o IdentitiesOnly=yes $SshHost "sudo docker inspect -f '{{.State.Health.Status}}' $container 2>/dev/null || echo none").Trim()
    Write-Host "  [$i] $health"
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 5
}
if ($health -ne 'healthy') {
    & ssh.exe -i $Key -o IdentitiesOnly=yes $SshHost "sudo docker logs --tail 40 $container 2>&1 | sed 's/\x1b\[[0-9;]*m//g'"
    throw "DEPLOY FAILED: $container did not become healthy"
}
Write-Host ("DEPLOY OK - {0} rebuilt and healthy" -f $container)
if ($Prod) {
    Write-Host '--- 线上关键端点自检 ---'
    & ssh.exe -i $Key -o IdentitiesOnly=yes $SshHost 'curl -s -o /dev/null -w "market/prices=%{http_code}\n" --max-time 15 http://127.0.0.1:8000/api/market/prices; curl -s -o /dev/null -w "oauth/clients=%{http_code}\n" --max-time 15 http://127.0.0.1:8000/api/auth/identity/oauth/clients; curl -s --max-time 15 http://127.0.0.1:8000/api/auth/identity/.well-known/jwks.json | head -c 160; echo'
}
