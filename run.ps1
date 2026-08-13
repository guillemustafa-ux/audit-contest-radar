# Wrapper invoked by Task Scheduler. Resolves node, runs the radar, appends to radar.log.
# Keeps its own log so a failed run leaves evidence even when nobody is watching.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $here 'radar.log'

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
}

try {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        Write-Log 'FATAL: node not found on PATH'
        exit 1
    }

    if (-not $env:TELEGRAM_BOT_TOKEN) {
        Write-Log 'WARN: TELEGRAM_BOT_TOKEN not set for this process; the run will fail at notify time'
    }

    $output = & $node (Join-Path $here 'check.mjs') 2>&1 | Out-String
    foreach ($l in ($output -split "`r?`n")) {
        if ($l.Trim()) { Write-Log $l.Trim() }
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Log "FATAL: check.mjs exited with $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}
catch {
    Write-Log ("FATAL: " + $_.Exception.Message)
    exit 1
}
