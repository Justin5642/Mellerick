# App Store Connect — listing + privacy

## Listing
- **App name:** Mellerick Field
- **Subtitle (≤30 chars):** Field service, offline-ready
- **Primary category:** Business · **Secondary:** Productivity
- **Promotional text (≤170):** Run jobs from the field — clock on, capture photos and
  signatures, log variations, and stay in sync even with no signal.
- **Keywords (≤100):** field service,job,technician,plumbing,backflow,timesheet,invoice,quote,offline,trade
- **Support URL:** `<SUPPORT_URL>`
- **Marketing URL (optional):** `<MARKETING_URL>`
- **Privacy Policy URL:** `<PRIVACY_POLICY_URL>` (host `privacy-policy.md`)

### Description
Mellerick Field is the on-the-go companion to the Mellerick office platform for
plumbing and backflow field-service teams.

Technicians:
• See the jobs assigned to you, with site details and directions.
• Clock on and off — automatically when you arrive at or leave a site, or manually.
• Capture job photos, evidence and signatures; record a voice completion report.
• Log variations and backflow device tests.
• Works offline — everything you do in the field is saved on your phone and syncs
  automatically when you're back on signal, with no duplicates.

Office & admin:
• Dashboard, schedule and dispatch; approve completed jobs.
• Customers, quotes, invoices, pricing, inventory and fleet.
• Job costing and reports.

Money figures are only ever shown to office and admin users — technicians never see
pricing, costs or margins.

*Requires a Mellerick account provided by your organisation.*

## App Privacy (nutrition label) — answers
Mirror `store/README.md`. **Tracking: No.** No data is used to track you across apps
or websites; no advertising or analytics SDKs.

Data collected and **linked to your identity**, all for **App Functionality** only:
| Apple data type | Notes |
|---|---|
| Contact Info → Email Address | Sign-in only |
| Location → Precise Location | Optional; site geo-tag + auto clock in/out |
| User Content → Photos or Videos | Job photos / evidence / receipts |
| User Content → Audio Data | Voice completion reports (transcribed) |
| User Content → Other User Content | Job/customer/financial records entered in-app |
| Identifiers → User ID | Account id |

No data types are used for Tracking or Third-Party Advertising.

## Export compliance
Uses only standard HTTPS/TLS (Supabase, Resend) — exempt encryption.
Set `ITSAppUsesNonExemptEncryption = NO`. (Add to app config if EAS doesn't inject it:
`ios.infoPlist.ITSAppUsesNonExemptEncryption: false`.)

## Age rating
4+ (no objectionable content).

## Sign-in for review (App Review needs a working login)
Provide a demo account in App Review notes: `<REVIEW_EMAIL> / <REVIEW_PASSWORD>`
seeded with sample (non-real) data, plus a one-line "this is a B2B tool; accounts are
issued by the customer's organisation."
