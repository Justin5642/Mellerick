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

**Node 22 is required.** `.node-version` and `engines` both pin `22.x`, and CI
runs it. Node 25 breaks `@supabase/ssr` server-side. Use nvm-windows:
`nvm use 22`.

**Metro crashes periodically, on every Node version — it is not your setup.**

```
RangeError: Too many message fragments
  at Receiver.getData (…/@react-native/dev-middleware/node_modules/ws/lib/receiver.js:359)
  Symbol(status-code): 1008
```

An unhandled `error` event on the dev-middleware WebSocket — the channel carrying
device logs and debugger traffic. Nothing catches it, so it takes the whole Expo
CLI process down and frees port 8081. The app then has no bundle server and looks
broken.

Observed on **Node 25.6.1 and Node 22.23.1 alike**. It was initially blamed on
Node 25; that was wrong, and switching to 22 did not stop it. (Switching was
still correct — it matches the pin and CI — just not a fix for this.)

**It does not affect the shipped app.** Metro is a development-only bundle
server; nothing in a release build talks to it.

Until it is fixed upstream, run Metro under a supervisor so a crash self-heals
instead of leaving a dead port mid-test:

```bash
cd mobile
while ($true) { npx expo start --dev-client --port 8081; Start-Sleep 3 }
```

Diagnosing whether Metro is alive: `curl -s http://localhost:8081/status` →
`packager-status:running`. Silence or connection-refused means it died; a long
uptime with low CPU is normal and healthy.

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

That rule was documented but not enforced, and two streams had drifted to
`SELECT *` (`backflow_devices`, `backflow_tests`). Neither leaked money — those
tables have no monetary column today — but either would have begun syncing one
silently the moment a migration added it. Both now list columns explicitly, and
`tests/unit/sync-streams-contract.test.ts` enforces all of it: no `SELECT *` in a
technician-visible stream, no money-named column in one, and every `office_*`
stream gated on the caller's own profile row.

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

### The device clock lies — never compare a stored timestamp to a later `now`

A technician's phone corrects itself across a long shift: NTP pulls a fast
handset back, or a different timezone offset is picked up on the road. **Any
absolute device timestamp compared against a later device clock read is a stall
waiting to happen**, because the clock can move backwards between the two reads.

This shipped in two places and both are now fixed:

| Site | Symptom of a backward jump |
|---|---|
| `outbox.ts` `nextReady()` | `nextAttemptAt` sat in the future — queued writes stalled for the length of the jump. Silent: no error, no dead-letter, badge just read "pending" while recorded labour went undelivered. |
| `reads/source.ts` write-echo window | `echoUntil` sat in the future — **every read forced to the network**, defeating offline reads outright. A technician in a basement got failures while holding a complete local mirror. |

Both now apply the same guard: each wait has a known maximum by construction
(`MAX_BACKOFF_MS`, `ECHO_WINDOW_MS`), so **a remaining wait longer than that
maximum is evidence the clock moved, not that the wait is real** — and the
operation is released. Each has a negative-control test proving the ordinary
window is still honoured, so the guard cannot decay into "ignore the wait".

Checked and found sound: `hoursBetween()` in `repositories/timeEntries.ts`
returns `null` when the end is not strictly after the start, so a backward jump
between clock-in and clock-out cannot put negative hours on a timesheet.

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

### ⚠ Committed is not applied — and an edited migration never re-runs

This has now caused a real credential exposure, so it is worth stating plainly.

On 2026-07-30 a `pg_policies` check against production found that migration
`0034`, which was written to lock the `xero_tokens` table, **had never taken
effect**. It tried to remove the permissive policy by *name*; the policy created
out-of-band in production was named differently, so `drop policy if exists`
matched nothing and did nothing — no error, no warning. Postgres OR-es
permissive policies, so one missed drop left the table open: **any authenticated
user, a technician holding the anon key included, could read the organisation's
Xero OAuth access and refresh tokens.**

`0034` was then corrected in place. **That correction cannot help on its own.**
The migration ledger already records `0034` as applied, so `supabase db push`
will not re-run it — the edited file sits in the repo looking like a fix while
production stays exposed. That is the same silent-failure shape as the original
defect.

**`0042_converge_token_table_policies.sql` is the actual fix.** It is written so
it cannot fail the same way:

- it drops policies by **enumerating `pg_policy`**, not by guessing names, so it
  cannot miss one whatever it is called;
- it **asserts the end state and raises** — if the table does not finish with RLS
  on and exactly the intended policy, the migration fails loudly instead of
  reporting success;
- it additionally **detects, without changing**, the same drift on
  `google_tokens`, raising if that table's policies do not gate on
  `is_office_or_admin`. Detect-only is deliberate: quietly rewriting a live
  integration's access rules during a security migration trades one incident for
  another.

**Rules that follow from this:**

1. **Never edit an applied migration to fix it.** Write a new one. The ledger
   makes in-place edits invisible.
2. **Never drop a policy by guessed name** in a security migration. Enumerate.
3. **Assert the end state.** A security migration that can silently achieve
   nothing is worse than none, because it manufactures false confidence.
4. **Verify against production, not against a local stack.** `npm run test:rls`
   boots a local Supabase rebuilt *from these same migrations*, so it agrees with
   them by construction and cannot detect drift. Only a query against the real
   database can.

### The drift guard — read before writing a test

