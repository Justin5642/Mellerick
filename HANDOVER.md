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

**Supabase is in Singapore (ap-southeast-1), so Vercel functions run in `sin1`.**
Confirmed 14 October 2026 by resolving `db.<ref>.supabase.co`. #46 moved
functions to `syd1` believing Supabase was in Sydney; every query then crossed
Sydney↔Singapore (~90 ms each), and a page makes several in sequence. A page
costs one Melbourne→Singapore trip for the visitor and ~2 ms per query instead.
Middleware runs on the Node.js runtime (`config.runtime = "nodejs"`) so it also
runs in `sin1` rather than at the edge nearest the visitor. Login is verified
with `auth.getClaims()` — the project signs JWTs with an ES256 key, so it is a
local signature check, not an auth-server round trip (middleware and
`lib/auth/viewer.ts`). Trade-off: a revoked session stays valid until its access
token expires (≤1 h); RLS still authorizes every query. List-row `<Link>`s are
`prefetch={false}`; the sidebar prefetches. If the database ever moves to Sydney,
move `vercel.json` back to `syd1` in the same change.

**Password links: invites, resets, lockout (fixed 16 Oct 2026).** Every emailed
auth link lands on `/update-password`, which accepts all three link shapes:
implicit `#access_token=…` (staff invites — admin links are always implicit —
the mobile app's "Forgot password?", and `/forgot-password`, which now sends
through `/api/auth/forgot-password` with an implicit client), `?token_hash=…`,
and PKCE `?code=…`. The browser client is PKCE-only and silently rejects
implicit links, which is why invites and phone resets used to show "invalid or
expired" in a loop. Invites pass `redirectTo: /update-password`, so new staff
set a password first. A successful reset calls `/api/auth/clear-lockout`, so
the 0056 lockout no longer keeps refusing the NEW password for 10 minutes.
Sign-out is `scope: "local"` on web and mobile (the default revoked every
device). Mobile sign-in gives up after 15 s with a plain "slow connection"
message. Supabase's redirect allow list must keep
`https://mellerick-app.vercel.app/update-password`.

**Web security leftovers (fix/web-security-leftovers, 17 Oct 2026).**
`/api/auth/login` lowercases the email and matches `profiles.email`
case-insensitively — `Admin@x` used to skip the lockout entirely — and answers
a locked account, an unknown email and a wrong password with the SAME 401 text
(it still points at "Forgot password?"). The lockout is a speed bump: the anon
key lets anyone call Supabase Auth directly. Staff invites store the email
lowercase. Reset links use `appUrl()` (`lib/env.ts`: `APP_URL` →
`NEXT_PUBLIC_APP_URL` → production), never the request Host. `/api/backflow/
scan-data-plate` accepts only JPEG/PNG/WebP ≤ 5 MB, and it and `/api/ai/
polish-note` are rate limited per user through `consume_rate_limit()`
(migration `0076`, applied 2026-10-18; if the limiter is ever unavailable they
fail open and log "rate limiter unavailable"). API routes log DB/SDK error text and return fixed
sentences (guard: `tests/unit/no-raw-error-responses.test.ts`). The Time tab's
stage picker is disabled on entries you could not edit. Public sign-up is off
in `supabase/config.toml` — the hosted switch is a §7 item.

