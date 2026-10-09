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

**Scheduling notes surface on the mobile Overview tab, not just in Notes.**
`job_notes` has a `source` column (migration `0062`); both the web and mobile
"Schedule job" flows tag their note `source: "schedule"`. `mobile/components/
job/schedule-note-banner.tsx` reads the latest one and renders it at the top of
the Overview tab so a technician sees it on opening the job, instead of it
sitting unlabeled among other entries on the 6th-of-7 Notes tab. The same note
still also appears in Notes & Activity, badged "Scheduling note". `tech_job_notes`
in `sync-streams.yaml` had to be updated to explicitly select the new column —
it's a technician-visible stream, so columns are listed, never `.*`.

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
- Web job page: the **Purchase Orders tab is office/admin only** (PO values,
  cost-centre amounts, vendor orders). Technicians get an hours-only
  `JobHoursScoreboard` on Overview, fed by `purchase_orders_public.total_hours`
  (never the base table) + `time_entries` hours — maths in
  `lib/hours-scoreboard.ts`, mirroring the mobile card.

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

### Photos — size and caching

- **Every picked or captured image is downscaled before it is queued**: longest
  edge ≤1600px, JPEG 0.7, in ONE helper, `mobile/lib/imageUpload.ts`
  (`expo-image-manipulator`, EXIF orientation baked into the pixels). Used by job
  photos, variation photos, job and fleet expense receipts, and the backflow
  data-plate scan (which takes its base64 from the resized JPEG, not the picker).
  Pickers now ask for `quality: 1` so there is one compression pass, not two. A
  resize failure queues the original rather than losing the photo. The outbox
  semantics are unchanged — the resized file is what gets staged.
- **The Photos tab list is a local read** (`reads/jobPhotos.ts`, `fromLocalOr`;
  a job absent from a technician's mirror defers to Supabase rather than showing
  an empty grid). Signed URLs come from ONE `createSignedUrls` per load, only for
  photos not already in expo-image's disk cache.
- **Rendered with `expo-image`, `cacheKey` = storage path.** Each signing mints a
  new token, so keying on the URL (RN `<Image>`) re-downloaded every photo on
  every visit. Supabase image transforms are **not** used (plan support
  unconfirmed); thumbnails rely on resized uploads + the disk cache.
- `expo-image-manipulator` is a native module: it reaches devices only through a
  **new dev client / `eas build`**, never an OTA update.

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
`supabase/migrations/0000_baseline.sql` is the baseline. (`supabase/schema.sql` was
deleted — it had drifted to 15 tables against the migrations' 33 and still
carried the infinitely-recursive profiles policy that 0010 exists to fix.)

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

## 6. Verification status, 4 August 2026 (end of session)

Everything below was run, not assumed.

| Check | Result |
|---|---|
| Web tests | **203 passed** (26 files) |
| Mobile tests | **458 passed** (69 suites) |
| Web + mobile typecheck | clean |
| Schema drift | none — every production column is in the migration history |
| PowerSync replication | healthy — slot active, `wal_status=reserved` |
| Money boundary sweep | **41 money columns swept by impersonation: 1 blocked, 40 return zero rows, 0 leaks** |
| Maestro flows 01 / 03 / 04 | green on device |
| Maestro flow 02 | **not run** — needs `ADMIN_EMAIL` / `ADMIN_PASSWORD` |
| Background geofence clock | **running on device** — `isForeground=true, types=0x8` |

### Re-verified AFTER both PRs merged to `main`

The table above was produced while work was in flight. Everything in it was then
re-run against the merged result, because "it passed on the branch" and "it
passes on what is actually in `main`" are different claims, and only the second
one matters to whoever picks this up.

| Re-checked on merged `main` | Result |
|---|---|
| Web tests / typecheck | 203 passed (26 files), clean |
| Mobile tests / typecheck | 458 passed (69 suites), clean |
| Schema drift | none |
| PowerSync replication | healthy — slot active, `wal_status=reserved` |
| `0044` — technician self-promotion to admin | **BLOCKED** |
| `0045` — technician reading a money column | **BLOCKED** |