Roughly 430 tests mock Supabase. **A query against a column that does not exist
passes happily.** That is exactly how the two schema bugs above reached
production.

`tests/unit/schema-column-contract.test.ts` parses the real migration history and
fails when source references an uncreated column. Proven by negative control:
remove `0040` and it names all four call sites; restore it and it goes green.

> **Mocked tests cannot catch schema drift. A green suite is not proof that a
> column exists.**

It now covers **every table in the migration history** (33 today), derived from
the migrations rather than a hand-maintained list — a list someone must remember
to extend is a guard with a shrinking blast radius. It also catches **shorthand
object properties** (`.insert({ hours, entry_type })`), which the original
colon-only pattern walked straight past. That was not hypothetical: it is exactly
how the geofence writes `hours`, and it is why real drift survived while the
guard appeared to cover `time_entries`.

### The other direction — `npm run check:drift`

The test guard checks that every column the SOURCE names exists in the
migrations. It cannot catch the reverse: a column that exists in **production**
and in no migration, which no source file happens to reference. Nothing is broken
today, so nothing complains — until someone rebuilds the database from migrations
and it comes up subtly different.

```bash
npm run check:drift
```

Reads the live schema (`supabase gen types --linked`), diffs it against the
migration history, names any drifted column and exits 1 — so it can gate a
release. Run it after anyone touches production by hand.

That check is what found `job_variations.attachment_file_name`, which the test
guard could never have seen. Both are now captured in `0043`.

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

**Store accounts — Justin owns these.** They sit under the client's own
organisation (the same place the Vercel `mellerick` team lives), not under
BAS & More.

| | Status |
|---|---|
| **Apple Developer Program** | ✅ **Exists.** Team ID `864FRPRM47` is in `mobile/eas.json` |
| **D-U-N-S number** | ❌ Still needed for Google Play. Free, but **1–14 days** — the long pole |
| **Google Play Console** | ❌ USD 25 once, needs the D-U-N-S first |

**iOS builds are now unblocked.** They cannot be compiled on Windows — Xcode is
macOS-only — but EAS builds them in the cloud, and the signing certificates it
needs come from the Apple account, which now exists. `eas build --platform ios`
will produce an `.ipa`. What still gates *submission* is the App Store Connect
app record, which yields the `ascAppId` for `eas.json`.

**Push notifications** — fully implemented and tested; cannot deliver without an
APNs `.p8` from Apple and an FCM service-account JSON from Firebase. The `.p8`
downloads **once only**.

**`mobile/eas.json` placeholders** — `appleTeamId` is filled. `appleId` and
`ascAppId` are still `*_HERE`; `eas submit --platform ios` fails until they are.
`ascAppId` only exists once the App Store Connect app record is created.

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
become deliberate. Justin's call — it is his GitHub org and Vercel team.

### Who owns what

Worth stating plainly, because "outstanding" without an owner is how items sit
for months.

| Item | Owner |
|---|---|
| D-U-N-S number → Google Play Console | **Justin** |
| Apple Developer Program | **Justin** — done |
| App Store Connect app record → `ascAppId` | **Justin** |
| APNs `.p8` (Apple) + FCM JSON (Firebase) | **Justin** — the Apple account is his, so the `.p8` is available now |
| Vercel Preview environment variables | **Justin** — the `mellerick` team is his |
| Branch protection / staging | **Justin** |
| Screenshots, feature graphic | Whoever can run the app on a device with demo-safe data |
| Privacy policy hosting, legal entity details, ABN | Mellerick Plumbing |

The store packs are written to be handed over as-is — they address "whoever
lodges and pays" rather than naming a person, so they do not go stale if that
changes.

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
5. **Metro dies periodically on every Node version** (`ws` "Too many message
   fragments"), and Node 25 additionally breaks `@supabase/ssr`. §1 — run Metro
   supervised; the crash does not affect the shipped app.
6. **Route-segment config is ignored in a `"use client"` module.**
   `export const dynamic = "force-dynamic"` under `"use client"` does *nothing*.
   Three such lines sat in `login`, `forgot-password` and `update-password` for
   weeks before being removed. Those pages are statically prerendered — which is
   why the build needs the Supabase env vars at compile time.
7. **`[sync] status poll failed: … ERR_USING_RELEASED_SHARED_OBJECT` in the dev
   log is EXPECTED, not a crash.** The sync badge polls SQLite every 3s. A tick
   already in flight when the JS context is torn down — which every Fast Refresh
   does — resumes against a released native handle. It is caught in
   `useSyncStatus`, logged under `__DEV__` only, and the next tick recovers.
   Production exposure is a poll in flight during sign-out: caught the same way,
   the badge skips one update. It looks alarming in logcat and is not. I chased
   it once believing it was a regression; it is the guard working.

8. **Any route using the service-role client must authorize the caller first.**
   It bypasses RLS entirely.
9. **Two lockfiles, two projects.** Install in the right directory.

---

## 11. Open question

One remains, deliberately parked:

**Q17** — `sites` has no `is_active` column, and `jobs.site_id` / `quotes.site_id`
block deletion. Mobile therefore offers edit-only for sites, with no delete or
deactivate. Correct given the current schema. Adding soft-delete needs a
migration and a decision about what happens to jobs at a deactivated site.

All 21 other open questions are resolved, each with its reasoning recorded in
`mobile/DECISIONS-FOR-AVI.md`.
