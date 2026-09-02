# ---------------------------------------------------------------------------
# Hoza YT - install the watchdog so the server is always up
#
# Registers a scheduled task that starts the watchdog at sign-in, hidden, with
# no run-time limit and automatic restart if it ever dies. No administrator
# rights are needed: the task runs as the current user only.
#
# If task registration is refused (locked-down machine, group policy), it falls
# back to a Startup-folder shortcut, which needs no privileges at all.
#
# Run it through install-service.bat, or directly:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vbs       = Join-Path $Here 'start-watchdog-hidden.vbs'
$Watchdog  = Join-Path $Here 'watchdog.py'
$Wscript   = Join-Path $env:SystemRoot 'System32\wscript.exe'
$TaskName  = 'Hoza YT Watchdog'
$StartupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$NewLink   = Join-Path $StartupDir 'Hoza YT Watchdog.lnk'
$OldLink   = Join-Path $StartupDir 'Hoza YT Server.lnk'

function Say($text)  { Write-Host $text }
function Step($text) { Write-Host ''; Write-Host "-- $text" -ForegroundColor Cyan }

Say ''
Say '  Hoza YT - always-on setup'
Say '  ========================='

foreach ($required in @($Vbs, $Watchdog)) {
    if (-not (Test-Path $required)) {
        Write-Host "Missing file: $required" -ForegroundColor Red
        exit 1
    }
}

# --------------------------------------------------------------------------- #
# 1. Python and dependencies
# --------------------------------------------------------------------------- #

Step 'Checking Python'

$python = (Get-Command python -ErrorAction SilentlyContinue)
if (-not $python) {
    Write-Host 'Python was not found on PATH.' -ForegroundColor Red
    Write-Host 'Install it from https://www.python.org/downloads/ and tick "Add to PATH".'
    exit 1
}
Say "   $((& python --version) 2>&1)"

& python -c "import fastapi, uvicorn, httpx, psutil, yt_dlp, imageio_ffmpeg" 2>$null
if ($LASTEXITCODE -ne 0) {
    Say '   Installing requirements (first run only)...'
    & python -m pip install -r (Join-Path $Here 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Dependency installation failed.' -ForegroundColor Red
        exit 1
    }
}
Say '   Dependencies OK'

# --------------------------------------------------------------------------- #
# 2. Clear anything from an earlier setup
#
# The Startup shortcut from the previous approach started the server directly.
# Leaving it in place would race the watchdog for the same port.
# --------------------------------------------------------------------------- #

Step 'Clearing any earlier setup'

if (Test-Path $OldLink) {
    Remove-Item $OldLink -Force
    Say '   Removed the old "Hoza YT Server" startup shortcut'
}
if (Test-Path $NewLink) {
    Remove-Item $NewLink -Force
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Say '   Removed the previous scheduled task'
}

# --------------------------------------------------------------------------- #
# 3. Register the task
# --------------------------------------------------------------------------- #

Step 'Registering the sign-in task'

$installed = $false
try {
    $action = New-ScheduledTaskAction -Execute $Wscript `
                                      -Argument ('"{0}"' -f $Vbs) `
                                      -WorkingDirectory $Here

    # A short delay keeps it from competing with everything else at sign-in.
    $atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME"
    $atLogon.Delay = 'PT20S'

    # The watchdog watches the server, and this watches the watchdog. Every ten
    # minutes the task tries to start again; MultipleInstances IgnoreNew means
    # that does nothing at all while the watchdog is alive, and starts it again
    # if it ever is not. Ten years stands in for "indefinitely", which the
    # cmdlet will not accept as a duration.
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -DontStopOnIdleEnd `
        -StartWhenAvailable `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -RestartCount 99 `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                            -LogonType Interactive `
                                            -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName `
                           -Action $action `
                           -Trigger @($atLogon, $repeat) `
                           -Settings $settings `
                           -Principal $principal `
                           -Description 'Keeps the Hoza YT local server running.' | Out-Null

    $installed = $true
    Say '   Scheduled task registered'
}
catch {
    Write-Host "   Task registration refused: $($_.Exception.Message)" -ForegroundColor Yellow
    Say '   Falling back to a Startup-folder shortcut'

    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($NewLink)
    $link.TargetPath       = $Wscript
    $link.Arguments        = '"{0}"' -f $Vbs
    $link.WorkingDirectory = $Here
    $link.WindowStyle      = 7
    $link.Description      = 'Keeps the Hoza YT local server running.'
    $link.Save()

    if (Test-Path $NewLink) {
        $installed = $true
        Say '   Startup shortcut created'
    }
}

if (-not $installed) {
    Write-Host 'Could not install the watchdog by either method.' -ForegroundColor Red
    exit 1
}

# --------------------------------------------------------------------------- #
# 4. Start it now
# --------------------------------------------------------------------------- #

Step 'Starting the watchdog now'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Start-ScheduledTask -TaskName $TaskName
} else {
    Start-Process -FilePath $Wscript -ArgumentList ('"{0}"' -f $Vbs) -WorkingDirectory $Here
}

Say '   Waiting for the server to answer...'

$ready = $false
foreach ($attempt in 1..40) {
    try {
        Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8765/api/health' -TimeoutSec 2 | Out-Null
        $ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}

Say ''
if ($ready) {
    Write-Host '  Done. The server is running now and comes back on its own:' -ForegroundColor Green
    Write-Host '    - within ~45s if it crashes or hangs   (the watchdog)'
    Write-Host '    - within ~10m if the watchdog is killed (the scheduled task)'
    Write-Host '    - at every sign-in, 20s in'
    Write-Host ''
    Write-Host '  You should never need to start or stop it by hand again.'
    Write-Host ''
    Write-Host '  Dashboard: http://127.0.0.1:8765/'
} else {
    Write-Host '  The watchdog is installed, but the server has not answered yet.' -ForegroundColor Yellow
    Write-Host '  It may still be starting. Check what it is doing with:'
    Write-Host '    python watchdog.py --status'
    Write-Host "    type `"$(Join-Path $Here 'data\watchdog.log')`""
}

Say ''
Say '  Turn all of this off again with uninstall-service.bat.'
Say ''
