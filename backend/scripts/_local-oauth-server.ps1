# 本机跑统一身份 + 授权系统的后端（仅供本机冒烟测试，不碰任何线上/测试环境）
# 用法：pwsh -File .\scripts\_local-oauth-server.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:NODE_ENV = 'development'
$env:PORT = '8099'
$env:DB_TYPE = 'better-sqlite3'
$env:SQLITE_PATH = 'E:\Files\Games\stockGameOnlinePro\.local-oauth\oauth-dev.db'
$env:DB_SYNCHRONIZE = 'true'
$env:IDENTITY_JWT_KEY_FILE = 'E:\Files\Games\stockGameOnlinePro\.local-oauth\identity-ed25519.pem'
$env:APP_BASE_URL = 'http://localhost:5180'
$env:CORS_ORIGIN = 'http://localhost:5180,http://127.0.0.1:5180'
$env:TRUST_PROXY = '0'
$env:TURNSTILE_MODE = 'off'
$env:JWT_SECRET = 'local-dev-only-not-a-secret-0123456789abcdef'

# 邮件走 LogMailer（不发真信）：验证链接只写进日志，测试脚本从库里取令牌
Remove-Item Env:RESEND_API_KEY -ErrorAction SilentlyContinue

Write-Host "[local-oauth] 启动后端 PORT=$($env:PORT) DB=$($env:SQLITE_PATH)"
node dist/src/main.js
