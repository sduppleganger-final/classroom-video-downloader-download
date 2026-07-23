$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$finalOutput = Join-Path $projectRoot "dist"
$builder = Join-Path $projectRoot "node_modules\electron-builder\out\cli\cli.js"
$maxAttempts = 3
$preferredBuildRoot =
  if ($env:CLASSROOM_VIDEO_PORTABLE_BUILD_ROOT) {
    $env:CLASSROOM_VIDEO_PORTABLE_BUILD_ROOT
  } else {
    "C:\CodexPortableBuilds"
  }
$buildRoot = $preferredBuildRoot
$buildOutput = $null
$buildSucceeded = $false
$lastError = $null

if (-not (Test-Path -LiteralPath $builder)) {
  throw "electron-builder was not found. Run npm install first."
}

Write-Host "Preparing the bundled Whisper Small runtime and model..."
& node (Join-Path $projectRoot "scripts\prepare-whisper.mjs") "--arch=x64"
if ($LASTEXITCODE -ne 0) {
  throw "The bundled Whisper runtime or model could not be prepared."
}

New-Item -ItemType Directory -Force -Path $finalOutput | Out-Null

try {
  New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
} catch {
  Write-Warning "Could not use portable build root $buildRoot. Falling back to $env:TEMP"
  $buildRoot = $env:TEMP
}

for ($attempt = 1; $attempt -le $maxAttempts; $attempt += 1) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
  $buildOutput = Join-Path $buildRoot "cvd-portable-build-$timestamp-attempt-$attempt"
  $buildOutputForBuilder = $buildOutput -replace "\\", "/"

  New-Item -ItemType Directory -Force -Path $buildOutput | Out-Null

  Push-Location $projectRoot
  try {
    Write-Host "Portable build attempt $attempt of $maxAttempts using $buildOutput"
    & node $builder --win portable "--config.directories.output=$buildOutputForBuilder" "--config.compression=normal"

    if ($LASTEXITCODE -eq 0) {
      $buildSucceeded = $true
      break
    }

    $lastError = "electron-builder failed with exit code $LASTEXITCODE."
    Write-Warning $lastError
  } catch {
    $lastError = $_
    Write-Warning "Portable build attempt $attempt failed: $lastError"
  } finally {
    Pop-Location
  }

  if ($attempt -lt $maxAttempts) {
    Start-Sleep -Seconds 2
  }
}

if (-not $buildSucceeded) {
  throw "electron-builder failed after $maxAttempts attempts. Last error: $lastError"
}

$portableExe = Get-ChildItem -LiteralPath $buildOutput -Filter "*.exe" |
  Where-Object {
    $_.Name -like "Classroom Video Downloader*.exe" -or
    $_.Name -like "Classroom.Video.Downloader.*.exe"
  } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $portableExe) {
  throw "Portable executable was not produced in $buildOutput."
}

$destination = Join-Path $finalOutput $portableExe.Name
Copy-Item -LiteralPath $portableExe.FullName -Destination $destination -Force

$copied = Get-Item -LiteralPath $destination
Write-Host "Portable app copied to $($copied.FullName)"
Write-Host "Size: $($copied.Length) bytes"