The last two were re-proven by impersonating a real technician against the live
database inside a rolled-back transaction — not read out of a migration file.
A migration that is present in `git` is not evidence that the hole is shut; the
only evidence is attempting the attack and being refused.

### The two security holes found and closed on 4 August

Both were found by an adversarially-verified audit AFTER the app had been
reviewed repeatedly, and both were verified against production before and after
the fix.

**`0044` — anyone could make themselves an admin.** `Users can update own
profile` was `for update using (auth.uid() = id)` with no `WITH CHECK`. Postgres
reuses `USING` for the new row, and `auth.uid() = id` is still true after the
role changes — so any technician could PATCH their own row to `role='admin'`.
That one column is read by RLS, the PowerSync office streams, MoneyText/RoleGate
and every `requireAdmin` route, so it defeated all four layers at once. Also
closed a second path: `handle_new_user()` took the role straight from
client-supplied signup metadata.

**`0045` — a technician could read `time_entries.rate_override`.** A money
column, readable through PostgREST with the anon key that ships inside the app.
The sync path, the UI and the guards were all clean; RLS was not.

### Why those two survived every earlier review

Every previous check reasoned about POLICIES, and **a policy can look correct
and still permit the read.** The money boundary had also been "verified" several
times against tables that were empty, where every assertion is trivially true.

`supabase/tests/money_boundary_sweep.sql` replaces that reasoning with evidence:
it enumerates every money-named column, impersonates a real technician, and
tries to actually SELECT it. Run it after any RLS or schema change.

The result it reports needs one distinction to read correctly:

- `blocked` — the read is refused (column grant revoked)
- `readable, 0 rows` — the grant exists but RLS returns nothing. **Safe.**
  Confirmed by comparing counts as `postgres` against the same query as a
  technician: invoices 4→0, job_items 6→0, staff_cost_profiles 2→0. Zero is RLS
  filtering, not an empty table.
- `READABLE WITH DATA` — a leak. This is what `rate_override` looked like.

That also explains why `rate_override` was the only one: `time_entries` is the
single money-bearing table where a technician legitimately sees rows — their
own — so the column grant was the only thing left protecting the value.
Everywhere else, row-level filtering denies the row outright.

**An empty table proves nothing here.** If you seed data and rerun, rerun this
sweep too.
| `tsc --noEmit`, both projects | clean |
| `npm run check:drift` | no drift in either direction |
| `npm run check:sync` | slot active, `wal_status=reserved` |
| Maestro flows 01 / 03 / 04 | pass on Android emulator |
| Maestro flow 02 | needs `ADMIN_EMAIL`/`ADMIN_PASSWORD` — not held by us |
| Money boundary, populated technician device | job #833 carried 18 columns, **none financial**; no money-named column in any synced table |

**Three things found on 4 August that had been silently wrong:**

1. **PowerSync replication had been dead for 24 hours.** The slot was invalidated
   (`wal_removed`) and every client-visible signal said healthy — devices kept
   syncing, `ps_sync_state` kept advancing, no error fired. Only the PowerSync
   dashboard logs knew. `npm run check:sync` now detects it in one command.
2. **Every Maestro flow asserted the wrong screen.** The login subflow's
   `LANDING` default overrode what each caller passed, so the technician flows
   could never pass and the office flows passed while checking the wrong label.
3. **Q29 was a timeout, not a flake.** `schema-column-contract` re-read every
   source file once per table (~6,600 reads); under I/O contention one tipped
   past vitest's 5s ceiling, and which one varied. Now 55ms.

### Superseded — 29 July 2026

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

### The four things a person has to do

Every one of these needs an account, a credential or a dashboard I cannot reach.
They are listed first because they are the only things standing between this and
a shippable release.

