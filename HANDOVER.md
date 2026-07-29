# Mellerick — Handover

**For:** Justin (justin@mellerick.com) and whoever maintains this next.
**Updated:** 29 July 2026 — supersedes the 21 July web-only handover.
**Status:** merged to `main`, verified. Not yet published to either app store.

This is the single entry point. It assumes you know TypeScript and Postgres but
nothing about this codebase. Pairs with [README.md](README.md) for first-time
setup.

---

## 1. What exists

Two applications sharing one Supabase backend.

| | Web | Mobile |
|---|---|---|
| Stack | Next.js 15.5, React 19 | Expo SDK 54, React Native 0.81.5, React 19.1.0 |
| Location | repo root (`app/`, `lib/`, `components/`) | `mobile/` |
| Hosting | Vercel (`mellerick-app`), auto-deploys `main` | not yet published |
| Data access | Supabase directly, under the user's session | Supabase + PowerSync local mirror + durable outbox |

The mobile app reaches **feature parity across all 15 web areas**, role-aware for
technician / office / admin, and keeps working with no network connection.

**Node 22 is required.** `.node-version` and `engines` both pin `22.x`. Node 25
crashes the Expo dev server with `RangeError: Too many message fragments` from
`@react-native/dev-middleware` — observed twice, gone after switching to 22. It
also breaks `@supabase/ssr` server-side. Use nvm-windows: `nvm use 22`.

**Two separate npm projects.** Root and `mobile/` have their own lockfiles and no
workspace linking them. Install in the right directory.

---

## 2. The one rule that must never break

**Technicians must never see a dollar figure.**

A contractual requirement, not a preference. Four independent layers enforce it,
each sufficient alone. Do not remove any of them because another covers it.

| Layer | Where | What it does |
|---|---|---|
| 1. Postgres RLS | `supabase/migrations/0027, 0035, 0038` | Money tables restricted to `is_office_or_admin()` |
| 2. **Sync rules** | `mobile/powersync/sync-streams.yaml` | Second authorization surface — see below |
| 3. Route registration | `mobile/app/` route groups | Forbidden routes are *never registered* — no deep-link bypass |
| 4. `MoneyText` / `RoleGate` | `mobile/design/components/` | Structural redaction, not a per-screen `if` |

### Why layer 2 is the dangerous one

**PowerSync replication bypasses Postgres RLS entirely.** It reads the logical
replication stream with its own credentials. Any column in a technician's stream
lands in **plaintext SQLite on that technician's phone**, whatever RLS says.

Treat `sync-streams.yaml` as security code. Re-audited 29 July 2026 — all 11
technician-visible streams are money-free:

- `tech_jobs` — 19 named columns, none monetary
- `tech_job_variations` — omits `rate`, `total_amount`, `admin_notes`
- `variation_types` — omits the preset `rate`
- `tech_time_entries` — omits `rate`
- `profiles`, `customers`, `sites`, `backflow_devices`, `backflow_tests`,
  `tech_job_photos`, `tech_job_notes` — no monetary column in the selected sets

Office/admin streams gate on the caller's own profile row:

```sql
JOIN profiles ON profiles.id = auth.user_id()
WHERE profiles.role = 'office' OR profiles.role = 'admin'
```

This **fails closed** — a technician, or a user with no profile row, joins to
nothing and receives nothing. PowerSync's dialect rejects literal `IN` lists,
which is why it is a JOIN rather than the obvious form.

> **If you add a table to a technician stream, list its columns explicitly.
> Never `SELECT *` on a table that has, or might later gain, a money column.**

### Web-side equivalent

- Three roles: `admin`, `office`, `technician`. RLS is the primary boundary.
- API routes add in-code authorization via [`lib/api/guards.ts`](lib/api/guards.ts):
  `requireUser` / `requireAdmin` / `requireOfficeOrAdmin` / `requireCronSecret`.
  Per-record checks in [`lib/api/job-authz.ts`](lib/api/job-authz.ts).
- The **service-role key** is constructed only in
  [`lib/supabase/admin.ts`](lib/supabase/admin.ts). It bypasses RLS, so **any
  route using it must authorize the caller first**.
