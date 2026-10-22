param([ValidateSet('portable','nsis')][string]$Target = 'portable')
$ErrorActionPreference = 'Stop'
# npm may inherit PowerShell 7 module paths while this script runs in Windows PowerShell.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
$projectRoot = Split-Path $PSScriptRoot -Parent
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$bundleRoot = Join-Path $projectRoot ('dist\SessionDesk-' + $metadata.version + '-win-x64')
if (!(Test-Path -LiteralPath $bundleRoot)) {
  # ZIP compression may retain a large .NET heap. End that process before NSIS.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-portable.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Runtime payload build failed.' }
}
$appRoot = Join-Path $bundleRoot 'resources\app'
$packaged = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
if ($packaged.version -ne $metadata.version -or $packaged.productName -ne 'Session Desk') { throw 'Packaged identity mismatch.' }
$allowlist = @('time-format.js','desktop.html','desktop.css','desktop-ui.js','desktop-policy.cjs','desktop-membership.cjs','desktop-state.cjs','desktop-properties.cjs','project-model.cjs','project-sync.cjs','codex-rpc.cjs','codex-index.cjs','core.cjs','session-io.cjs','sync-worker.cjs','codex-lifecycle.cjs','mac-lifecycle.cjs','direct-webdav.cjs','git-service.cjs','git-workflow.cjs','project-files.cjs','codex-cli.cjs','recovery.cjs','main.cjs','preload.cjs','LICENSE')
$actual = @(Get-ChildItem -LiteralPath $appRoot -Recurse -File)
if ($actual.Count -ne ($allowlist.Count + 1)) { throw 'Unexpected files in packaged app.' }
foreach ($file in $actual) { if ($file.DirectoryName -ne $appRoot -or ($file.Name -ne 'package.json' -and $file.Name -notin $allowlist)) { throw ('Unexpected packaged file: ' + $file.Name) } }
foreach ($name in $allowlist) {
  if ((Get-FileHash -LiteralPath (Join-Path $projectRoot $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $appRoot $name)).Hash) { throw ('Stale ZIP build: ' + $name + '. Build a new version first.') }
}
$privateFiles = Get-ChildItem -LiteralPath $bundleRoot -Recurse -File | Where-Object { $_.Name -like '.env*' -or $_.Extension -in @('.jsonl','.sqlite','.db','.codexbundle') }
if ($privateFiles) { throw 'Private data found in payload.' }
$node = (Get-Command node -ErrorAction Stop).Source
# Lower compression avoids the default 7z ultra mode's large memory use.
$env:ELECTRON_BUILDER_COMPRESSION_LEVEL = '1'
$builder = Join-Path $projectRoot 'node_modules\electron-builder\out\cli\cli.js'
$artifactKind = if ($Target -eq 'nsis') { 'Setup' } else { 'portable' }
$output = Join-Path $projectRoot ('dist\single-exe\SessionDesk-' + $metadata.version + '-' + $artifactKind + '-win-x64.exe')
if (Test-Path -LiteralPath $output) { throw ('Output already exists: ' + $output) }
Push-Location $projectRoot
try {
  & $node $builder --config electron-builder.json --prepackaged $bundleRoot --win $Target --x64 --publish never
  if ($LASTEXITCODE -ne 0) { throw 'Single executable build failed.' }
} finally { Pop-Location }
if (!(Test-Path -LiteralPath $output)) { throw 'Portable executable missing.' }
Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Hash,Path