| | Who | Why it is not code |
|---|---|---|
| **Vercel Preview env vars** | Justin | Every PR's Vercel check fails on `Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY`. Proven by comparison, not inference: GitHub's `build` job runs the *identical* `next build` on the same commit and passes, because CI supplies those two. Set them on the Vercel project's Preview environment. |
| **`max_slot_wal_keep_size`** | Justin / Avi | Supabase instance config, no SQL path. Without it a slot can be invalidated again — which cost 24 hours of silent, invisible outage on 3–4 August. `npm run check:sync` now turns that failure mode into one command. |
| **EAS env vars** | Justin / Avi | `eas env:create` for the two `EXPO_PUBLIC_*` values, or a cloud build ships an app pointed at `undefined`. See SHIPPING.md **STEP ZERO**. The app now refuses to start in that state rather than failing mysteriously later. |
| **Sentry (error monitoring)** | Justin | Optional, and off until a DSN is set — see §12. Create a free Sentry org with a Next.js project (and a React Native project for the app), then set the DSNs in Vercel and EAS. Without it, failures like the weeks-long silent "Polish with AI" outage are still only discovered by accident. |
| **Maestro flow 02** | Avi | Needs `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the environment. The login subflow deliberately skips when a session already exists, so a password never passes through a script — which is why flows 01/03/04 could be run and 02 could not. |

### QA fixture — do not delete

Job **#834 "QA FIXTURE — do not invoice, do not delete"** is assigned to the
test technician. Flows 01, 03 and 04 each open a job, so without it they fail.

It exists because on 4 August **no technician in the database had an open job** —
Jake Henderson had none either — so the e2e suite could never have run against
real data. Avi chose a permanent fixture over assigning real work. Idempotent
recreate SQL is in `mobile/.maestro/README.md`.

Flow 03 is the sharp case: every assertion before it opens the job is an
`assertNotVisible`, so against an empty job list they are all trivially true and
the flow proves nothing while appearing to run.

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

**Background location — this recommendation was REVERSED on 4 August 2026, and
the reversal needs Avi's sign-off before submission.**

The advice here used to be: ship **when-in-use** only, add background "always" in
v1.1, because background location is the single largest store-review risk on a
first submission. That reasoning still holds on the store-review axis. It was
outweighed by what foreground-only actually does to payroll.

The auto-clock is a *payroll* feature. Foreground-only means that the moment a
technician pockets the phone and drives to the next site, tracking stops: the
travel leg is never recorded and the arrival is only noticed when they next open
the app. Nothing errors, nothing is logged, and the hours simply do not appear.
The technician is paid for less time than they worked, and because the feature
*looks* like it is working, nobody goes looking. A feature that is obviously
absent is safer than one that silently under-records.

So background tracking is now implemented (`mobile/lib/backgroundClock*.ts`,
430 mobile tests green) and is **best-effort**: declining "Always" leaves the
foreground watcher working exactly as before, and logs that drive time is not
being recorded rather than swallowing it.

**Tracking is gated (9 October 2026) — it no longer runs for everyone, all the
time.** `mobile/lib/trackingGate.ts` decides; the foreground provider and the
background task both call it. GPS (and the Android foreground-service
notification) runs only when **all** of:

- the role is `technician` (an unknown role — profile not loaded, offline
  launch — counts as technician rather than switching tracking off);
- the technician has at least one geofence-able open job (crew jobs included);
- they are **on the clock** *or* inside `WORK_HOURS` — 06:00–19:00 Mon–Sat,
  device-local time, one constant.

**On the clock beats the hours** — that is the payroll rule. It means any of: an
open work entry (mirror or network; open > 16 h is treated as a forgotten
clock-out), a clock-in still queued in the outbox, the geofence placing them
inside a site, a drive in progress (departure < 3 h old, so the travel leg is
captured), or a wake-region hit in the last 20 min. Anything it cannot read
counts as on the clock. It is re-decided on app foreground, every site refresh,
every clock write queued on the device, every geofence transition and every
5 min; when the app has been swiped away the background task re-checks itself
after each batch.

**Off hours the job sites stay registered as OS wake regions** (300 m,
enter-only, the 20 soonest — iOS's cap). iOS cannot restart GPS from the
background on its own, so without this a phone that is not opened in the
morning would miss the first arrival of the day. A region entry restarts
tracking; the clock times still come from the ordinary 150 m readings.

Settings: accuracy stays Balanced (lower is 1–3 km against a 150 m geofence —
fabricated or missed clock-ins). "Watching" (in hours, not working) samples at
30 s; on the clock keeps the original 15 s / 25 m, with a 60 s batching
deferral only while on site. iOS auto-pause stays **off**: expo never resumes a
paused task, which would lose the departure and the next arrival. Rationale in
`mobile/DECISIONS-FOR-AVI.md` D96. **Not yet verified on a device** — check an
evening shift (clocked in past 19:00 keeps tracking; clocking out stops it and
the notification goes) and a morning first arrival with the app unopened.

**The store-review risk is real and has not gone away.** Apple and Google both
scrutinise "Always" location. The submission needs a clear justification string
(written, in `app.json`) and screenshots showing the Android foreground-service
notification.

**To revert to when-in-use for v1.0** — a config change, no code change: in
`mobile/app.json`, set `isIosBackgroundLocationEnabled`,
`isAndroidBackgroundLocationEnabled` and `isAndroidForegroundServiceEnabled` to
`false`, drop `UIBackgroundModes`, and remove `ACCESS_BACKGROUND_LOCATION` /
`FOREGROUND_SERVICE_LOCATION` from the Android permissions. The background task
then never starts and the app behaves exactly as it did before. **If you take
that path, tell the technicians that travel time is only captured while the app
is open** — otherwise the silent under-recording is back, just with a
justification.

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
| Sentry account + DSNs in Vercel / EAS (§12) | **Justin** |
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
| `lib/monitoring/`, `instrumentation*.ts` | Web error monitoring (Sentry) and its privacy scrubber — §12 |
| `mobile/lib/monitoring/` | Mobile crash / dead-letter reporting (Sentry) and its scrubber — §12 |
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
10. **`jobs.assigned_to` is only the crew's PRIMARY assignee** (migration 0059).
    "My jobs" means *any* current assignee: `job_assignments` OR `assigned_to`.
    My Jobs (web and mobile), the geofence site list and the schedule "All day"
    count filtered on `assigned_to` alone, so the second technician on a crew job
    had it synced to their phone but never saw it and was never auto-clocked
    there. Use `mobile/lib/data/reads/assignedJobs.ts` for any new "mine" read.

---

## 11. Open question

None. **Q17 is resolved** (migration `0063` applied 2026-10-08).

**Q17** — sites can now be **archived** (soft-delete), on web (customer page)
and mobile (site sheet), and restored. Decision: jobs and quotes at an archived
site are untouched and keep showing it; archived sites are only hidden from the
site pickers for new jobs and backflow devices (the job-edit picker still shows
the job's own site). Sites are never hard-deleted — `removeSite` is gone, so no
FK-failing delete can be queued.

`0063` (`sites.is_active`) is applied in production. The PowerSync sync streams
must be redeployed with `sites` selecting `is_active`, or devices never receive
the archived flag (they treat a missing value as active).

**Site write permissions (migration `0064`, applied 2026-10-08):** RLS on
`sites` now lets every signed-in user read and add sites, but only office/admin
update (edit/archive) or delete them. It drops the old policies by enumeration
and asserts the end state. `tests/rls/sites.test.ts`
proves it on the CI stack.

**Office-only job documents (migration `0065`, applied 2026-10-08):**
`job_documents.office_only` hides a document — row and file — from technicians;
office/admin toggle it on the web Documents tab (lock icon). The same migration
fixes mobile expense receipts (`<job>/expense-<id>.jpg`), which 0047's path
check missed. Run `scripts/audit-job-documents.mjs` (dry run
first, then `--commit`) to flag the ~3.9k imported Simpro attachments that show
prices; review the CSV it writes to `scripts/data/`.

**Backflow signature storage (migration `0066`, applied 2026-10-08):**
0047's note that `backflow-certificates` has no policy is stale — 0048 added
INSERT for `<deviceId>/signatures/…`, which fixed the web upload. But the mobile
outbox uploads with `upsert: true`, which storage needs SELECT + UPDATE for, so a
technician's signed test from the phone is refused and dead-letters. `0066`
re-creates the bucket's policies by enumeration: signatures only, under an
existing device; SELECT/UPDATE only on a signature you uploaded yourself;
office/admin read and delete everything; anon nothing.
`tests/rls/backflow-certificates.test.ts` proves it on the CI stack. Confirm
on a device that a signed test logged from the mobile app settles.

**Job to-do list (migration `0067`, applied 2026-10-09):** office can set
jobs aside to fill a schedule gap. Web job page header (office/admin only) →
"Add to to-do list", asking for optional estimated hours (prefilled from the
job's estimate or its PO allocated hours); a listed job shows "On to-do list ·
Xh" with a remove button. Schedule page → **To-do list** tab: listed jobs sorted
urgent→low then longest-waiting, hours = estimate else PO `total_hours` (read
from `purchase_orders_public`, hours only), a "Fits in [__] h" filter (jobs with
no estimate always stay visible), and a Schedule button that opens the job page
with `?schedule=1`, which auto-opens the schedule wizard. The Jobs list shows a
"To-do" badge. A job **leaves the list by itself** once scheduled: trigger
`jobs_todo_list_autoclear` clears `todo_listed_at` when `scheduled_start` is set
or changed, or status is scheduled/in_progress/completed/cancelled — so web,
mobile, board drags and the calendar poll all behave the same. The trigger also
stamps `todo_listed_at` with the database clock and `todo_listed_by` with
`auth.uid()`. Pure logic in `lib/todo-list.ts`; trigger proven by
`tests/rls/job-todo-list.test.ts` on the CI stack. **Safe to merge before
applying:** the job page hides the control when the columns are absent, the
Jobs list retries without `todo_listed_at` on `42703`, and the Schedule tab
shows a load error on its own panel only. `mobile/lib/powersync/schema.ts` gained
the three columns by hand (exactly what the generator emits after the apply —
`office_jobs` syncs `jobs.*`); regenerating it is optional now that `0067` is live.
No mobile UI yet.

All 21 other open questions are resolved, each with its reasoning recorded in
`mobile/DECISIONS-FOR-AVI.md`.

---

## 12. Error monitoring (Sentry)

Added 9 October 2026 so the owner **hears** about crashes and failed background
work instead of discovering them by accident — the "Polish with AI" button
returned 5xx for weeks before anyone noticed.

**Entirely optional.** With no DSN set, nothing initialises: `next.config.ts` is
not wrapped, the SDK is tree-shaken out of every bundle (verified — shared
first-load JS stays at 102 kB, middleware at 90 kB), and builds, tests and
runtime behave exactly as before. CI has no Sentry secrets and needs none.

### Web (`@sentry/nextjs` 10.76.2, pinned)

| File | Role |
|---|---|
| `instrumentation.ts` | `register()` inits the SDK for Node and edge; `onRequestError` reports uncaught server errors |
| `instrumentation-client.ts` | Browser init + router-transition hook |
| `app/global-error.tsx`, `app/error.tsx`, `app/dashboard/error.tsx` | Report what the error boundaries catch |
| `lib/monitoring/index.ts` | `reportError(err, { route, ... })` / `reportFailure(msg, { route, ... })` — no-ops without a DSN |
| `lib/monitoring/options.ts` | Shared `Sentry.init` options for all three runtimes |
| `lib/monitoring/scrub.ts` | `beforeSend` / `beforeBreadcrumb` privacy scrubber |

Explicitly reported (route tag + integration tag): `api/ai/polish-note`,
`api/ai/transcribe-note`, `api/jobs/transcribe-voice-report`,
`api/backflow/scan-data-plate`, `api/backflow/tests/submit`, every Xero route
that catches (callback, push-invoice, push-expense, poll-invoices, sync-now),
Google Calendar (callback, poll-calendar, sync-now, jobs/sync-calendar), and
invoice/quote email send. A **missing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`**
in a deployment is reported too — that is the most likely cause of a silent AI
outage.

