# Creates "LocalFaves" shortcuts on your Desktop and in the Start menu.
$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Host "Electron isn't installed yet. Run 'npm install' in $root first." -ForegroundColor Yellow
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
$places = @(
  [Environment]::GetFolderPath('Desktop'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'LocalFaves.lnk'))
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$root`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $root 'assets\icon.ico')
  $lnk.Description = 'Start your local dev sites'
  $lnk.Save()
  Write-Host "Shortcut created in $dir"
}
