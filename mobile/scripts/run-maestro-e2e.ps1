# Runs the Maestro e2e flows against the running emulator, prompting for test
# credentials interactively (hidden input) so they never appear in any
# transcript, shell history, or file. Run in YOUR OWN terminal:
#
#   pwsh -File mobile\scripts\run-maestro-e2e.ps1              # all flows
#   pwsh -File mobile\scripts\run-maestro-e2e.ps1 -Only 02     # one flow by prefix
#
# Prereqs: emulator running with the app installed; Metro up for dev builds.
# Maestro CLI location is auto-detected from the session scratchpad install or
# a MAESTRO_HOME env var.

param([string]$Only)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

# Maestro finds devices through adb, so the SDK must be on PATH for THIS process
# — never assume the parent shell has it (a terminal opened before the SDK was
# installed will report "0 devices connected" while the emulator runs happily).
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk" }
$env:PATH = "$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator;$env:PATH"

$devices = & "$env:ANDROID_HOME\platform-tools\adb.exe" devices | Select-String "\tdevice$"
if (-not $devices) {
  Write-Host "No device visible to adb. Start one with:" -ForegroundColor Red
  Write-Host "  & `"$env:ANDROID_HOME\emulator\emulator.exe`" -avd mellerick" -ForegroundColor Yellow
  exit 1
}
Write-Host "Device(s): $($devices -join ', ')" -ForegroundColor DarkGray

$maestro = if ($env:MAESTRO_HOME) { Join-Path $env:MAESTRO_HOME "bin\maestro.bat" }
           else { Get-ChildItem "$env:LOCALAPPDATA\Temp\claude" -Recurse -Filter maestro.bat -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
if (-not $maestro -or -not (Test-Path $maestro)) { Write-Host "maestro.bat not found - set MAESTRO_HOME" -ForegroundColor Red; exit 1 }

function Read-Cred([string]$label) {
  $s = Read-Host -AsSecureString $label
  [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

$env:ADMIN_EMAIL = Read-Host "Admin email"
$env:ADMIN_PASSWORD = Read-Cred "Admin password (hidden)"
$env:TECH_EMAIL = Read-Host "Technician email (blank to skip tech flows)"
if ($env:TECH_EMAIL) { $env:TECH_PASSWORD = Read-Cred "Technician password (hidden)" }

$flows = Get-ChildItem ".maestro\flows\*.yaml" | Where-Object {
  (-not $Only -or $_.Name.StartsWith($Only)) -and
  ($env:TECH_EMAIL -or $_.Name -notmatch "technician|offline")
}
$failed = 0
foreach ($f in $flows) {
  Write-Host "`n=== $($f.Name) ===" -ForegroundColor Cyan
  & $maestro test $f.FullName
  if ($LASTEXITCODE -ne 0) { $failed++ }
}
Write-Host "`n$($flows.Count) flow(s) run, $failed failed." -ForegroundColor $(if ($failed) { "Red" } else { "Green" })
exit $failed