**Keep the guards literal.** Every client/server guard reads
`process.env.NEXT_PUBLIC_SENTRY_DSN` inline, and `next.config.ts` defines it as
`""` when unset. That is what lets the bundler drop the SDK; routing the check
through a helper or a variable put ~85 kB back into every page.

### Mobile (`@sentry/react-native` ~7.2.0 — the version Expo SDK 54 pins)

Initialised at module scope in `mobile/app/_layout.tsx` (`initMonitoring()`),
root component wrapped with `Sentry.wrap` — both only when
`EXPO_PUBLIC_SENTRY_DSN` is set. Code in `mobile/lib/monitoring/`.

What it reports — the failures that were silent on a technician's phone:

| Failure | Tags |
|---|---|
| Outbox op dead-letters (retries exhausted, repeated mid-dispatch crash, or dead dependency) — `Outbox` `onDeadLetter` hook | `table`, `op`, `aggregate` (writes) or `effect` (side effects), `attempts` |
| Sync engine background drain failure (the `onSyncError` sink) | `source: sync-engine` |
| Background-fetch drain failure (headless — initialises monitoring itself) | `source: background-sync` |
| `useSyncStatus` poll / retry failure | `source: sync-status` / `sync-retry` |

**Not** reported: the expected `ERR_USING_RELEASED_SHARED_OBJECT` teardown
noise (§10 trap 7). Each distinct sync failure is reported **once per app
session**, so a broken 3-second poll cannot flood the quota. A dead-letter
report never carries the payload; the server's error message is redacted
(numbers and quoted values removed) before it is attached.