**Multi-day schedules (migration `0071`, applied 2026-10-14).** A job still
stores one `scheduled_start..scheduled_end`; `jobs.schedule_daily = true` means
the same daily hours on each booked day — weekdays between the two dates, plus
either date itself even on a weekend — and `schedule_all_day` remembers the
"All day" box (07:00–15:30, 8 h + 30 min break, each day). The rule lives only
in `lib/scheduling.ts` (`scheduleDays`, `occupiesDay`, `moveSchedule`, …),
mirrored at `mobile/lib/scheduling.ts` and pinned identical by
`tests/unit/scheduling-multiday.test.ts`. **Never bucket a job by
`scheduled_start` alone** — that is what showed a Mon–Wed job on Monday only.
- **Board** (`components/schedule/`): a job shows in every crew member's row on
  every booked day, with booked hours per tech per day. Double-click a card to
  cut it, click a tech's day to paste (Esc cancels). Paste AND drag both move
  the dates (`moveSchedule` — a daily job keeps its daily hours and number of
  booked days, starting on the target day) and SWAP the source tech for the
  target tech, keeping the rest of the crew, via `set_job_assignments` —
  never a direct `assigned_to` write, which collapses the crew (0059). Before
  14 Oct 2026 a drop replaced the whole crew; changing that was the office's
  call.
- **Google Calendar**: a daily job is ONE event with
  `RRULE:FREQ=DAILY;UNTIL=…` + `EXDATE` for skipped weekend days
  (`lib/calendar-event.ts`). The poll never writes an edited single occurrence
  back to the job, and for a daily job never writes series time changes back
  either — the app is the source of truth for multi-day schedules.
- **Rolled out 14 Oct 2026** in the order that matters for any future column
  like this: apply the migration → redeploy the PowerSync sync rules → merge
  web → ship mobile. Web and the calendar poll select these columns; only the
  Jobs list and the schedule board fall back (42703) if they are ever missing.

**Job bookings — web (stage 2; needs migration `0079`, a DRAFT not yet applied).**
Each technician's own time and cost centre on a job is a row in `job_bookings`;
the job's window and crew are derived from them by 0079's triggers. **Apply
0079 (and run its test) BEFORE merging this to `main`.** Without the table the
web still renders (bookings are derived read-only from the job window and
crew, the board refuses drags with a message, the Schedule dialog cannot save,
and calendar sync keeps the old single event) — so an early merge degrades
scheduling to read-only; it does not corrupt anything.
- **Pure rules + reads/writes:** `lib/bookings.ts` (`bookingWindow` hands a
  booking to `lib/scheduling.ts` — the 0071 day rules are reused, not forked;
  `planBookingSave` turns dialog rows into inserts/updates/deletes).
- **Schedule dialog** (`components/job/schedule-job-dialog.tsx`, office/admin
  only — RLS): a list of bookings; each row = technicians × cost centre ×
  days/hours (same `ScheduleFields`). Several technicians on a row = one
  booking each. Saved rows update in place (keeping their calendar event);
  writes are inserts/updates first, deletes last; not atomic — a partial
  failure closes and refreshes. `?schedule=1` still auto-opens it. The
  Overview tab no longer edits the schedule or Assigned Technician (either
  write would flatten bookings via the compatibility triggers); it lists the
  bookings read-only with an "Edit schedule" button.
- **Board** (`components/schedule/`): cards are bookings, under their own
  technician (or Unassigned) on each booked day; hours = sum of the tech's
  bookings. Drag/paste moves THAT booking (`staff_id` and/or dates via
  `moveSchedule`); Shift-drop inserts a copy for the target tech (same window
  and cost centre; on another day in Week view it starts there).
