# Helper: run an arbitrary bash snippet on the server over ssh without quoting hell.
# The snippet is base64-encoded, so quotes, braces, pipes and Chinese text all survive.
# Usage: powershell -File scripts\_ssh.ps1 -ScriptFile path\to\snippet.sh
param(
    [Parameter(Mandatory = $true)][string]$ScriptFile,
    [string]$Key = 'E:\Files\bobbychina-pages\.partner-kit\keys\id_ed25519',
    [string]$SshHost = 'ubuntu@43.133.165.97'
)
$ErrorActionPreference = 'Stop'
$text = [IO.File]::ReadAllText($ScriptFile)
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($text -replace "`r`n", "`n")))
& ssh.exe -i $Key -o IdentitiesOnly=yes -o ConnectTimeout=20 $SshHost "echo $b64 | base64 -d > /tmp/_dsh_cmd.sh && bash /tmp/_dsh_cmd.sh; rm -f /tmp/_dsh_cmd.sh"
exit $LASTEXITCODE
