# Runs the keeper bot every 30 s, restarting it if it ever exits. Output goes to bot.log.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root
Import-DotEnv
if (-not $env:STATE_FILE) { $env:STATE_FILE = Join-Path $Root 'deleverager-state.json' }
$log = Join-Path $Root 'bot.log'
$ErrorActionPreference = 'Continue'
while ($true) {
    "$(Get-Date -Format o) starting bot" | Add-Content $log
    # Append line by line (open/close each time) so the log stays readable while the bot runs.
    & node bot/run.js --loop 30 2>&1 | ForEach-Object { [System.IO.File]::AppendAllText($log, "$_`r`n") }
    "$(Get-Date -Format o) bot exited with code $LASTEXITCODE; restarting in 15s" | Add-Content $log
    Start-Sleep -Seconds 15
}
