$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$outputRoot = Join-Path $projectRoot 'dist'
$bundleName = 'SessionDesk-' + $metadata.version + '-win-x64'
$bundleRoot = Join-Path $outputRoot $bundleName
if (Test-Path -LiteralPath $bundleRoot) { throw "Output already exists: $bundleRoot" }
$runtimeRoot = Join-Path $projectRoot 'node_modules\electron\dist'
if (!(Test-Path -LiteralPath (Join-Path $runtimeRoot 'electron.exe'))) { throw 'Electron runtime missing. Run npm ci first.' }
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
Get-ChildItem -LiteralPath $runtimeRoot | Copy-Item -Destination $bundleRoot -Recurse
Rename-Item -LiteralPath (Join-Path $bundleRoot 'electron.exe') -NewName 'SessionDesk.exe'
$appRoot = Join-Path $bundleRoot 'resources\app'
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
# Explicit allowlist: no credentials, local state, sessions, caches or development dependencies.
$applicationFiles = @('time-format.js','desktop.html','desktop.css','desktop-ui.js','desktop-policy.cjs','desktop-membership.cjs','desktop-state.cjs','desktop-properties.cjs','project-model.cjs','project-sync.cjs','codex-rpc.cjs','core.cjs','direct-webdav.cjs','git-service.cjs','git-workflow.cjs','project-files.cjs','codex-cli.cjs','recovery.cjs','main.cjs','preload.cjs','LICENSE')
foreach ($name in $applicationFiles) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $appRoot }
@{ name=$metadata.name; productName='Session Desk'; version=$metadata.version; main='main.cjs'; license='MIT' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $appRoot 'package.json') -Encoding utf8
@'
Session Desk for Windows x64

Extract the entire ZIP, then open SessionDesk.exe.
Keep the resources, locales and DLL files beside the EXE. Node.js is not required.
This preview is not code-signed. Codex CLI is required for native project discovery and verified conversation recovery.
No passwords, accounts or conversation data are included. Configure storage inside the app.
'@ | Set-Content -LiteralPath (Join-Path $bundleRoot 'READ-ME.txt') -Encoding utf8
$unexpected = Get-ChildItem -LiteralPath $appRoot -Recurse -File | Where-Object { $_.Name -like '.env*' -or $_.Extension -in @('.jsonl','.sqlite','.db') }
if ($unexpected) { throw 'Unexpected private data file in package' }
$zipPath = Join-Path $outputRoot ($bundleName + '.zip')
Compress-Archive -LiteralPath $bundleRoot -DestinationPath $zipPath -CompressionLevel Optimal
Get-FileHash -LiteralPath $zipPath -Algorithm SHA256 | Select-Object Hash,Path
