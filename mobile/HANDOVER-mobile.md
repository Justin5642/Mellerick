# Mellerick Mobile — Handover

Expo SDK 54 / React Native 0.81 app on branch `mobile/full-parity`. Offline-first
field app + a full office/admin surface mirroring the web app.

> Companion docs: **`DECISIONS-FOR-AVI.md`** — every decision (D1–D68) and open
> question (Q1–Q19) flagged during the build; **`GAP-ANALYSIS.md`** — a per-area
> gap/drift map vs the web app. **In-repo feature work is complete** — every area is
> at full parity or has only external-gate / native-dep / one-flagged-decision work.

## Verified state
- **195 unit/component tests green** (`npm test`), **`tsc --noEmit` clean**,
  **`expo export --platform ios` bundles clean**.
- Hardened by **10+ adversarial multi-agent reviews** (~55 real defects found and
  fixed, incl. several data-loss and money-safety bugs); the money math is verified
  **byte-for-byte** against the web (D55, re-verified D66).
- **Not yet run on a device** — there is no simulator in the build environment, so
  every screen's interactive behaviour is unverified on hardware (see Gates).

## What's built
- **Offline write engine** — durable SQLite outbox, idempotent replay, exponential
  backoff, dead-letter + dependency-cascade, and a global sync-status badge with
  tap-to-retry.
- **Tech field app (offline) — the full core is outbox-backed:** Time (clock-in/out
  + manual/edit), Photos (attachment queue), Notes, Signature + Voice-report (job
  completion), **Variations** (offline submit with photo attachment, D68), Backflow
  device register (offline, D46).
- **Role-aware navigation** — expo-router `Stack.Protected`; technicians get the
  field tabs, office/admin get a 5-tab shell (Dashboard · Jobs · Schedule ·
  Approvals · More) + a More hub. Forbidden routes are never registered.
- **Office/admin — all areas at full parity:** Dashboard, Jobs (search + pagination
  + **create/edit title/type/status/priority** + **schedule-dispatch** reassign/
  reschedule + **equipment-usage** + **variation price+approve**), Schedule,
  Approvals (approve→auto-draft-invoice + send-back), Customers (+sites CRUD + **360**
  + quick-create + **favourites**), Quotes (builder + accept/decline + **convert-to-
  job**), Invoices (builder + Ready-to-Invoice queue + **create-from-job reconcile**),
  Pricing (CRUD + reactivate), Inventory (CRUD + low-stock + margin), Fleet/Equipment
  (CRUD + assign + expenses + usage + **documents view**), Staff (roles/pay/charge-out
  /leave), **Reports (all 5 analytics tables + KPIs)**, Settings (variation types +
  cost-centre templates + integration status).
- **Job Billing** (office) — line items (add/remove) + **expense capture** (add/remove
  with image-receipt upload + view) + **equipment-usage** (log + priced total, D63/D66)
  + POs (read) + totals; **admin job costing / profitability** (fully-loaded labour +
  materials + equipment vs invoiced/projected margin, money math ported verbatim +
  TDD-locked).
- **Read-repository layer** (`lib/data/reads/`) — every screen reads through it, so
  an offline cache / PowerSync drops in with no per-screen refactor.
- **Money safety** — every dollar renders through role-gated `MoneyText`; financial
  tables are office/admin only (RLS + `Stack.Protected`).

## Architecture map
- `lib/data/outbox/` — the offline engine (types, store, sqliteStore, outbox,
  processor). `lib/data/repositories/` — write repos (only place table names for
  writes live). `lib/data/reads/` — read repos. `lib/data/hooks/` — screen hooks.
- `design/components/` — the design system (StatusPill, MoneyText, Button, StatCard,
  JobListRow, FinanceListRow, SyncStatusPill…). `design/guards/` — role gates.
- `app/` — expo-router routes; `app/_layout.tsx` composes the role-aware shell.

## Gates before ship (NOT closable in-repo — need you / the backend / hardware)
1. **Backend Bearer refactor (Jason) — DRAFTED + tested (D72), awaiting review/deploy.**
   Invoice/quote **Send-email / PDF** routes were cookie-only and rejected a mobile
   Bearer token. Now refactored to `requireOfficeOrAdmin(request)` + a new
   `lib/api/caller-client.ts` (`callerClient(request)`) so RLS-scoped DB access works
   for both a mobile Bearer token and a web cookie — the web path is byte-for-byte
   unchanged (the change only *adds* the mobile path). 12 web unit tests, web `tsc`
   clean. **Jason to review + merge + deploy** (untestable end-to-end here); then the
   mobile Send/PDF buttons are a fast follow, and the same pattern applies to the
   **Xero push** routes (which additionally need the Xero OAuth connection).
2. **On-device QA** — first real interactive test is on hardware; a full human QA
   pass (navigation, forms, layout, touch targets, dark mode) is required.
3. **Cross-system e2e** — create on mobile → verify on web/DB (and Maestro/Detox
   automation) — not yet written.
4. **Store accounts** — Apple Developer + Google Play Console (fill the placeholders
   in `eas.json` `submit.production`).
5. **PowerSync DB password** — for true offline *reads* (writes are already durable).
6. **Push credentials (APNs/FCM)** — for notifications (not yet built).
7. **Atomic invoice/quote RPC (Jason)** — hardens the outbox+draft mitigation (D30).

## Not yet built — and why (nothing here is a plain in-repo feature gap)
- **Offline reads cache / PowerSync connection** — writes are already durable; true
  offline *reads* need the PowerSync Cloud instance + DB password (MP3 blocker).
- **Push notifications** + **background auto-clock** — need Expo push credentials +
  the `development` EAS dev client (MP9, hardware/accounts).
- **Backflow test-log offline (Q3)** — the water-authority submit must be
  dedupe-guarded server-side before the test-submit can be safely replayed; left
  online-direct. The one open in-repo item, blocked on a flagged decision.
- **Document upload** (job + equipment) — view/open is done (D67); upload needs a
  native file/PDF picker that can't be device-QA'd here, so deferred to web.
- **PO / cost-centre editing** + **customer/site reassignment on a job** — display/
  read done; the write cascade stays a web action.
- **MP1 dollar-leak RLS tightening** — migration `0035` + role-impersonation test are
  drafted (D39) but **must be applied + tested by Jason on the live DB** (untestable
  from this repo). This is the real security boundary behind the `MoneyText` UI gate.

## How to run / build
```bash
cd mobile
npm ci
npm test            # unit/component
npm run typecheck   # tsc --noEmit
npx expo export --platform ios   # bundle check
npx expo start      # dev (Expo Go for most; background location needs the dev client)
```
Env: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`,
`EXPO_PUBLIC_API_BASE_URL` (for the Bearer web-API side-effects).

### EAS
```bash
eas build --profile development --platform ios   # dev client (background location)
eas build --profile preview --platform android   # internal APK
eas build --profile production --platform all
eas submit --profile production --platform ios    # after filling eas.json placeholders + accounts
```