Mobile privacy extras: no traces (`tracesSampleRate: 0` — spans would carry
PostgREST row filters), no screenshots, no view hierarchy (both show the screen,
including dollar figures for office users), touch breadcrumbs dropped.

**Needs a new native build.** The SDK is a native module: it reaches devices
only through a new dev client / `eas build`, never an OTA update. Since
`runtimeVersion` follows the app version, bump `version` in `app.json` before
publishing any OTA update that contains this code, so it is not delivered to a
binary built without the module.

The Sentry Expo config plugin (`@sentry/react-native/expo`) is deliberately
**not** in `app.json`: it adds a source-map upload step to the native build
that fails the iOS build when `SENTRY_AUTH_TOKEN` is absent. Crash reporting
works without it; stack traces are just minified. To get readable mobile
traces later, add the plugin (`organization`, `project`) and set
`SENTRY_AUTH_TOKEN` as an EAS **secret** in the same change.

### Privacy — the money rule applies here too

An error tracker is a wider audience than the app. So:

- `sendDefaultPii: false`; **no session replay**; traces sampled at 10% (web).
- The scrubber removes request bodies, cookies, query strings and every request
  header except `user-agent`/`content-type`/`accept`; reduces `user` to an id;
  drops `extra`; drops console breadcrumbs (they carry logged response bodies)
  and strips query strings from URL breadcrumbs.
