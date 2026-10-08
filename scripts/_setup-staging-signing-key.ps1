# One-off: give the STAGING identity service its own Ed25519 signing key.
# Without it /authorize + /token still work but /token returns 503 and JWKS is an empty set
# (the module degrades on purpose: a missing key must never block the whole app).
#
# The private key is generated ON THE SERVER and never leaves it; nothing is written locally.
# Usage: powershell -File scripts\_setup-staging-signing-key.ps1
param(
    [string]$Key = 'E:\Files\bobbychina-pages\.partner-kit\keys\id_ed25519',
    [string]$SshHost = 'ubuntu@43.133.165.97'
)
$ErrorActionPreference = 'Stop'

$remoteScript = @'
set -e
DIR=/opt/stockgame/staging/keys
sudo mkdir -p "$DIR"
if [ -s "$DIR/identity-ed25519.pem" ]; then
  echo "KEY_EXISTS"
else
  sudo openssl genpkey -algorithm ED25519 -out "$DIR/identity-ed25519.pem"
  echo "KEY_GENERATED"
fi
sudo chmod 600 "$DIR/identity-ed25519.pem"
sudo chown root:root "$DIR/identity-ed25519.pem"
echo "--- key file ---"
sudo ls -la "$DIR"
echo "--- add env if missing ---"
if sudo grep -q '^IDENTITY_JWT_KEY_FILE=' /opt/stockgame/staging/prod.env; then
  echo "ENV_EXISTS"
else
  sudo cp /opt/stockgame/staging/prod.env /opt/stockgame/staging/prod.env.bak.$(date +%Y%m%d-%H%M%S)
  printf '\n# \xe7\xbb\x9f\xe4\xb8\x80\xe8\xba\xab\xe4\xbb\xbd/\xe6\x8e\x88\xe6\x9d\x83\xe7\xb3\xbb\xe7\xbb\x9f\xe7\x9a\x84 Ed25519 \xe7\xad\xbe\xe5\x90\x8d\xe7\xa7\x81\xe9\x92\xa5\xef\xbc\x88staging \xe4\xb8\x93\xe7\x94\xa8\xef\xbc\x8c\xe4\xb8\x8e\xe7\xba\xbf\xe4\xb8\x8a\xe4\xb8\x8d\xe5\x90\x8c\xef\xbc\x89\nIDENTITY_JWT_KEY_FILE=/opt/stockgame/staging/keys/identity-ed25519.pem\n' | sudo tee -a /opt/stockgame/staging/prod.env >/dev/null
  echo "ENV_ADDED"
fi
echo "--- verify ---"
sudo grep -n 'IDENTITY_JWT_KEY_FILE' /opt/stockgame/staging/prod.env
# prod.env is mounted as env_file -> the container must be recreated to pick it up
cd /opt/stockgame/staging && sudo docker compose up -d
'@

$bytes = [Text.Encoding]::UTF8.GetBytes(($remoteScript -replace "`r`n", "`n"))
$b64 = [Convert]::ToBase64String($bytes)
& ssh.exe -i $Key -o IdentitiesOnly=yes $SshHost "echo $b64 | base64 -d > /tmp/_staging-key.sh && bash /tmp/_staging-key.sh; rm -f /tmp/_staging-key.sh"
if ($LASTEXITCODE -ne 0) { throw "staging signing key setup failed (exit $LASTEXITCODE)" }
Write-Host 'staging signing key ready'