- [`lib/api/caller-client.ts`](lib/api/caller-client.ts) — a Bearer token yields a
  client scoped to that caller (RLS runs as them); no token falls back to the
  cookie client unchanged. This is what lets mobile call the web API routes.

---

## 3. How offline works

Reads and writes take different paths. Understand this before touching
`mobile/lib/data/`.

### Reads — local mirror with a fallback

`mobile/lib/data/reads/source.ts` exposes `fromLocalOr(local, remote)`. It serves
from the on-device SQLite mirror **only when that mirror is trustworthy**, and
otherwise runs a byte-identical Supabase query. Fallback reasons, each logged:

`no-local` · `not-synced` · `write-echo` · `role` · `local-threw` · `stale-db`

The local and remote implementations must return **identical shapes**. Each read
module has a test for this; change one side, change both.

### Writes — always through the outbox, never direct

Every mutation is enqueued in a durable SQLite outbox
(`mobile/lib/data/outbox/`) and drained by a processor. No screen writes to
Supabase directly.

Load-bearing properties:

- **Client-generated UUID primary keys** — a replayed insert collides on the PK
  and is recognised as a replay instead of duplicating a row.
- **Dependency chains** — an offline clock-in (insert) then clock-out (update) to
  the same row cannot apply out of order.
- **Attachments upload before their metadata row** — a failed photo upload leaves
  no orphan row and keeps the local file for retry.
- **`23505` handling** (`gateway.supabase.ts`) — swallowed as an idempotent
  replay **only** when the constraint name ends in `_pkey`. A secondary unique
  collision (`inventory.sku`, `variation_types.name`) now throws rather than
  silently discarding a new row. An unattributable `23505` is still treated as a
  replay — deliberate, because throwing would dead-letter a legitimate replay and
  wedge the FIFO queue forever — but it logs a warning naming the table, so a
  vanished row is traceable.

### The crash class to watch for

Async SQLite work that **outlives its JS context** throws
`Cannot use shared object that was already released`. This bit twice.

Cause: a drain awaits the network (session refresh) *before* touching SQLite, so
there is a wide window in which the engine can be torn down — a sign-out, or a
dev reload, which destroys the JS context and every native object with it.

Fix, in `syncEngine.ts`: `stop()` bumps a generation counter; a drain captures
its generation and abandons itself at each await boundary once stale. Queued work
is durable on disk, so abandoning loses nothing.

> **If you add async work that touches SQLite, add the same liveness check.**

Related: `start()` and the reconnect handler launch drains with `void`, so
anything thrown would become an **unhandled rejection — which React Native
renders as a full-screen red box over a working app**. They route errors to an
`onError` sink. `flush()` still rejects, because its callers await it.

---

## 4. Database

Migrations in `supabase/migrations/`, applied in filename order.
`supabase/schema.sql` is the baseline.

**Migrations 0039, 0040 and 0041 are already applied to production.** Merging
does not apply them. They were applied and verified against live data (825 jobs,
row counts unchanged, indexes present).

| Migration | What | Note |
|---|---|---|
| `0039` | Logical replication publication over 24 tables | Required by PowerSync |
| `0040` | `jobs.ready_to_invoice` + partial index | Nine call sites across web and mobile referenced this column and it existed nowhere — the web Ready-to-Invoice queue and sign-off were failing in production |
| `0041` | `admin_status` / `admin_notes` | Captures drift applied by hand |

**`0040` deliberately does not backfill.** Every pre-existing job reads `false`.
Nothing in the historical data distinguishes "was awaiting invoicing" from "was
not", and guessing would inject phantom rows into the office queue.
**Consequence: the Ready-to-Invoice queue contains only jobs signed off after the
migration.** Office staff should be told this.

### The drift guard — read before writing a test

Roughly 430 tests mock Supabase. **A query against a column that does not exist
passes happily.** That is exactly how the two schema bugs above reached
production.

`tests/unit/schema-column-contract.test.ts` parses the real migration history and
fails when source references an uncreated column. Proven by negative control:
remove `0040` and it names all four call sites; restore it and it goes green.

> **Mocked tests cannot catch schema drift. A green suite is not proof that a
> column exists.**

---

## 5. Running it

```bash
nvm use 22
```

