# Mellerick Mobile — Handover

Expo SDK 54 / React Native 0.81 app. Offline-first field app + a full office/admin
surface mirroring the web app.

**This work is merged.** It was built on `mobile/full-parity`, which is now an
ancestor of `main` (`git merge-base --is-ancestor mobile/full-parity main`
succeeds, verified 11 Aug 2026). Read `main`, not the branch. The branch name
stayed at the top of this file after the merge, which is enough to make a reader
think there is unmerged work to chase.

> Companion docs: **`DECISIONS-FOR-AVI.md`** — every decision (D1–D68) and open
> question (Q1–Q19) flagged during the build; **`GAP-ANALYSIS.md`** — a per-area
> gap/drift map vs the web app. **In-repo feature work is complete** — every area is
> at full parity or has only external-gate / native-dep / one-flagged-decision work.

## Verified state
- **78 suites, 589 tests green** — measured 11 Aug 2026 with `npm test` from
  `mobile/`. This line read "195 unit/component tests" for long enough to be
  wrong by a factor of three; run the command rather than reading the number.
  Use `npm test`, not `npx jest` — the latter can resolve a broken transient.
- **`tsc --noEmit` clean**, **`expo export --platform ios` bundles clean**.
- **`npm run lint`: 0 errors, 7 warnings** — mobile has its own ESLint config and
  a CI gate now (web item N3); the ceiling is pinned at 7 and may only go down.
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

**Two items were struck from this list on 11 Aug 2026 because they had already
landed.** They are kept, struck through, immediately below the live gates: this
document had four entries telling the reader to go and do work that was done,
which is worse than an incomplete list — a real blocker (accounts, credentials,
hardware) reads as one item among five instead of the only thing standing in the
way.

1. **On-device QA** — first real interactive test is on hardware; a full human QA
   pass (navigation, forms, layout, touch targets, dark mode) is required.
2. **Store accounts** — Apple Developer + Google Play Console. Two placeholders are
   left in `eas.json` `submit.production`: `appleId` (`:45`) and `ascAppId` (`:46`).
   `appleTeamId` is filled. Listing copy + privacy manifest are done (`store/`,
   D74) — only accounts, screenshots, and your legal details remain.
3. **PowerSync DB password** — for true offline *reads* (writes are already durable).
4. **Push credentials (APNs/FCM)** — the **client is built + tested** (D75,
   `lib/push/`); to actually deliver a push, add the APNs/FCM credentials via EAS
   and a backend sender (job-assigned → Expo Push API). The app degrades gracefully
   until then. **The database side is done** — see the struck item below.
5. **Cross-system e2e** — the **Maestro flows are authored** (`.maestro/`, D73):
   technician clock-in, office approve, technician money-gating, offline clock-in +
   a login subflow, with a README. They are **not yet executed** here (no
   emulator/seeded backend) — run them on a device/emulator with per-role test
   accounts as part of on-device QA (`maestro test .maestro`). Cross-check
   create-on-mobile → verify-on-web/DB manually alongside.
6. **Atomic invoice/quote RPC** — hardens the outbox+draft mitigation (D30). The SQL
   is now **written**: `supabase/migrations/0050_atomic_replace_helpers.sql`. It is
   one of five drafts merged but **not applied to production** — see
   `../HANDOVER-HARDENING.md` §0 for the full list and the order to apply them in.

### Struck 11 Aug 2026 — already landed, do not go and do these

- ~~**Apply the drafted `supabase/migrations/0036_device_tokens.sql`**~~ — applied
  **2026-08-05**. `0036`'s own header now says so, and adds that its previous
  `PROPOSED (not applied)` header *"was stale and actively misleading: it implied
  push was still waiting on a database change when the table has existed for some
  time, so the real blocker — APNs and FCM credentials — was hidden behind a false
  one."* This document then became that false blocker for six days, in two places
  (the push gate and the *Not yet built* list). The real blocker is, and always was,
  the credentials in gate 4.