- `reportError` accepts **tags only** — there is no channel for payloads. Never
  add note text, transcripts, customer details or amounts to a report.
- PostgREST errors (plain objects) keep only `message` and `code`; `details`,
  which can echo row values, is not sent.

### Env vars the owner must set

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | Vercel → `mellerick-app` → Environment Variables, **Production AND Preview** | Public, write-only ingest key. Inlined at build time, so redeploy after setting. |
| `SENTRY_AUTH_TOKEN` | Vercel, Production (+ Preview if wanted). **Secret** — never `NEXT_PUBLIC_` | Optional. Uploads source maps so stack traces are readable; maps are deleted from the output after upload. |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Vercel, alongside the token | All three must be present or the upload is skipped silently. An upload failure only warns — it never fails a deploy. |

| `EXPO_PUBLIC_SENTRY_DSN` | EAS: `eas env:set --scope project --environment production --name EXPO_PUBLIC_SENTRY_DSN --value <dsn> --visibility plaintext --type string`, and again with `--environment preview` | DSN of a separate **React Native** Sentry project. Inlined at build time, so it needs a new build. See `mobile/SHIPPING.md` STEP ZERO. |

Steps: create a Sentry account (free tier is enough), create a **Next.js**
project, copy its DSN into Vercel as above, redeploy, then trigger a test error
and confirm it arrives. Set up an alert rule (Sentry → Alerts) to email
justin@mellerick.com on new issues — without an alert, reports sit unread.

