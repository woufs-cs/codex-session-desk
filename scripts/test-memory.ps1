param([ValidateSet(8,32,138)][int]$SizeMB=8)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$node=(Get-Command node -ErrorAction Stop).Source
$free=[double](& $node -e "console.log(require('os').freemem())")
if($free -lt 2GB){throw 'Less than 2 GB free RAM. Test not started.'}
$env:TEMP=Join-Path $root 'test-data\stream-temp'
$env:TMP=$env:TEMP
$env:DESK_TEST_MB=[string]$SizeMB
$out=Join-Path $root ('test-data\memory-'+$SizeMB+'.log')
$err=Join-Path $root ('test-data\memory-'+$SizeMB+'.err')
$p=Start-Process -FilePath $node -ArgumentList @('--max-old-space-size=192','test/large-session.test.cjs') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$p.PriorityClass='BelowNormal'
$peak=0L
$deadline=(Get-Date).AddMinutes(3)
while(!$p.HasExited){
 $p.Refresh();$peak=[Math]::Max($peak,$p.PeakWorkingSet64)
 if($peak -gt 384MB -or (Get-Date) -gt $deadline){Stop-Process -Id $p.Id -Force;throw 'Test stopped by memory/time watchdog; do not increase size.'}
 Start-Sleep -Milliseconds 100
}
$p.WaitForExit()
Get-Content -LiteralPath $out
if((Get-Item -LiteralPath $err).Length){Get-Content -LiteralPath $err}
if($p.ExitCode -ne 0){throw 'Memory test failed; do not increase size.'}
Write-Output ('WATCHDOG_PASS sizeMB='+$SizeMB+' peakWorkingSetMB='+[Math]::Ceiling($peak/1MB))
