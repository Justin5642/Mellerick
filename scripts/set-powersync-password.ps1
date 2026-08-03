# Sets a fresh random password on the powersync_role database role. Run from the
# repo root, in YOUR OWN terminal (not through an agent):
#
#   pwsh -File scripts\set-powersync-password.ps1          # clipboard only
#   pwsh -File scripts\set-powersync-password.ps1 -Show    # ALSO print it, for
#                                                          # typing into another PC
#   pwsh -File scripts\set-powersync-password.ps1 -Prompt  # type your OWN password
#
# -Prompt exists because a generated passphrase is unmemorable and you may want
# one you can retype from memory into the dashboard. It is read with masked
# input, asked for twice, and NEVER printed, logged, or put on the clipboard —
# so it is safe to use in a terminal an agent is reading. You are trading ~66
# bits of entropy for memorability; the role is reachable only over TLS from
# PowerSync Cloud, so pick something long rather than something clever.
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

param([switch]$Show, [switch]$Prompt)

$ErrorActionPreference = "Stop"

# The Supabase CLI link lives in the repo (supabase/.temp), so run from there
# regardless of where the user invoked this script.
Set-Location (Join-Path $PSScriptRoot "..")

function ConvertFrom-Secure([System.Security.SecureString]$s) {
    [System.Net.NetworkCredential]::new('', $s).Password
}

if ($Prompt) {
    # 1a. Read the operator's own password. Masked, entered twice, never echoed
    # and never placed on the clipboard — the whole point is that it does not
    # appear anywhere it could be read back.
    $pw = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $a = ConvertFrom-Secure (Read-Host "New powersync_role password" -AsSecureString)
        $b = ConvertFrom-Secure (Read-Host "Confirm it" -AsSecureString)

        if ($a -cne $b) { Write-Host "They do not match. Try again." -ForegroundColor Yellow; continue }
        if ($a.Length -lt 11) { Write-Host "Too short - use at least 11 characters." -ForegroundColor Yellow; continue }
        # A backslash is legal in Postgres but bites you later when the same
        # password is pasted into connection URIs; a newline cannot survive the
        # round trip at all. Reject both rather than fail confusingly downstream.
        if ($a -match '[\r\n]') { Write-Host "No line breaks, please." -ForegroundColor Yellow; continue }
        if ($a -match '\\')     { Write-Host "Avoid backslashes - they break connection strings later." -ForegroundColor Yellow; continue }

        $pw = $a
        break
    }
    if (-not $pw) { Write-Host "Giving up after 3 attempts - nothing was changed." -ForegroundColor Red; exit 1 }
} else {
    # 1b. Generate: 9 consonant-vowel syllables (20x5 = 100 options each, ~6.6 bits)
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
}

# 2. Apply to the database via the already-linked Supabase CLI.
# Double any single quote: the generated form never contains one, but a
# -Prompt password can, and an unescaped quote would either error or terminate
# the literal early and set a DIFFERENT password than the one entered.
$pwSql = $pw -replace "'", "''"
Write-Host "Setting password on powersync_role (production)..." -ForegroundColor Cyan
$out = npx supabase db query --linked "alter role powersync_role with password '$pwSql'" 2>&1 | Out-String

if ($out -match '"_tag"\s*:\s*"Error"' -or $out -match "error") {
    Write-Host "FAILED — the database did not accept the change:" -ForegroundColor Red
    Write-Host $out
    exit 1
}

# 3. Clipboard always; screen only on -Show. Under -Prompt, neither: you chose
# it, so putting it on the clipboard or the screen would only widen exposure.
if ($Prompt) {
    Write-Host ""
    Write-Host "DONE. Password set on the database. Not shown, not copied." -ForegroundColor Green
    Write-Host ""
    Write-Host "Now, in the PowerSync dashboard, in this order:"
    Write-Host "  1. Edit Database Connection -> Password -> type the same password"
    Write-Host "  2. Test Connection -> wait for green"
    Write-Host "  3. Update/Deploy"
    Write-Host ""
    Write-Host "Replication is DOWN until step 3 completes." -ForegroundColor Yellow
    exit 0
}

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
