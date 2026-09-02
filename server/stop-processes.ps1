# ---------------------------------------------------------------------------
# Hoza YT - stop the watchdog and the server
#
# Order matters. The watchdog exists to restart the server, so killing the
# server first only teaches you that the watchdog works.
#
# Shared by stop-server.bat and uninstall-service.ps1.
# ---------------------------------------------------------------------------

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir  = if ($env:HOZA_DATA_DIR) { $env:HOZA_DATA_DIR } else { Join-Path $Here 'data' }
$LockPath = Join-Path $DataDir 'watchdog.lock'
$Port     = 8765

function Stop-Pid($processId, $label) {
    try {
        $proc = Get-Process -Id $processId -ErrorAction Stop
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Write-Host "  Stopped $label ($($proc.ProcessName), pid $processId)."
        return $true
    } catch {
        return $false
    }
}

# --------------------------------------------------------------------------- #
# 1. The watchdog
# --------------------------------------------------------------------------- #

$stoppedWatchdog = $false

if (Test-Path $LockPath) {
    try {
        $lockPid = (Get-Content $LockPath -Raw | ConvertFrom-Json).pid
        if ($lockPid) { $stoppedWatchdog = Stop-Pid $lockPid 'the watchdog' }
    } catch { }
    Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}

# The lock can be stale or missing, so sweep for the process itself too.
try {
    $strays = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -and $_.CommandLine -match 'watchdog\.py' })
    foreach ($stray in $strays) {
        if (Stop-Pid $stray.ProcessId 'a stray watchdog') { $stoppedWatchdog = $true }
    }
} catch { }

if (-not $stoppedWatchdog) { Write-Host '  No watchdog was running.' }

# --------------------------------------------------------------------------- #
# 2. The server
# --------------------------------------------------------------------------- #

$holders = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
             Select-Object -ExpandProperty OwningProcess -Unique)

if (-not $holders) {
    Write-Host "  Nothing is listening on $Port."
} else {
    foreach ($holder in $holders) {
        if (-not (Stop-Pid $holder "the server on port $Port")) {
            Write-Host "  Could not stop pid $holder."
        }
    }
}
