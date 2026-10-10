$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$artifactRoot = 'C:\Users\lenovo\.codex\visualizations\2026\10\10\01a124f3-4a8d-7371-9df8-c4ac46738b31'
$baselineZip = Join-Path $artifactRoot 'stockgame-source-baseline-20261010.zip'
if (Test-Path -LiteralPath $baselineZip) { throw 'The baseline archive already exists; refusing to replace it.' }
$safeDirectories = @('backend/src','backend/test','frontend/src','frontend/public','tests','docs','.github','.githooks')
$safeRootFiles = @('README.md','CHANGELOG.md','LICENSE','.gitignore','.prettierrc','backend/package.json','backend/package-lock.json','backend/tsconfig.json','backend/jest.config.js','frontend/package.json','frontend/package-lock.json','frontend/tsconfig.json','frontend/tsconfig.node.json','frontend/vite.config.ts','frontend/index.html','frontend/jest.config.cjs','frontend/babel.config.cjs')
$selectedFiles = @()
foreach ($relativeDirectory in $safeDirectories) {
    $safeDirectory = Join-Path $sourceRoot $relativeDirectory
    if (Test-Path -LiteralPath $safeDirectory) {
        $selectedFiles += Get-ChildItem -LiteralPath $safeDirectory -Recurse -File | Where-Object {
            $_.FullName -notmatch '[\\/](node_modules|artifacts|data|\.local-oauth)[\\/]' -and
            $_.Name -notmatch '(^\.env|\.(db|sqlite|pem|key)(-|\.|$))' -and $_.Length -lt 95MB
        }
    }
}
foreach ($relativeFile in $safeRootFiles) { $filePath = Join-Path $sourceRoot $relativeFile; if (Test-Path -LiteralPath $filePath) { $selectedFiles += Get-Item -LiteralPath $filePath } }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipArchive = [IO.Compression.ZipFile]::Open($baselineZip, [IO.Compression.ZipArchiveMode]::Create)
$manifestRows = @()
try {
    foreach ($selectedFile in $selectedFiles) {
        $relativePath = $selectedFile.FullName.Substring($sourceRoot.Length + 1).Replace('\','/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipArchive, $selectedFile.FullName, $relativePath) | Out-Null
        $manifestRows += @{path=$relativePath;bytes=$selectedFile.Length;sha256=(Get-FileHash -LiteralPath $selectedFile.FullName -Algorithm SHA256).Hash}
    }
} finally { $zipArchive.Dispose() }
[IO.File]::WriteAllText((Join-Path $artifactRoot 'stockgame-source-baseline-manifest.json'), ($manifestRows | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Write-Output ("Source baseline: {0} files, {1} bytes" -f $manifestRows.Count,(Get-Item -LiteralPath $baselineZip).Length)
