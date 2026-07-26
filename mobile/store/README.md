# Store submission pack — Mellerick Field

Draft listing copy, privacy policy, and the App Store / Play Store data-safety
declarations, derived from the app's **actual** data behaviour. Everything here is
ready to paste into App Store Connect / Play Console once the store accounts exist
(a flagged external gate).

> **Fill-in markers:** anything in `<ANGLE_BRACKETS>` is a business/legal detail I
> can't know (legal entity name, support email, hosted policy URL, jurisdiction).
> The client must complete those, and **have the privacy policy reviewed by legal**
> before publishing — it's a legal document, this is a faithful technical draft.

## Contents
- `app-store-connect.md` — iOS listing fields + App Privacy nutrition label + encryption/export answer.
- `play-store.md` — Android listing fields + Data Safety declaration + content rating notes.
- `privacy-policy.md` — the policy text to host at a public URL (both stores require the URL).

## What the app actually collects (single source of truth for both stores)
| Data | Why | Linked to identity | Shared w/ 3rd parties | Optional |
|---|---|---|---|---|
| **Email address** | Account sign-in (Supabase Auth) | Yes | No | No (required to log in) |
| **Precise location** | Geo-tag site photos + auto clock-in/out + travel time | Yes | No | Yes (app works without granting it) |
| **Photos** | Job photos / evidence / receipts | Yes | No | Yes |
| **Audio recordings** | Job-completion voice reports (transcribed) | Yes | Processed by a transcription API | Yes |
| **Job / customer / financial records** | Core field-service workflow | Yes | No | No |
| **Diagnostics/analytics** | **None collected** — no third-party analytics or ad SDKs, no tracking | — | — | — |

Backend: Supabase (Postgres + Storage + Auth), AU region. Transactional email via
Resend. Voice transcription + optional accounting sync (Xero) are triggered only by
office/admin actions. **No advertising, no cross-app tracking** (`NSPrivacyTracking = false`).

## Assets still needed (design/hardware gate)
- App icon is present (`assets/icon.png`); **screenshots** per required device size
  (6.7"/6.5" iPhone, 12.9" iPad, Android phone/tablet) must be captured on a device
  or simulator — part of on-device QA.
- Feature graphic (Play, 1024×500).

## Submission checklist (once accounts + assets exist)
1. Apple Developer + Google Play Console accounts created; fill the placeholders in
   `../eas.json` `submit.production` (Apple ID, ASC app id, Apple team id; Play
   service-account JSON).
2. Host `privacy-policy.md` at a public `<PRIVACY_POLICY_URL>`.
3. Paste the listing copy + data-safety answers below.
4. `eas build --profile production --platform all` → `eas submit --profile production`.
5. TestFlight / Play internal-testing smoke, then submit for review.