**Web**

```bash
npm ci
cp .env.example .env.local     # fill in the Supabase vars
npm run dev
```

Required: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`. `CRON_SECRET` is required in production — it
authenticates the Vercel cron routes declared in `vercel.json`. Everything else
feature-gates an optional integration. Typed accessors in
[`lib/env.ts`](lib/env.ts); annotated list in [.env.example](.env.example).

The build now fails immediately and **by name** if the public vars are missing
(`next.config.ts` calls `assertRequiredEnv()`), instead of dying three steps later
inside `@supabase/ssr` while prerendering an unrelated page.

**Mobile**

```bash
cd mobile && npm ci
npx expo start --dev-client
```

Requires a **custom dev client**, not Expo Go, because of native modules
(op-sqlite, background location). Build one with `npx expo run:android` or
`eas build --profile development`.

**Tests**

```bash
npm test              # web — 111 tests (vitest)
npm run test:rls      # RLS policy tests — needs Docker + local Supabase
npm run test:e2e      # Playwright smoke — needs Docker
cd mobile && npm test # mobile — 345 tests (jest-expo)
```

Use `npm test`, not `npx jest` — `npx` can resolve a broken transient jest.

---

## 6. Verification status, 29 July 2026

Everything below was run on Node 22.23.1, not assumed.

| Check | Result |
|---|---|
| Web tests | **111 passed** (18 files) |
| Mobile tests | **345 passed** (58 suites) |
| `tsc --noEmit`, both projects | clean |
| GitHub CI — build, typecheck, unit, lint, **rls**, **e2e** | all pass |
| Technician sync streams audited for money columns | none found |
| Credentials tracked in git | none. `.gitignore` covers keystore, service-account JSON, `google-services.json`, `GoogleService-Info.plist`, `.env` |
| `TODO` / `FIXME` / `HACK` in shipped source | **0** |
| On-device (Android emulator, production data) | dashboard, offline reads and offline writes all working; no crashes across repeated restarts and forced reloads |

The RLS and E2E suites, which the July handover listed as authored-but-never-run,
now execute and pass in CI.

**Known-red:** Vercel *preview* deployments fail. Configuration, not code — §8.

---

## 7. What is NOT done

None of it is blocked on code.

**Store submission** — neither store account exists. In order:

1. **D-U-N-S number** — free, 1–14 days, required by *both* stores. Everything queues behind it.
2. Apple Developer Program — USD 99/year
3. Google Play Console — USD 25 once

**No iOS build can exist yet.** iOS binaries cannot be compiled on Windows at
all, and EAS cloud build still needs Apple-issued signing certificates, which
require the paid account. There is no unsigned iOS fallback the way there is on
Android. Once the account exists, `eas build --platform ios` produces one.

**Push notifications** — fully implemented and tested; cannot deliver without an
APNs `.p8` from Apple and an FCM service-account JSON from Firebase. The `.p8`
downloads **once only**.

**`mobile/eas.json` placeholders** — `appleId`, `ascAppId`, `appleTeamId` are
still `*_HERE` strings. `eas submit --platform ios` fails until they are filled.

**Store assets** — screenshots (4 per platform, demo-safe data) and an Android
feature graphic (1024×500). Listing copy, privacy answers and the privacy policy
are written and live outside the repo at
`OneDrive - BAS & More/DevOps/Mellerick Plumbing/{Android,Apple}/`, as PDFs and
markdown.

**Signing key** — nothing to prepare. Let **EAS manage credentials**; the upload
keystore is created on the first production build. The alternative, a local
`.keystore`, means losing the file makes the app permanently un-updatable on Play.

**Recommended for v1.0:** ship **when-in-use** location only and add background
"always" location in v1.1. It removes the single largest store-review risk from
the first submission; technicians can still clock in when they open the app on
site.

**Deployment gating** — `main` auto-deploys to production. Branch protection on
`main`, and a staging environment, are still worth adding so production deploys
become deliberate. Owner action.

---

## 8. The failing Vercel check

Preview deployments have never succeeded — 72 failures, 0 successes since the
Vercel projects were consolidated on 18 July. Production is unaffected: 26
deployments, 26 successes.

**It is not a code problem.** `main` and the PR branch had a byte-identical
source tree, built 16 minutes apart in the same project; Production succeeded and
Preview failed. Identical bytes cannot fail for a code reason.

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are not available
to the build in the **Preview** environment. Next inlines `NEXT_PUBLIC_*` values
into the browser bundle at build time, so they must be present while compiling.

Confirmed by measurement: after `assertRequiredEnv()` landed, the preview build
started failing in **13 seconds** instead of ~90 — i.e. at config load, before
compilation. The same commit builds fine in GitHub Actions, which does set them.

**Fix** — Vercel → `mellerick` team → `mellerick-app` → Settings → Environment Variables:

1. Edit each of those two variables, tick **Preview** alongside Production, save.
2. If either shows a **Sensitive** badge, untick it. Sensitive variables are
   injected only at function runtime and are undefined during the build — which
   produces this exact failure while looking perfectly configured.
3. Diff the whole Preview list against Production. `SUPABASE_SERVICE_ROLE_KEY`
   and `CRON_SECRET` are likely scoped the same way; fixing only the two public
   ones turns the build green and then 500s at runtime on every route using the
   admin client.
4. Redeploy.

---

## 9. Where things live

| Path | What |
|---|---|
| `mobile/lib/data/` | The offline engine. Repositories are the only place table names appear. |
| `mobile/lib/data/reads/` | Local-first read modules, one per area |
| `mobile/lib/data/outbox/` | Durable write queue + processor |
| `mobile/powersync/sync-streams.yaml` | **Security-critical.** Sync rules. |
| `mobile/design/` | Design system: tokens, primitives, `MoneyText`, `RoleGate` |
| `mobile/app/` | expo-router routes, grouped by role |
| `mobile/.maestro/` | E2E flows. Destructive taps are opt-in behind `APPROVE_FOR_REAL` / `CLOCK_FOR_REAL`, so a suite run cannot write to production. |
| `lib/api/` | Web auth guards, per-record authz, Bearer-aware caller client |
| `supabase/migrations/` | Schema, applied in filename order |
| `tests/unit/`, `tests/rls/`, `tests/e2e/` | Web tests |
| `mobile/DECISIONS-FOR-AVI.md` | Every decision with its rationale — **read before undoing anything that looks odd** |
| `mobile/GAP-ANALYSIS.md` | Parity audit against the web app |
| `mobile/SHIPPING.md` | Release runbook |
| `HANDOVER-BACKEND.md` | Backend-specific items |
| `.ezra/` | Governance, plans, route-auth audit |

---

## 10. Traps

Things that have already cost time, roughly in order of how likely you are to hit them.

1. **React Native flattens views.** A `testID` on a `Touchable` is often invisible
   to Maestro and `uiautomator`. `uiautomator dump` can return *no text* for a
   screen visibly full of it. Target by text; trust screenshots and logcat over
   the accessibility tree.
2. **RN `console.log` goes to Metro, not logcat.** A whole debugging session was
   lost to this. Native exceptions *do* reach logcat; JS logs do not.
3. **Mocked tests cannot catch schema drift.** §4.
4. **`sync-streams.yaml` bypasses RLS.** §2.
5. **Node 25 breaks the dev server and `@supabase/ssr`.** §1.
6. **Route-segment config is ignored in a `"use client"` module.**
   `export const dynamic = "force-dynamic"` under `"use client"` does *nothing*.
   Three such lines sat in `login`, `forgot-password` and `update-password` for
   weeks before being removed. Those pages are statically prerendered — which is
   why the build needs the Supabase env vars at compile time.
7. **Any route using the service-role client must authorize the caller first.**
   It bypasses RLS entirely.
8. **Two lockfiles, two projects.** Install in the right directory.

---

## 11. Open question

One remains, deliberately parked:

**Q17** — `sites` has no `is_active` column, and `jobs.site_id` / `quotes.site_id`
block deletion. Mobile therefore offers edit-only for sites, with no delete or
deactivate. Correct given the current schema. Adding soft-delete needs a
migration and a decision about what happens to jobs at a deactivated site.

All 21 other open questions are resolved, each with its reasoning recorded in
`mobile/DECISIONS-FOR-AVI.md`.
