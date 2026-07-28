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

# Maestro finds devices through adb, so adb must be resolvable from THIS process
# — never assume the parent shell has it (a terminal opened before the SDK was
# installed reports "0 devices connected" while the emulator runs happily).
# Every candidate is probed and reported, so a miss says WHERE it looked.
$tried = @()
$adb = $null
foreach ($root in @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT,
                    "$env:LOCALAPPDATA\Android\Sdk", "$env:USERPROFILE\AppData\Local\Android\Sdk",
                    "$env:ProgramFiles\Android\android-sdk", "C:\Android\Sdk")) {
  if (-not $root) { continue }
  $candidate = Join-Path $root.TrimEnd('\') "platform-tools\adb.exe"
  $tried += $candidate
  if (Test-Path -LiteralPath $candidate) { $adb = $candidate; $env:ANDROID_HOME = $root.TrimEnd('\'); break }
}
if (-not $adb) {
  $onPath = Get-Command adb -ErrorAction SilentlyContinue
  if ($onPath) { $adb = $onPath.Source }
}
if (-not $adb) {
  Write-Host "adb.exe not found. Looked in:" -ForegroundColor Red
  $tried | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  Write-Host "Install the SDK or set ANDROID_HOME, then re-run." -ForegroundColor Yellow
  exit 1
}
$env:PATH = "$(Split-Path $adb);$env:ANDROID_HOME\emulator;$env:PATH"
Write-Host "adb: $adb" -ForegroundColor DarkGray

$devices = & $adb devices | Select-String "device$" | Where-Object { $_ -notmatch "List of devices" }
if (-not $devices) {
  Write-Host "adb sees no device. Start the emulator with:" -ForegroundColor Red
  Write-Host "  & `"$env:ANDROID_HOME\emulator\emulator.exe`" -avd mellerick" -ForegroundColor Yellow
  exit 1
}
Write-Host "device: $(($devices | ForEach-Object { $_.ToString().Trim() }) -join ', ')" -ForegroundColor DarkGray

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
