# Helper: run an arbitrary bash snippet on the server over ssh without quoting hell.
# The snippet is base64-encoded, so quotes, braces, pipes and Chinese text all survive.
# Usage: powershell -File scripts\_ssh.ps1 -ScriptFile path\to\snippet.sh
param(
    [Parameter(Mandatory = $true)][string]$ScriptFile,
    [string]$Key = $(if ($env:SGP_SSH_KEY) { $env:SGP_SSH_KEY } else { Join-Path $env:USERPROFILE '.ssh\main_2026' }),
    [string]$SshHost = 'ubuntu@43.133.165.97'
)
$ErrorActionPreference = 'Stop'
$text = [IO.File]::ReadAllText($ScriptFile, [Text.Encoding]::UTF8)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($text -replace "`r`n", "`n")))
$remote = 'set -e; cmd_path=$(mktemp /tmp/sgp-cmd.XXXXXXXX.sh); trap ''rm -f "$cmd_path"'' EXIT; printf %s {0} | base64 -d > "$cmd_path"; bash "$cmd_path"' -f $b64
& ssh.exe -i $Key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 $SshHost $remote
exit $LASTEXITCODE