- ~~**Backend Bearer refactor (Justin) — awaiting review/deploy**~~ — **merged.**
  `lib/api/caller-client.ts` exists and `callerClient(request)` is used by the
  invoice/quote **send** and **pdf** routes plus the Xero and Google sync routes —
  eight route files, guarded by `tests/unit/caller-client.test.ts` and the
  `*-routes-auth.test.ts` suites. Both a mobile Bearer token and a web cookie get
  RLS-scoped access. The mobile Send/PDF buttons are the fast follow this unblocked.

## Not yet built — and why (nothing here is a plain in-repo feature gap)
- **Offline reads cache / PowerSync connection** — writes are already durable; true
  offline *reads* need the PowerSync Cloud instance + DB password (MP3 blocker).
- **Push notifications** — the **client registration is built + tested** (D75); the
  remaining pieces are the **APNs/FCM credentials and a backend sender**, which need
  accounts. `0036_device_tokens.sql` is **applied** (2026-08-05) — this line asked
  for it twice over. **Background auto-clock** still needs the `development` EAS dev
  client (MP9, hardware).
- **Backflow test-log offline (Q3)** — left online-direct. The blocker was that the
  water-authority submit had to be dedupe-guarded server-side before a replay could
  be safe. **That guard now exists on the web side** — the submit route is idempotent
  with an explicit `force` escape for a deliberate office re-send, covered by
  `tests/unit/backflow-submit-dedupe.test.ts`. What has **not** been verified is the
  mobile half: whether the mobile submit was moved onto the outbox to take advantage
  of it. Check before planning either way.
- **Document upload** (job + equipment) — view/open is done (D67); upload needs a
  native file/PDF picker that can't be device-QA'd here, so deferred to web.
- **PO / cost-centre editing** + **customer/site reassignment on a job** — display/
  read done; the write cascade stays a web action.
- **MP1 dollar-leak RLS tightening** — **done, and it is in force.** Migration `0035`
  was applied and verified in production on **2026-08-05**; its header records the
  impersonation evidence (a technician reads 0 rows from `equipment`,
  `equipment_expenses`, `inventory` and `job_expenses` while an office control reads
  21 / 0 / 0 / 1 — so the zeros are the policy, not an empty table). This line said it
  was "drafted… must be applied + tested by Justin" for six days after that.

  Kept because the sentence that follows it is still exactly right, and is the most
  important sentence in this file: **this is the real security boundary behind the
  `MoneyText` UI gate.** `MoneyText` is a UI convenience. RLS is what refuses the row.
  Do not let a mobile change turn that around.

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
eas build --profile ios-simulator --platform ios  # unsigned .app — NO Apple account needed
eas build --profile preview --platform android    # internal APK
eas build --profile production --platform all
eas submit --profile production --platform ios    # after filling eas.json placeholders + accounts
```

`ios-simulator` is the only iOS build obtainable without an Apple Developer
account: a simulator build is unsigned, so EAS skips Apple credentials entirely.
The artifact runs only in Xcode's Simulator, so producing it needs no Mac but
opening it does.

The line that used to head this list — `eas build --profile development
--platform ios` — **cannot succeed and never could.** That profile sets
`developmentClient: true` (eas.json), and `expo-dev-client` is not a dependency,
so eas-cli stops to ask whether it should install it and exits 1 if declined.
Either run `npx expo install expo-dev-client` first, or use a different profile.

An iOS build on the `development` or `preview` profile is also ad-hoc
distribution, which needs a paid Apple Developer account AND device UDIDs
registered via `eas device:create`. There is no account yet.

Note for anyone on Windows: `npx expo prebuild --platform ios` refuses outright
("Run npx expo prebuild again from macOS or Linux"). That is local-only — EAS
prebuilds on its own macOS workers, so cloud iOS builds are unaffected. To check
what the worker will generate without leaving Windows, use
`npx expo config --type introspect --json`, which runs the same prebuild config
pipeline and prints the resulting Info.plist.
