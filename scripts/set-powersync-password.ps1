# Sets a fresh random password on the powersync_role database role. Run from the
# repo root, in YOUR OWN terminal (not through an agent):
#
#   pwsh -File scripts\set-powersync-password.ps1          # clipboard only
#   pwsh -File scripts\set-powersync-password.ps1 -Show    # ALSO print it, for
#                                                          # typing into another PC
#
# (Use pwsh, not powershell.exe — Windows PowerShell 5.1 misparses this file's
# UTF-8 em dashes without a BOM and dies with a bogus "missing terminator".)
#
# -Show exists because the PowerSync dashboard may be open on a DIFFERENT
# computer than this repo: the clipboard does not cross machines, so you read
# the password off this terminal and type it into the other PC's Password field.
# Only run -Show in a terminal an agent is not reading.
#
# Alphanumeric only (32 chars, ~190 bits): deliberately no special characters so
# it can never be mangled by URI encoding, shell quoting, or bracket confusion.

param([switch]$Show)

$ErrorActionPreference = "Stop"

# 1. Generate: 32 chars from [A-Za-z0-9] using a cryptographic RNG.
$chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$pw = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })

# 2. Apply to the database via the already-linked Supabase CLI.
Write-Host "Setting password on powersync_role (production)..." -ForegroundColor Cyan
$out = npx supabase db query --linked "alter role powersync_role with password '$pw'" 2>&1 | Out-String

if ($out -match '"_tag"\s*:\s*"Error"' -or $out -match "error") {
    Write-Host "FAILED — the database did not accept the change:" -ForegroundColor Red
    Write-Host $out
    exit 1
}

# 3. Clipboard always; screen only on -Show.
Set-Clipboard -Value $pw
Write-Host ""
Write-Host "DONE. Password set on the database and copied to this PC's clipboard." -ForegroundColor Green
if ($Show) {
    Write-Host ""
    Write-Host "  $pw" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Type it into the PowerSync Password field on the other computer,"
    Write-Host "then clear this terminal (cls). Re-run this script anytime to rotate."
} else {
    Write-Host "Paste it (Ctrl+V) into PowerSync's Password field now."
    Write-Host "It was not displayed - if you lose it, just re-run this script."
}
