# ---------------------------------------------------------------------------
# Hoza YT - remove the watchdog
#
# Stops the watchdog and the server, and takes away everything that would start
# them again: the scheduled task, the Startup shortcut, and the shortcut the
# earlier setup used.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Continue'

$Here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName   = 'Hoza YT Watchdog'
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$Links      = @(
    (Join-Path $StartupDir 'Hoza YT Watchdog.lnk'),
    (Join-Path $StartupDir 'Hoza YT Server.lnk')
)

Write-Host ''
Write-Host '  Hoza YT - removing the always-on setup'
Write-Host '  ======================================'
Write-Host ''

# 1. Nothing may re-launch it while we are stopping it.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host '  Removed the scheduled task.'
} else {
    Write-Host '  No scheduled task was registered.'
}

foreach ($link in $Links) {
    if (Test-Path $link) {
        Remove-Item $link -Force
        Write-Host "  Removed $(Split-Path -Leaf $link)."
    }
}

# 2. Then the running processes, watchdog first so it cannot resurrect the
#    server between the two kills.
& (Join-Path $Here 'stop-processes.ps1')

Write-Host ''
Write-Host '  Done. Nothing will start on its own now.'
Write-Host '  Start it by hand any time with start-server.bat,'
Write-Host '  or put it all back with install-service.bat.'
Write-Host ''
