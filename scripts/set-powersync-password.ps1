# Sets a fresh random password on the powersync_role database role. Run from the
# repo root, in YOUR OWN terminal (not through an agent):
#
#   pwsh -File scripts\set-powersync-password.ps1          # clipboard + local file
#   pwsh -File scripts\set-powersync-password.ps1 -Show    # ALSO print it, for
#                                                          # typing into another PC
#   pwsh -File scripts\set-powersync-password.ps1 -Prompt  # type your OWN password
#   pwsh -File scripts\set-powersync-password.ps1 -DryRun  # generate + write file
#                                                          # WITHOUT touching the DB
#
# WHAT IT WRITES, and why there are two copies. The generated password is put on
# the clipboard AND written to POWERSYNC_NEW_PASSWORD.local.txt in the repo root
# (gitignored). The file exists because the clipboard is fragile: on 2026-08-12 a
# recovery failed because signing in to a dashboard put an account password on the
# clipboard, overwriting this one, and the wrong value was pasted. A file cannot be
# clobbered by the next copy. DELETE the file once you have pasted the password.
#
# -Prompt exists because a generated passphrase is unmemorable and you may want
# one you can retype from memory into the dashboard. It is read with masked
# input, asked for twice, and NEVER printed, logged, written to the file, or put
# on the clipboard — so it is safe to use in a terminal an agent is reading. You
# are trading ~66 bits of entropy for memorability; the role is reachable only
# over TLS from PowerSync Cloud, so pick something long rather than something clever.
#
# (Use pwsh, not powershell.exe — Windows PowerShell 5.1 misparses this file's
# UTF-8 em dashes without a BOM and dies with a bogus "missing terminator".)
#
# -Show exists because the PowerSync dashboard may be open on a DIFFERENT
# computer than this repo: the clipboard does not cross machines, so you read
# the password off this terminal and type it into the other PC's Password field.
# Only run -Show in a terminal an agent is not reading.
#
# THE STATEMENT GOES THROUGH A FILE, not the command line. Passing the ALTER
# inline made cmd.exe re-parse it and expand %VAR%, so a -Prompt password
# containing a percent sign silently set a DIFFERENT password than the one typed.
# A temp .sql file removes the command line from the path entirely.
#
# Format: pronounceable lowercase passphrase (three 3-syllable words + 2 digits,
# e.g. kelupora-mitavesu-ranofi-42). Easy to read off one screen and type on
# another; ~66 bits, which is ample against an online-only attack surface, and
# nothing in it needs URI encoding, shell quoting, or Shift.

param([switch]$Show, [switch]$Prompt, [switch]$DryRun)

$ErrorActionPreference = "Stop"

# The Supabase CLI link lives in the repo (supabase/.temp), so run from there
# regardless of where the user invoked this script.
Set-Location (Join-Path $PSScriptRoot "..")

function ConvertFrom-Secure([System.Security.SecureString]$s) {
    [System.Net.NetworkCredential]::new('', $s).Password
}

if ($Prompt) {
    # 1a. Read the operator's own password. Masked, entered twice, never echoed
    # and never placed on the clipboard or the file — the whole point is that it
    # does not appear anywhere it could be read back.
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

# 2. Apply to the database via the already-linked Supabase CLI, using a FILE so
# the statement never touches a command line (see header). Double any single
# quote: the generated form never contains one, but a -Prompt password can, and
# an unescaped quote would terminate the literal early and set a DIFFERENT
# password than the one entered.
$pwSql = $pw -replace "'", "''"
if ($DryRun) {
    Write-Host "[dry-run] Skipping the database change; nothing was set on powersync_role." -ForegroundColor Yellow
} else {
    Write-Host "Setting password on powersync_role (production)..." -ForegroundColor Cyan
    $sqlFile = Join-Path ([System.IO.Path]::GetTempPath()) "mellerick-set-powersync-$PID.sql"
    Set-Content -LiteralPath $sqlFile -Value "alter role powersync_role with password '$pwSql';" -NoNewline -Encoding utf8
    try {
        $out = npx supabase db query --linked --file $sqlFile 2>&1 | Out-String
    } finally {
        Remove-Item -LiteralPath $sqlFile -ErrorAction SilentlyContinue
    }
    # Trust the CLI's exit code, not a string match. And NEVER print $out raw on
    # failure: the CLI can echo the statement it ran, which contains the password.
    # Redact the password out of anything shown.
    if ($LASTEXITCODE -ne 0) {
        $redacted = ($out -replace [regex]::Escape($pw), "********")
        Write-Host "FAILED - the database did not accept the change:" -ForegroundColor Red
        Write-Host $redacted
        exit 1
    }
}

# 3. Deliver the password. Under -Prompt: neither clipboard, file, nor screen —
# you chose it, so putting it anywhere would only widen exposure.
if ($Prompt) {
    Write-Host ""
    Write-Host "DONE. Password set on the database. Not shown, not copied, not saved." -ForegroundColor Green
    Write-Host ""
    Write-Host "Now, in the PowerSync dashboard, in this order:"
    Write-Host "  1. Edit Database Connection -> Password -> type the same password"
    Write-Host "  2. Test Connection -> wait for green (auth cache can lag ~1 min - retry)"
    Write-Host "  3. Update/Deploy"
    Write-Host ""
    Write-Host "Replication is DOWN until step 3 completes." -ForegroundColor Yellow
    exit 0
}

# Clipboard AND a gitignored file. The file is the reliable copy; the clipboard
# is convenience and can be clobbered by the next thing you copy. A dry run skips
# the clipboard so it cannot disturb what you already have copied.
if (-not $DryRun) { Set-Clipboard -Value $pw }
$pwFile = Join-Path (Get-Location) "POWERSYNC_NEW_PASSWORD.local.txt"
Set-Content -LiteralPath $pwFile -Value $pw -NoNewline -Encoding utf8

Write-Host ""
if ($DryRun) {
    Write-Host "[dry-run] DONE. A password was generated and saved locally, but the" -ForegroundColor Yellow
    Write-Host "          database was NOT changed. Delete the file below." -ForegroundColor Yellow
} else {
    Write-Host "DONE. Password set on the database." -ForegroundColor Green
}
Write-Host ""
if (-not $DryRun) { Write-Host "  - copied to this PC's clipboard" }
Write-Host "  - saved to: $pwFile"
Write-Host "    ^ open that file, copy the password from it, and DELETE it after pasting."
if ($Show) {
    Write-Host ""
    Write-Host "  $pw" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Then, in the PowerSync dashboard (Development instance -> Database Connections -> Edit):"
Write-Host "  1. Password field -> paste (Ctrl+V), or copy from the file above"
Write-Host "  2. Test Connection -> wait for green (auth cache can lag ~1 min - retry if it fails instantly)"
Write-Host "  3. Update Connection"
Write-Host ""
Write-Host "Replication stays DOWN until step 3. Re-run this script anytime to rotate." -ForegroundColor Yellow
