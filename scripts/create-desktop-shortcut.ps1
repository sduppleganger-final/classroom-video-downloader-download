$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$electronExe = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$electronMain = Join-Path $projectRoot "electron\main.js"
$iconPath = Join-Path $projectRoot "assets\app-icon.ico"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Video Downloader.lnk"

if (-not (Test-Path $electronExe)) {
  throw "Electron is not installed. Run npm install first."
}

if (-not (Test-Path $electronMain)) {
  throw "Electron entry point not found: $electronMain"
}

if (-not (Test-Path $iconPath)) {
  throw "App icon not found: $iconPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electronExe
$shortcut.Arguments = "`"$electronMain`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = $iconPath
$shortcut.Description = "Open the classroom video downloader desktop app"
$shortcut.Save()

Write-Output "Created desktop shortcut: $shortcutPath"
