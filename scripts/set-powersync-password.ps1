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
# Format: pronounceable lowercase passphrase (three 3-syllable words + 2 digits,
# e.g. kelupora-mitavesu-ranofi-42). Easy to read off one screen and type on
# another; ~66 bits, which is ample against an online-only attack surface, and
# nothing in it needs URI encoding, shell quoting, or Shift.

param([switch]$Show)

$ErrorActionPreference = "Stop"

# The Supabase CLI link lives in the repo (supabase/.temp), so run from there
# regardless of where the user invoked this script.
Set-Location (Join-Path $PSScriptRoot "..")

# 1. Generate: 9 consonant-vowel syllables (20x5 = 100 options each, ~6.6 bits)
# in 3 hyphenated words, plus a 2-digit suffix: ~66 bits total, all typeable.
function Get-Rand([int]$max) {
    # Uniform crypto-random int in [0, $max)
    [System.Security.Cryptography.RandomNumberGenerator]::GetInt32($max)
}
$consonants = "bcdfghjklmnprstvwxyz"
$vowels = "aeiou"
$words = 1..3 | ForEach-Object {
    -join (1..3 | ForEach-Object {
        "$($consonants[(Get-Rand 20)])$($vowels[(Get-Rand 5)])"
    })
}
$pw = ($words -join "-") + "-" + ((Get-Rand 90) + 10)

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
