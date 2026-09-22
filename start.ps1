# start.ps1
# Build the console, then serve it. One command, correct order, one terminal.
#
# There is only ONE server in this project: uvicorn. It serves the API, the
# auction WebSocket and the compiled frontend from dist/, all on one port.
# `npm run build` is NOT a server -- it compiles and exits. Running it while
# uvicorn is serving rewrites the directory uvicorn is reading from, so this
# script does them in sequence and never at the same time.
#
#   .\start.ps1              build, then serve on 8001
#   .\start.ps1 -SkipBuild   serve only (nothing in the frontend changed)
#   .\start.ps1 -Port 8002   serve on a different port
#   .\start.ps1 -Reload      enable --reload (restarts on .py changes)
#
# -Reload is OFF by default and that is deliberate. A reload kills every open
# WebSocket, which during a live auction disconnects all ten franchises
# mid-lot; and while someone is editing files, it makes the server appear to
# die at random.

param(
    [switch]$SkipBuild,
    [int]$Port = 8001,
    [switch]$Reload
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backend = Join-Path $root 'ipl_auction_rag_backend'
$python = Join-Path $root '.venv\Scripts\python.exe'

function Write-Step($text) {
    Write-Host ''
    Write-Host "==> $text" -ForegroundColor Cyan
}

# --- sanity -----------------------------------------------------------------
if (-not (Test-Path $python)) {
    Write-Host "Python not found at $python" -ForegroundColor Red
    Write-Host "Create the virtualenv first, or edit the path in this script." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $backend)) {
    Write-Host "Backend not found at $backend" -ForegroundColor Red
    exit 1
}

# --- is the port already taken? ---------------------------------------------
# A second server on the same port is the confusing failure: the new one fails
# to bind, and whichever process already held it keeps answering, so a change
# you just made appears not to have taken effect.
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
    $owner = (Get-Process -Id $inUse[0].OwningProcess -ErrorAction SilentlyContinue)
    $name = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($inUse[0].OwningProcess)" }
    Write-Host ''
    Write-Host "Port $Port is already being used by $name." -ForegroundColor Yellow
    Write-Host "Stop that process first, or run:  .\start.ps1 -Port 8002" -ForegroundColor Yellow
    exit 1
}

# --- build ------------------------------------------------------------------
# Before the server starts, never while it is running. The chunk-size warning
# vite prints is expected and harmless -- it is the 3D scene bundle.
if (-not $SkipBuild) {
    Write-Step 'Building the console (npm run build)'
    Push-Location $root
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Build failed. The server was not started.' -ForegroundColor Red
            exit 1
        }
    }
    finally {
        Pop-Location
    }
    Write-Host 'Build complete.' -ForegroundColor Green
}
else {
    Write-Step 'Skipping the build (-SkipBuild)'
}

# --- serve ------------------------------------------------------------------
# The working directory must be the backend package: config/settings.py loads
# `env_file: '.env'`, which pydantic resolves relative to the PROCESS working
# directory. Started from anywhere else the .env is silently not found, and the
# backend comes up with no API keys at all.
Write-Step "Starting the backend on http://localhost:$Port"
Write-Host 'Open that address in a browser. Ctrl+C here stops it.' -ForegroundColor DarkGray
if (-not $Reload) {
    Write-Host 'Auto-reload is off. Restart this script after changing backend .py files.' -ForegroundColor DarkGray
}
Write-Host ''

Push-Location $backend
try {
    $uvicornArgs = @('-m', 'uvicorn', 'api.main:app', '--port', "$Port")
    if ($Reload) { $uvicornArgs += '--reload' }
    & $python @uvicornArgs
}
finally {
    Pop-Location
}
