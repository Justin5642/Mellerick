# Google Play Console — listing + Data Safety

## Store listing
- **App name:** Mellerick Field
- **Short description (≤80):** Field-service jobs, offline: clock on, photos, signatures, sync.
- **Full description:** (reuse the App Store description in `app-store-connect.md`.)
- **Category:** Business · **Tags:** field service, productivity
- **Contact email:** `<SUPPORT_EMAIL>`
- **Privacy Policy URL:** `<PRIVACY_POLICY_URL>` (host `privacy-policy.md`)
- **Feature graphic:** 1024×500 (needed) · **Screenshots:** phone + tablet (capture on device)

## Data Safety form — answers
Single source of truth: `store/README.md`.

**Does your app collect or share user data?** Yes (collects; does not share for
advertising). **Is all data encrypted in transit?** Yes (HTTPS/TLS). **Do you provide
a way to request data deletion?** Yes — via the organisation's account admin /
`<SUPPORT_EMAIL>`.

Data collected (all **collected**, none **shared** with third parties for ads;
transcription is a processor, not sharing):
| Play data type | Collected | Purpose | Optional |
|---|---|---|---|
| Personal info → Email address | Yes | Account management | No |
| Location → Precise location | Yes | App functionality (geo-tag, auto clock) | Yes |
| Photos and videos | Yes | App functionality | Yes |
| Audio → Voice or sound recordings | Yes | App functionality (voice reports) | Yes |
| App activity / other → Job & business records | Yes | App functionality | No |

**No** advertising or analytics identifiers; **no** third-party ad SDKs; **no**
cross-app tracking.

## Content rating (IARC questionnaire)
Business/utility app, no user-to-user public content, no violence/sexual/gambling
content → **Everyone**. Answer "No" to all sensitive-content questions.

## Target audience
Adults (business/professional tool). Not directed at children.

## App access (review credentials)
Most of the app is behind a login. Provide reviewers a seeded demo account
(`<REVIEW_EMAIL> / <REVIEW_PASSWORD>`) under "App access → All or some functionality
is restricted".
