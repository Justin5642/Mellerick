# Shipping Mellerick Field — what is ready, what needs an account

The app builds, signs (see the warning below), and runs. Everything blocking a
store release needs a credential or an account that only the owner can create.
This file is the exact sequence, with the reasons a step exists.

## Identifiers (already set, do not change casually)

| | |
|---|---|
| Bundle ID (iOS) / package (Android) | `au.com.mellerick.field` |
| EAS project | `2a14a6a0-9d24-493b-97c1-5a72273e20b4` (owner `justin5642`) |
| Slug | `mellerick-field` |
| Version | `1.0.0` (build numbers auto-increment via `appVersionSource: remote`) |

Changing the bundle ID after a store listing exists creates a *different app* —
users cannot update across it.

## ⚠ Signing — the one real ship-blocker

A local `assembleRelease` currently produces an APK signed with the **Android
debug certificate** (`CN=Android Debug`). Google Play rejects that outright.
Verified with:

```
apksigner verify --print-certs android/app/build/outputs/apk/release/app-release.apk
```

Two ways to fix it. **This is a decision the owner must make, because it
determines who holds the key that can ever update the app.**

1. **EAS-managed credentials (recommended).** `eas build --profile production`
   generates and stores the upload keystore in your Expo account; you never
   handle a key file. Losing access means recovering the Expo account, not the
   app. `eas.json` already assumes this path.
2. **Local keystore.** Generate `mellerick-upload.keystore`, reference it from
   `android/gradle.properties` (gitignored), and back it up somewhere durable.
   **Lose this file and the app can never be updated on Play — ever.** No
   recovery exists short of publishing a new listing.

Until one is chosen, do not treat the local release APK as shippable.

## Accounts required (none exist yet)

| Account | Cost | Needed for |
|---|---|---|
| Apple Developer Program | ~USD 99/yr | TestFlight + App Store |
| Google Play Developer | USD 25 once | Internal testing + Play Store |
| FCM (Android push) | free | `expo-notifications` on Android |
| APNs key (iOS push) | included with Apple Developer | push on iOS |

Push is fully implemented in-app; it simply cannot deliver without credentials.

## ⚠ STEP ZERO — Supabase credentials must exist in EAS, not just on your machine

**Do this before the first cloud build, or the build produces a brick.**

`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are inlined by
Expo at BUILD time. They live in `mobile/.env`, which is gitignored — and EAS
Cloud builds from a **git archive**, so it never sees that file. Until 4 August
2026 no build profile declared them either, which means `eas build --profile
production` — the exact command below — would have shipped an app pointed at
`undefined`: it installs, launches, renders, and then fails every request with
errors that look like a network fault rather than a missing key.

The app now refuses to start in that state and names the missing variable
(`mobile/lib/env.ts`), so the failure is loud and immediate instead of appearing
on a technician's phone. Setting the values is still your job:

```bash
eas env:create --scope project --environment production \
  --name EXPO_PUBLIC_SUPABASE_URL --value "https://<project>.supabase.co"

eas env:create --scope project --environment production \
  --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "<anon key>"

# repeat with --environment preview for the preview profile
eas env:list --environment production        # verify before building
```

The build profiles in `eas.json` declare which environment they draw from
(`production` → production, `development`/`preview` → preview). The anon key is
public by design — it ships inside every bundle — so this is about the build
working at all, not about secrecy.

## Build → submit sequence

```bash
# 1. Production builds (cloud; no local Android/Xcode toolchain needed)
eas build --profile production --platform android    # → .aab for Play
eas build --profile production --platform ios        # → .ipa for App Store

# 2. Fill the submit identifiers in eas.json first (see below), then
eas submit --profile production --platform android
eas submit --profile production --platform ios
```

`eas.json` → `submit.production` still contains placeholders that must be
replaced once the accounts exist:

- `appleId` — the Apple ID email used for the Developer Program
- `ascAppId` — App Store Connect's numeric app ID (created with the listing)
- `appleTeamId` — the 10-character team ID from the Apple developer portal
- `serviceAccountKeyPath` — a Play Console service-account JSON, kept **out of
  git** (`play-service-account.json` is gitignored)

The Android production profile builds an **app-bundle** (`.aab`), which is what
Play requires; the local `.apk` path remains for sideloaded testing only.

## Store listing assets still to produce

Screenshots (phone + tablet, both platforms), a 512×512 icon, a feature graphic
for Play, a privacy-policy URL, and the data-safety / App Privacy declarations.
The app collects location (background, for geofenced auto clock-in), photos, and
customer contact data — declare all three honestly; background location in
particular draws review scrutiny and needs a clear justification string.

## Pre-submission checklist

- [ ] Signing decision made and the release build re-signed accordingly
- [ ] `npm test` green (327 tests), `npx tsc --noEmit` clean
- [ ] `.maestro` flows run against a **release** build with a technician account
      (flow 04 requires it — airplane mode severs Metro, so a dev client cannot
      load its bundle offline)
- [ ] PowerSync instance on a paid plan if production sync volume exceeds the
      free tier
- [ ] Development tokens **disabled** on the PowerSync instance before launch
      (they are currently ON, deliberately, for diagnostics)