- **Google Calendar:** one event per booking, titled `#<job> <cost centre> —
  <tech>` (job title when no cost centre, "Unassigned" with no tech), linked
  by `job_bookings.google_event_id` and tagged with private extended
  properties `mellerickJobId`/`mellerickBookingId`
  (`lib/calendar-booking-sync.ts`). A sync updates/creates each booking's
  event, deletes tagged events no booking links to (so bookings removed by the
  old-style compatibility trigger leave no strays), and retires the legacy
  job event — adopted by the booking when the job has exactly one. The poll
  matches events to bookings first (moves/deletes that booking, same "newer
  side wins" rules on the booking's `updated_at`); a legacy job event is only
  written back while the job's bookings still share one window
  (`legacySkipped` otherwise).
- Old-style writers (mobile ≤15, New Job, approvals) still write the job-level
  schedule; 0079 translates them. Mobile build 16 is the next stage.

**Load page data on the server, not in the browser.** A browser→Supabase
query from Australia costs ~100 ms+; a server query in `sin1` costs ~2 ms. So
My Jobs, Approvals, Staff, Fleet and Customers are server pages that pass
initial data (and the role, from `getViewer()`) to their client UI, and lists
search/paginate in the database (Customers `?q=&page=`, Quotes/Pricing "Load
more", the customer picker queries as you type, max 20). `lib/fetch-all-rows.ts`
takes a query *builder function* and fetches pages 2..n in parallel — a
Supabase query object mutates its own range, so pages cannot share one.

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

Treat `sync-streams.yaml` as security code. Re-audited 9 October 2026 (sync
windows) — all 16 technician-visible streams are money-free:

- `tech_jobs` — 21 named columns, none monetary (`schedule_daily`,
  `schedule_all_day` added for the 0071 multi-day schedules; 0071 applied and
  these rules redeployed 2026-10-14)
- `tech_job_variations` — omits `rate`, `total_amount`, `admin_notes`
- `variation_types` — omits the preset `rate`
- `tech_time_entries` — omits `rate`
- `profiles`, `sync_horizon`, `tech_customers` / `backflow_customers`,
  `tech_sites` / `backflow_sites`, `backflow_devices`, `backflow_tests`,
  `tech_job_assignments`, `tech_job_photos`, `tech_job_notes`,
  `tech_job_stage_notes` — no monetary column in the selected sets

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

### Sync windows — devices no longer receive all of history (`0068`)

**Status: live.** `0068` applied in production 2026-10-12 (`sync_horizon` row
and `sync-window-refresh` cron job confirmed); the stream file was deployed to
instance `6a5f0bf6367771958b496c5e` as sync rules **v4** on 2026-10-12.

Before: every device received every customer and site; a technician received
every job they were EVER assigned plus all of its children, forever; office
received every invoice, quote, time entry and usage log ever written. After:

| Stream(s) | Who | Now syncs |
|---|---|---|
| `tech_jobs` + 6 `tech_job_*`/`tech_time_entries` | technician | jobs **open (any age)** or active in the last **90 days**; children follow their job through the same subquery |
| `tech_customers` / `tech_sites` | technician | only those of the jobs above |
| `backflow_customers` / `backflow_sites` | all | those owning an **active** backflow device (the register names them) |
| `backflow_devices` | all | active devices only |
| `backflow_tests` | all | last 24 months **plus each device's latest pass** (due-date input); 11 columns, no `test_results` JSON |
| `office_jobs` + job children, `office_time_entries`, `office_equipment_usage_log` | office/admin | open / ready-to-invoice / unbilled-approved-variation / active within **24 months**; children follow their job |
| `office_invoices`/`_items`, `office_quotes`/`_items` | office/admin | open, or active within 24 months; items follow |
| `office_customers`, `office_sites`, pricing, inventory, equipment, POs, assignments | office/admin | whole (reference / one-row-per-job tables) |

PowerSync cannot compare a row to `now()` (the compiler rejects it), so the
windows are boolean columns the **database** keeps current: `jobs.sync_tech`,
`*.sync_office`, `backflow_tests.sync_recent`, `customers/sites.sync_backflow`.
Triggers mark any real write as recent (and bring a job's children back with
it); only the nightly `sync_window_refresh()` (pg_cron, 16:17 UTC) ever sets a
flag false, in the same transaction that writes the `sync_horizon` row naming
the cutoffs. Clients cannot set a flag — their writes always count as activity.
Every stream filter is `<flag> IS NOT false`, so deploying the YAML before the
migration syncs everything (today's behaviour), not nothing.

Checked before handover: the full migration chain incl. `0068` applied to a
scratch Postgres 16 (Supabase roles/auth shimmed) and the triggers were
exercised with seeded rows — open 3-year-old job stays in both windows; a
technician's note on an out-of-window job brings the job and its time entries
back to office devices without touching `jobs.updated_at`; a client writing
`sync_office = false` is ignored; deleting a device's latest pass flags the
previous pass in; deactivating a device clears its customer's/site's
`sync_backflow` with `updated_at` preserved; a second refresh is a no-op. Not
yet run against production data or the CI `rls` stack.

Validate any change to these filters with the real compiler, not by eye —
`@powersync/service-sync-rules` (needs `node --js-explicit-resource-management`
on Node 22) both validates and evaluates rows; that is how every filter above
was checked. `tests/unit/sync-streams-contract.test.ts` pins the shapes: no
strict `= true` on a flag, no status filter on `tech_jobs`, every technician
child stream scoped through the same windowed job set, the office role gate
never ORed with a filter.

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

`no-local` · `not-synced` · `write-echo` · `role` · `local-threw` · `stale-db` ·
`out-of-window`

The local and remote implementations must return **identical shapes**. Each read
module has a test for this; change one side, change both.

### Startup — nothing on the first screen waits for the network

A cold start used to block twice: a full-screen spinner until a **network** read
of `profiles` returned (offline with nothing loaded → the profile-error screen,
not the technician's jobs), and then no local reads until **this** connection's
first PowerSync sync finished, so My Jobs' first render went to Supabase.

- **Profile cache** — `mobile/lib/profileCache.ts`. The signed-in user's own
  `id / full_name / email / role / is_active` in AsyncStorage, keyed **and
  checked** by user id (a record never answers for another user). `auth-context`
  paints from it immediately and revalidates in the background. Policy
  (`decideProfileResult`, pure, tested): the server's answer **always** replaces
  the cache once it arrives (a changed role re-gates the routes and
  PowerSyncProvider wipes the old role's mirror; `is_active=false` shows the
  deactivated screen and wipes the mirror); `PGRST116` (no profile row) clears
  it — fail closed; a transient failure keeps what is shown. Cleared on sign-out.
  **The cached role is a UI hint, not an authorization**: RLS still runs as the
  real user and the sync streams gate on the server-side `profiles` row, so
  editing the cache on a rooted phone grants no data.
- **Full-sync marker** — `mobile/lib/data/syncMarker.ts`, logic in
  `powersyncTransition.ts` (tested with fakes). Written only after
  `waitForFirstSync()` for `{userId, role}`; cleared **before** every
  `disconnectAndClear()`. On cold start: marker for this exact user+role → a
  provisional local-read seam is registered at once (`fromLocalOr`'s `role`,
  `write-echo`, `stale-db` fallbacks still apply); no marker → today's
  behaviour (wait); marker for anyone else → wipe the mirror first.
- A transition's `waitForFirstSync` is aborted when a newer transition is
  queued — previously one waiting offline blocked the chain, including a
  sign-out's wipe, indefinitely. Transitions key on user id + role, not the
  session object, so an hourly token refresh no longer re-runs them.

Reads moved local in the same change: office dashboard (`reads/dashboard.ts`,
office/admin only — was 7 network calls), backflow device detail, technician
variations + the variation-type picker (rate-stripped streams; no money column on
either path, asserted by test), and time entries on the hours scoreboard (the
technician query reproduces RLS's own-rows filter). **Still remote, by design:**
a technician's allocated PO hours (`purchase_orders` is not in their stream;
`purchase_orders_public` is a server view), and signed photo URLs.

**A local miss is not proof of absence once sync windows are live (§2).** The
mirror holds a window, not history. `reads/horizon.ts` reads the synced
`sync_horizon` row (server cutoffs — no device clock involved) and each read
proves its request is inside it, or throws `OutsideSyncWindow`, which
`fromLocalOr` sends to Supabase as `out-of-window`:

| Read | Rule |
|---|---|
| `listOfficeJobs`, `searchOfficeJobs`, `searchJobs`, `listInvoices`, `listQuotes` | local only if the page is full and its oldest `created_at` is inside the window |
| `getInvoice`, `getQuote`, `getJob` | local miss → network |
| `getJobBilling`, `getJobEquipment`, `getJobVariationsForApproval`, `getInvoiceJobPrefill` | local only if the job is on the device (children travel with it) |
| `getCustomerOverview`, `getReportSummary`, `getReportAnalytics`, `listEquipmentUsage`, backflow device test history | all-history: network whenever a window is in force |
| `getEquipmentUtilization`, `countOtherScheduledJobs` | local when the date bound is inside the window |
| `listMyJobs`, `listReadyToInvoice`, `listBackflowDevices` | always complete — the windows keep every row they select |

**Local indexes.** PowerSync stores each table as JSON behind a view, so an
unindexed `WHERE job_id = ?` parses every row. The indexes the reads need are
declared by hand in `mobile/powersync/device-indexes.js` and merged into the
generated `schema.ts` by `generate-powersync-schema.mjs` (which refuses an
index on a column the device does not hold). `lib/powersync/indexes.test.ts`
reads every local SQL statement and fails when a lookup has no usable index —
add the index there, then regenerate. Three scans are deliberate and named in
that test (the third, `jobs.scheduled_end`, is the residual half of
`countOtherScheduledJobs`' multi-day overlap test).

No horizon row means no window (migration or YAML not deployed) and every read
behaves exactly as before. Consequence to tell office staff: once deployed,
reports, customer history and search need a connection; open work does not.

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

### Sync reliability and sign-out (17 October 2026 audit)

Twelve findings fixed in one PR (branch `fix/mobile-sync-reliability`). What
changed in behaviour:

- **Queued work belongs to a user.** Every outbox operation carries `userId`
  (stamped at enqueue from `lib/data/outboxOwner.ts`, which AuthProvider keeps
  current). The processor only selects the signed-in user's operations;
  another user's are neither run nor block a row's FIFO — they wait for their
  owner. Operations queued by an older build (no `userId`) are adopted by the
  first user to drain after the upgrade (`Outbox.adoptUnowned`), never dropped.
- **Sign-out warns, then wipes.** Every sign-out button uses
  `lib/useSignOut.ts` → `lib/signOutFlow.ts`: it counts the user's unsynced
  outbox ops (dead included) plus queued background clock actions and asks
  "N items haven't synced … Sign out anyway?". Only on confirm: engine stopped,
  the user's ops removed, every unreferenced staged attachment deleted (no grace
  period), push-token row deleted (before `auth.signOut`, bounded 5 s,
  best-effort), expo-image memory + disk caches cleared. An *involuntary*
  sign-out (expired session) clears nothing — ownership keeps it safe.
- **Transient failures never dead-letter.** `outbox/errors.ts` classifies:
  status 0 / 408 / 429 / 5xx, network and timeout errors are *transient* —
  backed off (`transientFailures`) but never counted toward `MAX_ATTEMPTS`.
  Only rejections (other 4xx, RLS, constraints) count. Gateways throw
  `TransientSyncError` via `syncError(message, status)`.
- **Retry cannot revert a newer edit.** `retryDead()` marks a dead write `done`
  (`error: "superseded…"`) instead of reviving it when a newer write to the same
  row has already synced; `pruneCompleted` keeps that newer done write while the
  dead one exists.
- **Failed writes retry while online.** After each drain `SyncEngine` arms a
  timer for the earliest backoff (`Outbox.msUntilNextRetry`, ≥1 s, clamped to the
  max backoff); it also drains on AppState `active` and when the owner changes.
- **Every request is bounded.** `lib/fetchWithTimeout.ts` is the Supabase
  client's `global.fetch`: 30 s, 120 s for `/storage/v1/`. Polish-note and the
  data-plate scan (60 s) use it too.
- **Uploads stream from disk.** `uploadObject` uses
  `FileSystem.createUploadTask` (POST `/storage/v1/object/<bucket>/<path>`,
  user bearer, `x-upsert`) instead of base64 in the JS heap; cancelled at 120 s.
- **`callSideEffect` throws when `EXPO_PUBLIC_API_BASE_URL` is missing**, so the
  op stays queued (and eventually dead-letters, which is reported) instead of
  being marked done. It is NOT a startup requirement — sign-in still degrades
  without it.
- **Background auto-clock no longer loses offline arrivals.** Planned actions go
  into a durable AsyncStorage queue (`lib/backgroundClockQueue.ts`) with their
  original timestamps and client row ids *before* the geofence state advances;
  they replay in order on each delivery, after each outbox drain (DataProvider)
  and in the background-sync task. Network failures never drop an action; 5
  rejections do (reported as `background-clock`). A late departure never closes
  an entry opened after it.
- **PowerSync mirror wiped on a signed-out cold start.** If auth has finished
  loading with no session and a sync marker exists, the mirror is wiped
  (`signedOut` input to `runTransition`). Caveat: offline with an *expired*
  access token, supabase-js reports no session, so this also wipes — read data
  only; it re-syncs at the next sign-in.
- **Search tab filters on the server**, ≥2 characters, 50 rows (customer/site
  matches resolved to ≤50 ids each, then one OR on `jobs`). Job number matches
  exactly, not as a substring, on the remote path.
- **Session tokens are in SecureStore** (`lib/secureSessionStorage.ts`):
  chunked (1800 chars) behind a manifest that is the atomic commit,
  `AFTER_FIRST_UNLOCK` so locked-phone background tasks can read it, migrated
  from AsyncStorage on first read (plaintext deleted only after a verified
  copy), falls back to AsyncStorage if the native module is absent or a call
  fails, and ignores a Keychain session left by a previous install.
  **Check on devices** (new binary needed if the current one predates
  `expo-secure-store` being linked): an existing signed-in user stays signed in
  after the update; background clock still records with the phone locked.

### Voice-to-text — on the device, no OpenAI (12 October 2026)

"Record note" (stage notes, mobile and web) and the job **voice report** no
longer upload audio to OpenAI Whisper. Speech is recognised where it is spoken:

- **Mobile** — `mobile/lib/dictation.ts`, wrapping `expo-speech-recognition`
  (Apple / Google speech recognition, the keyboard-dictation engine). Words
  appear as the technician talks. Offline, recognition is forced on-device where
  the phone supports it; otherwise the mic explains a connection is needed.
  `en-AU`, trade terms passed as recognition hints (`TRADE_TERMS`).
- **Web** — `lib/use-browser-dictation.ts`, the Web Speech API. Chrome, Edge and
  Safari; the button is hidden where unsupported (Firefox).
- **Record note** then runs the dictated text through `/api/ai/polish-note`
  (Claude Haiku) when online — same polish as "Polish with AI"; raw text if that
  fails. Never auto-saved.
- **Voice report** — the technician reviews and can correct the text before
  saving. Queued as up to three outbox steps
  (`repositories/voiceReport.ts`): save the text (no dependency, so the words
  survive a failed upload) → upload the recording if the phone kept one (iOS,
  Android 13+; `.wav`/`.caf`) → attach the audio path. The route
  `/api/jobs/[id]/transcribe-voice-report` keeps its name for queued operations
  on phones, but now only saves; `/api/ai/transcribe-note` is deleted.
- **`expo-audio` is removed** and `expo-speech-recognition` added — both
  native, so this reaches devices only through a **new build** (13). The module
  is loaded lazily: an OTA update reaching an older binary hides the mic instead
  of crashing the job screen. `OPENAI_API_KEY` is no longer used anywhere — it
  can be deleted from Vercel and the OpenAI account closed.
- **Check on a device:** the first use asks for microphone *and* speech
  recognition permission; a saved voice report shows on the web job page.

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
- **Web Photos tab** (`components/job/job-photos.tsx`) likewise signs every
  unsigned photo in ONE `createSignedUrls` per load (it was one request per
  thumbnail) and renders thumbnails `loading="lazy"` / `decoding="async"`.
  Since 17 Oct 2026 it also **resizes before upload** with the same limits as
  mobile (`lib/image-resize.ts`, 1600px / JPEG 0.7, HEIC or undecodable files
  go up unchanged), uploads three at a time, and **reuses signed URLs** across
  visits to the tab (`lib/signed-url-cache.ts`) so the browser cache hits.
- **Grid thumbnails (18 Oct 2026).** Both grids (web `job-photos.tsx`, mobile
  `components/job/photos.tsx`) show `<jobId>/thumbs/<file>` (~400px JPEG,
  `lib/photo-thumbs.ts` / `mobile/lib/photoThumbs.ts`) when it exists and fall
  back to the original; the viewer/lightbox always opens the original. Made by
  `scripts/generate-photo-thumbnails.mjs` (dry run by default, `--commit` to
  upload; never touches an original; idempotent). Re-run it now and then to
  cover new uploads — those are already ≤1600px, so it is not urgent.
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

**0073–0076 applied 2026-10-18** (SQL editor, one at a time, each gate test passed,
ledger rows added by hand; effects re-verified read-only). The SQL editor does **not**
hold an explicit `BEGIN … ROLLBACK` across statements, so gate tests meant to be pasted
there must be one self-undoing `DO` block — see the header of
`supabase/tests/0073_deactivation_test.sql` for the pattern.

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

**Second replication outage — found 12 October 2026.** The app's PowerSync
instance (`6a5f0bf6367771958b496c5e`, sync rules v3) had stopped replicating:
its slot was `wal_status = lost`, 32 GB behind, while every client signal looked
normal. The dashboard log named the cause — `password authentication failed for
user "powersync_role"`. A **second PowerSync instance** (`6a5f0bf73ab36f9f81820437`,
not referenced anywhere in the code) has its own active slot; the likeliest
story is that `powersync_role`'s password was reset while setting that one up,
locking the app's instance out. Fixed by setting a new password, entering it in
the app instance's connection settings, and redeploying (v4, new slot
`…_4_fc97`, active, 0 bytes behind). **Open:** find out what the second
instance is — if unused, delete it and drop its slot; if used, it needs the new
password too. Lesson repeated from August: **read the PowerSync dashboard log
first** — it says exactly why, and `npm run check:sync` (or the slot query) only
says that something is wrong.

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

### The things a person has to do

Every one of these needs an account, a credential or a dashboard I cannot reach.
They are listed first because they are the only things standing between this and
a shippable release.

| | Who | Why it is not code |
|---|---|---|
| **Vercel Preview env vars** | Justin | Every PR's Vercel check fails on `Missing required environment variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY`. Proven by comparison, not inference: GitHub's `build` job runs the *identical* `next build` on the same commit and passes, because CI supplies those two. Set them on the Vercel project's Preview environment. |
| **`max_slot_wal_keep_size`** | Justin / Avi | Supabase instance config, no SQL path. Without it a slot can be invalidated again — which cost 24 hours of silent, invisible outage on 3–4 August. `npm run check:sync` now turns that failure mode into one command. |
| **EAS env vars** | Justin / Avi | `eas env:create` for the two `EXPO_PUBLIC_*` values, or a cloud build ships an app pointed at `undefined`. See SHIPPING.md **STEP ZERO**. The app now refuses to start in that state rather than failing mysteriously later. |
| **Sentry (error monitoring)** | Justin | Optional, and off until a DSN is set — see §12. Create a free Sentry org with a Next.js project (and a React Native project for the app), then set the DSNs in Vercel and EAS. Without it, failures like the weeks-long silent "Polish with AI" outage are still only discovered by accident. |
| **Turn off public sign-up** | Justin | Dashboard → Authentication → Sign In / Providers → untick **"Allow new users to sign up"**. `supabase/config.toml` now has `[auth] enable_signup = false`, but that file only configures the local stack — the hosted project still lets anyone with the anon key call `/auth/v1/signup`. Invites keep working (GoTrue's admin invite does not check this switch). Leave the **Email provider** itself enabled. |
| **`APP_URL`** (optional) | Justin | Origin for emailed reset links. Unset = `https://mellerick-app.vercel.app`, which is right for production. Set it only for a different domain, or `http://localhost:3000` in `.env.local` to test resets locally. |
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
| **D-U-N-S number** | ✅ **758246453** (MELLERICK PTY LTD, 405 Doctors Gully Road, Nutfield VIC 3099). Use these details exactly on Google Play |
| **Google Play Console** | ❌ USD 25 once, needs the D-U-N-S first |

**iOS builds are now unblocked.** They cannot be compiled on Windows — Xcode is
macOS-only — but EAS builds them in the cloud, and the signing certificates it
needs come from the Apple account, which now exists. `eas build --platform ios`
will produce an `.ipa`. What still gates *submission* is the App Store Connect
app record, which yields the `ascAppId` for `eas.json`.

**Push notifications** — APNs and FCM credentials are in EAS (Aug 2026), phones
register `device_tokens`, and the `send-push` edge function is deployed. Since
19 Oct 2026 a job assignment triggers a "New job assigned" push (migration
`0077`, trigger on `job_assignments`); tapping it opens the job from mobile
build 15. Turning it on needs a one-time secret + vault + redeploy step — see
**`docs/push-notifications.md`**.
Shared phones: `claim_device_token()` (migration `0078`) hands a phone's token
to whoever signs in on it, so one person's alerts never go to another's phone.

**`mobile/eas.json`** — `appleId`, `ascAppId` and `appleTeamId` are filled, and
the App Store Connect API key lives on EAS's servers: build 14 (19 Oct 2026)
built and auto-submitted to TestFlight with `eas build --platform ios
--profile production --auto-submit`.

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

**Prominent disclosure (13 October 2026).** Google Play rejects background
location without an in-app screen shown *before* the OS prompt. The tracking
gate now awaits `components/LocationDisclosure.tsx` before requesting either
location permission (`locationConsent()` in `lib/location-tracking.tsx`, logic
in `lib/locationDisclosure.ts`). Shown only when tracking is wanted and a prompt
could follow; "Continue" is remembered on the device, "No thanks" stops the
auto-clock for that session only. The wording is pinned by
`locationDisclosure.test.ts` — keep "location", "even when the app is closed or
not in use" and the purpose if editing. The Play declaration video must show
this screen, then both OS prompts. Native-free, but it reaches devices only in a
build made after it merged.

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
| `mobile/powersync/device-indexes.js` | Hand-maintained SQLite indexes merged into the generated device schema |
| `mobile/lib/data/reads/horizon.ts` | What the windowed mirror is guaranteed to hold; out-of-window reads go to Supabase |
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
   log is EXPECTED, not a crash.** The sync badge re-reads the outbox counts on
   outbox/drain events, every 3s only while writes are pending, and on a 30s
   heartbeat otherwise (`lib/data/syncStatusCadence.ts` — it used to be every 3s
   forever). A read already in flight when the JS context is torn down — which
   every Fast Refresh does — resumes against a released native handle. It is caught in
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
`api/jobs/transcribe-voice-report`,
`api/backflow/scan-data-plate`, `api/backflow/tests/submit`, every Xero route
that catches (callback, push-invoice, push-expense, poll-invoices, sync-now),
Google Calendar (callback, poll-calendar, sync-now, jobs/sync-calendar), and
invoice/quote email send. A **missing `ANTHROPIC_API_KEY`**
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
session**, so a broken status poll cannot flood the quota. A dead-letter
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

