# Registers a Windows scheduled task that starts the bot at logon (hidden) and starts it now.
# Remove with: Unregister-ScheduledTask -TaskName Deleverager -Confirm:$false
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Import-DotEnv
if (-not $env:DELEVERAGER_ADDRESS) { throw "No DELEVERAGER_ADDRESS in .env. Run scripts\windows\deploy.ps1 first." }

$script = Join-Path $PSScriptRoot 'run-bot.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Deleverager' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Deleverager'
Write-Host "Bot started (task 'Deleverager'). Log: $(Join-Path $Root 'bot.log')"

# Warn if the PC will sleep while plugged in: a sleeping PC can't run the bot.
$ac = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE | Select-String 'Current AC Power Setting Index: (0x[0-9a-f]+)').Matches[0].Groups[1].Value
if ([Convert]::ToInt32($ac, 16) -ne 0) {
    Write-Warning "This PC sleeps after $([Convert]::ToInt32($ac, 16) / 60) min when plugged in. Set Settings > System > Power > 'When plugged in, put my device to sleep after' to Never, and keep it plugged in with the lid open."
}
