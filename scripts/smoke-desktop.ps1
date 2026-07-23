$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electronCmd = Join-Path $projectRoot "node_modules\.bin\electron.cmd"
$electronMain = Join-Path $projectRoot "electron\main.js"

if (-not (Test-Path $electronCmd)) {
  throw "Electron command not found. Run npm install first."
}

$env:ELECTRON_SMOKE_TEST = "1"
if (-not $env:ELECTRON_CAPTURE_PATH) {
  $env:ELECTRON_CAPTURE_PATH = Join-Path $env:TEMP "video-downloader-electron-smoke.png"
}
& $electronCmd "--smoke-test" $electronMain
exit $LASTEXITCODE
