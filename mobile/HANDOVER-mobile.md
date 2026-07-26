# Mellerick Mobile — Handover

Expo SDK 54 / React Native 0.81 app on branch `mobile/full-parity`. Offline-first
field app + a full office/admin surface mirroring the web app.

> Companion doc: **`DECISIONS-FOR-AVI.md`** — every decision (D1–D34) and open
> question (Q1–Q18) flagged during the build, indexed for cleanup.

## Verified state
- **110 unit/component tests green** (`npm test`), **`tsc --noEmit` clean**,
  **`expo export --platform ios` bundles clean**.
- Hardened by **8 adversarial multi-agent reviews** (~48 real defects found and
  fixed, incl. several data-loss and money-safety bugs).
- **Not yet run on a device** — there is no simulator in the build environment, so
  every screen's interactive behaviour is unverified on hardware (see Gates).

## What's built
- **Offline write engine** — durable SQLite outbox, idempotent replay, exponential
  backoff, dead-letter + dependency-cascade, and a global sync-status badge with
  tap-to-retry.
- **Tech field app (offline)** — Time (clock-in/out + manual/edit), Photos
  (attachment queue), Notes, Signature + Voice-report (job completion).
- **Role-aware navigation** — expo-router `Stack.Protected`; technicians get the
  field tabs, office/admin get a 5-tab shell (Dashboard · Jobs · Schedule ·
  Approvals · More) + a More hub. Forbidden routes are never registered.
- **Office/admin — all 13 areas:** Dashboard, Jobs (search + pagination), Schedule,
  Approvals, Customers (+sites CRUD), Quotes (list/detail + **create/edit builder**
  + accept/decline), Invoices (list/detail + Ready-to-Invoice queue + **create/edit
  builder**), Pricing (CRUD), Inventory (CRUD), Fleet/Equipment (CRUD, admin-only
  writes), Staff (admin), Reports (KPI first-pass), Settings (integration status).
- **Job Billing** (office) — line items (add/remove) + **expense capture** (add/remove
  with image-receipt upload + view) + POs (read) + totals.
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
1. **Backend Bearer refactor (Jason)** — invoice/quote **Send-email / PDF / Xero
   push** web routes are cookie-only and reject a mobile Bearer token. Until they
   use `getCallerId(request)` (guards.ts already supports Bearer), those actions are
   unavailable on mobile. *The app is not fully shippable without this.*
2. **On-device QA** — first real interactive test is on hardware; a full human QA
   pass (navigation, forms, layout, touch targets, dark mode) is required.
3. **Cross-system e2e** — create on mobile → verify on web/DB (and Maestro/Detox
   automation) — not yet written.
4. **Store accounts** — Apple Developer + Google Play Console (fill the placeholders
   in `eas.json` `submit.production`).
5. **PowerSync DB password** — for true offline *reads* (writes are already durable).
6. **Push credentials (APNs/FCM)** — for notifications (not yet built).
7. **Atomic invoice/quote RPC (Jason)** — hardens the outbox+draft mitigation (D30).

## Not yet built (in-repo follow-ups)
- Offline **reads** cache / PowerSync connection · **push notifications** ·
  **background auto-clock** (needs the `development` EAS dev client) · **Reports**
  Skia charts · PO/cost-centre editing + labour-cost/margin costing (Q18) · office
  Backflow list (Q12) · admin My-Jobs access (Q13) · MP1 dollar-leak RLS tightening.

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
