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

**Which app gets a feature (Justin, 27 Nov 2026).** The website is for the
office (schedule board, POs, invoicing, Xero, reports, fleet costs, staff,
settings); the phone is for the field (my jobs, clocking and auto-clock,
photos, notes, sign-off, Day Works / truck loads, supplier orders, mistakes,
offline). **New office features are built on the web only — don't port them
to the phone.** Office/admin screens already on the phone stay and get bug
fixes, but nothing new is added to them. A field feature the office also needs
on the web is fine on both. **Exception — the schedule:** office/admin keep
changing the schedule on the phone (things change at the last minute), so the
phone's office Schedule tab (move, copy, add/edit bookings, to-do list) is
kept level with the web board and may get new features. Reason: every port doubles the work and the places
it can break.

**Two apps, two names (27 Nov 2026).** The website is **Mellerick Office**
(`app/manifest.ts`, `app/layout.tsx`; installable on a laptop from Chrome/Edge),
the phone app is **Mellerick Field**. The website's installed icon is the logo
with a dark OFFICE band (`public/office-icon-*.png`,
`public/office-apple-touch-icon.png`, made by `scripts/make-office-icons.mjs`;
the plain `icon-*.png` stay for the sidebar), an **Office** tag sits beside the
logo in the sidebar and phone-width top bar (`components/app-sidebar.tsx`), and
the sign-in card says which app is which. The manifest no longer forces
portrait (it is installed on laptops). Team handout:
[`docs/team-guide-office-vs-field.md`](docs/team-guide-office-vs-field.md).

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
in `supabase/config.toml` and in the hosted project (switched off 27 Nov 2026).

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

**Job bookings — web (stage 2; migration `0079` applied 2026-10-19, live).**
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
  failure closes and refreshes. **"Add booking" starts on today** (23 Nov
  2026, Justin: it used to copy the row above's days, i.e. the last day they
  were there); it keeps that row's hours and cost centre. The phone's Add
  booking already started on today. `?schedule=1` still auto-opens it. The
  Overview tab no longer edits the schedule or Assigned Technician (either
  write would flatten bookings via the compatibility triggers); it lists the
  bookings read-only with an "Edit schedule" button.
- **Board** (`components/schedule/`): cards are bookings, under their own
  technician (or Unassigned) on each booked day; hours = sum of the tech's
  bookings. Drag/paste moves THAT booking (`staff_id` and/or dates via
  `moveSchedule`); Shift-drop inserts a copy for the target tech (same window
  and cost centre; on another day in Week view it starts there).
- **Schedule from the board, and press-and-hold to copy (23 Nov 2026; no
  migration; office/admin only — technicians see the board as before).**
  Justin: make the web schedule like the phone's — "hit Schedule and type the
  job", and "press and hold on a job … copy … paste into another employee's
  schedule".
  - **Schedule** (toolbar, primary button; the page header's old "Schedule
    Job" → New Job is now labelled **New Job**): the job search
    (`schedule-existing-job-dialog.tsx`, unchanged rules) → pick → banner
    "Click a technician's day to schedule #123 — Esc to cancel" (or "Open its
    schedule" for no day) → the click opens that job's **`ScheduleJobDialog`
    as a modal over the board** with a new row for that technician and day
    (the same `prefill` path). The "+" on a technician's day searches, then
    opens the dialog straight away. Save refreshes the page, which redraws the
    board. The dialog's data is read by `components/schedule/board-schedule-dialog.tsx`
    through `lib/schedule-dialog-data.ts` — the same helpers the job page now
    uses (`costCentersFromPurchaseOrders`, `bookingsForScheduleDialog`,
    `appendInactiveStaff`; PO lines read without any amount; tested in
    `tests/unit/schedule-board-actions.test.ts`). The job page's
    `?schedule=1&tech=&day=` link still works (nothing on the board uses it now).
  - **Booking menu**: press and hold a booking still for 500 ms (mouse, pen or
    finger), or right-click it → Copy to another technician or day / Cut
    (move) / Edit this job's schedule… / Open job / Back to to-do list
    (`components/schedule/booking-hold-menu.tsx`; items in `bookingMenuItems`).
    **Copy** → "Click a technician's day to paste a copy of #123 — Esc to
    finish" (Done): every click pastes a copy there with the Shift-drop rules
    (`planBoardAdd`: same hours, shape, cost centre and note, starting on the
    clicked day); a duplicate or Unassigned is refused with a reason
    (`copyRefusal`), a closed job refused, and a clash with their other
    bookings (`newBookingClashes`) or leave asks "Book anyway" — Shift-drop and
    Shift-paste now ask on a clash too. Cut is the old double-click cut.
  - **Hold vs drag** (`components/schedule/board-actions.ts`, tested):
    `BoardPointerSensor` picks dnd-kit's activation per press — mouse/pen drag
    once moved 6 px (no hold needed), touch keeps the 200 ms hold-then-move. A
    hold is cancelled by the same 6 px (8 px on touch), so a mouse press is a
    drag or a menu, never both. On touch the drag starts at 200 ms and the menu
    opens at 500 ms if the finger hasn't moved; letting go there leaves the
    booking where it was with the menu open, moving on drags it and closes the
    menu. The click a hold's release makes is swallowed (no job opened).
    One mode at a time — cut, copy, placing a to-do job, scheduling a searched
    job — in `boardModeReducer`; Esc ends any of them. Double-click to cut and
    Shift-drag still work.
  - Checked in Chromium with mock data (desktop 1500 px and iPhone 13, touch
    via CDP): Schedule → search → click Dan's Friday → dialog on Dan/Friday →
    Save wrote the booking with its cost centre and pending → scheduled; "+"
    → dialog on that tech/day; hold → menu (release kept it open, no
    navigation) → Copy → pasted on two technicians, a third paste refused as a
    duplicate, Esc ended it; right-click menu; mouse drag and hold-then-drag
    still move; touch hold → Copy → two pastes; touch drag still moves; Day
    view right-click → Cut → paste. Not yet tried on a real iPad/iPhone Safari.
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

**Bookings always ask for a cost centre (19 Nov 2026; no migration).**
Justin: "When scheduling technicians to a job it doesn't ask you for a cost
centre. Quite often we have folks on multiple days on the same job achieving
different tasks to different costs." A booking's cost centre is one of the
job's PO lines (`job_bookings.cost_center_id` → `po_cost_centers`); it was
optional and hidden on jobs with no PO lines. Now every path that makes a
booking asks, and Save/Book waits for one. Several rows with different
technicians, days and cost centres on one job still work as before.
- **Rules** (`lib/booking-cost-centre.ts`, pure, names and ids only; mirrored
  byte for byte from the first export at `mobile/lib/bookingCostCentre.ts`,
  `tests/unit/booking-cost-centre-mirror.test.ts`; tested in
  `tests/unit/booking-cost-centre.test.ts`): default = the booking above's,
  else `jobs.scheduled_cost_center_id`, else the job's only line, never a line
  the job doesn't have (`defaultBookingCostCentre`); "Pick a cost centre"
  (`bookingCostCentreProblem`); the company cost centres the job has no line
  for (`addableCostCentres`, tagged id or same name); where a new line goes
  (`planBookingLine`).
- **"Add to this job"**: the picker lists the job's PO lines, then the
  company cost centres (`cost_centres`, 0087) it doesn't have. Picking one
  calls `POST /api/jobs/[id]/booking-cost-centre` (`requireOfficeOrAdmin`,
  every read and write as the CALLER via `callerClient`, fixed sentences, no
  money in the answer): it reuses a line already tagged with that cost centre,
  else adds a line named after it with nothing allocated (amount 0, hours 0)
  to the job's FIRST PO, else makes the job's `<job number>-1` PO
  (`nextJobPoNumber`) with value 0 first. The PO's value is left as it was.
  `applyToBookings: true` also gives the job's bookings with no cost centre
  that line. `poId` (optional, a client UUID) makes a retried PO insert
  idempotent.
- **Web Schedule dialog** (`components/job/schedule-job-dialog.tsx`): every
  row has a required Cost centre picker (`components/job/booking-cost-centre-select.tsx`);
  a row with none says "Pick a cost centre" in its header, and Save opens it
  and refuses. A line added from the picker re-reads the job page's POs.
- **Web board to-do drop** (`team-schedule-view.tsx`): a drop or tap-to-place
  first opens `components/schedule/booking-cost-centre-dialog.tsx` (Cancel =
  nothing booked); `planTodoDrop` takes `costCenterId` (mirrored in
  `mobile/lib/todoBoard.ts`). Board moves and Shift-copies keep the source's
  cost centre, as before.
- **Web New Job**: with a start date, a required "Cost centre for the
  booking(s)" (a company cost centre; defaults to the PO split's only one).
  After the job, crew and PO are saved, the route above is called with
  `applyToBookings` — the line comes from the PO split, or is added — then
  the calendar sync. If it fails the job opens with `?schedule=1`.
- **Phone Schedule Job sheet**: the cost centre step is always shown and
  required (`mobile/components/schedule/CostCentrePicker.tsx`); a booking
  with none lists "No cost centre — edit to pick one". **Phone to-do place**:
  the alert became `PlaceTodoSheet` with the picker. **Phone New Job**: a
  required company cost centre when scheduled; `JobsRepository.createJob`
  queues a `booking-cost-centre` side effect (after the crew, before the
  calendar sync) to the same route, so it works offline once the company list
  has been read once this session (`mobile/lib/bookingCostCentreOptions.ts`
  keeps it in memory; the list is in no PowerSync stream).
- **Online only on the phone:** adding a company cost centre to a job ("Adding
  a cost centre needs signal."); offline the job's own lines can still be
  picked. Reaches phones with the next build (no native module); the web must
  be deployed first (the route).
- Not changed: old-style writers (approvals, the crew picker's
  `set_job_assignments`, the calendar poll) still don't pick a cost centre —
  0079 copies the job's one window and cost centre, as before.

**Job complete closes only the stage when others are open (22 Nov 2026; no migration).**
Justin: "check that when a job is marked as complete, it is only that cost
centre / that stage of the job, not the whole job." Stages are the job's
builder PO lines (`po_cost_centers`, `completed_at` from 0095); bookings and
clock entries point at the same ids. Before, "Job complete" (phone and web,
customer signature or "customer not on site") always closed the whole job —
and 0096 then refused bookings for the other cost centres.
- **Rule** (`lib/stage-completion.ts`, pure, names and ids only — never an
  amount; mirrored from the imports on at `mobile/lib/stageCompletion.ts`,
  `tests/unit/stage-completion-mirror.test.ts`; tested in
  `tests/unit/stage-completion.test.ts`): no stages or one open stage → the
  job closes exactly as before, and that one open stage is marked complete
  too. Two or more open → the sign-off lists them as tick boxes, pre-ticking
  the signer's own bookings' stages that occupy today (0071 day rules), else
  the stage they're clocked into, else none; at least one must be ticked. The
  ticked stages are marked complete and the job STAYS OPEN ("The job stays
  open for the other stages: X, Y.") — unless they are all the open ones,
  when the job closes as before. The confirm names the stages that close.
- **When only stages close:** no `jobs` write at all (status, `completion_notes`,
  `ready_to_invoice`, calendar untouched). The signature photo is still saved
  against the job; the sign-off goes to `job_notes` (`source:
  "stage_complete"`, badged "Stage sign-off"), and the signer is clocked off.
- **Phone** (`components/job/signature.tsx`, `SignatureRepository.signOff /
  completeAsTechnician` with `stages`, through the outbox): the stage list
  needs signal (`loadJobStages`); without it the screen says "Couldn't check
  the job's stages — this will close the whole job" and behaves as before.
  Stage completions are `stage-complete` side effects; with a signature they
  (and the note) depend on the photo upload, and when the job closes they
  depend on the jobs update. `getOpenWorkEntryOnJob` now also returns the
  entry's `costCenterId`. Reaches phones with the next build (no native module).
- **Web** (`components/job/job-signature.tsx`): the same rule; stages from
  `GET /api/jobs/[id]/stages`, marked through the existing
  `POST …/stages/[stageId]/complete`. The Overview's status drop-down set to
  Completed while stages are open asks first, naming them (`openStagesWarning`);
  it doesn't block.
- **"Finish for today" never closes a stage** (Justin, 22 Nov 2026: "They
  could be going back to that cost centre tomorrow"): it records the day's
  note and clocks off, nothing else — its stage tick boxes are gone. Stages
  are closed only by the **Stage / job complete** step (the tab was "Job
  complete") or the office's PO tab.
- **Not changed:** the office's status drop-down itself, the PO tab's stage
  controls.
- **Office can complete / reopen a stage from the PO tab (fixed 27 Nov 2026).**
  `POST …/stages/[stageId]/complete` used `requireUser`, which leaves the role
  null, so office/admin not on the job's crew got "Only the crew on this job
  can complete its stages" (Emma: couldn't mark Brodie's Camera Inspection
  stage complete for him). It now uses `requireRole(admin, office,
  technician)`; the test mocks only `requireRole`, so a regression fails.

**Mistake costs per cost centre (23 Nov 2026; migration `0115` applied 2026-11-25).**
Justin: "We also need a way of tracking the expense of mistakes in each cost
centre that will be a negative cost." His choices: the office logs them
(office/admin only), and they reduce the job's margin, shown as their own line.
- **Table `job_mistakes` (0115):** id, `job_id` (cascade), `cost_center_id` →
  the job's PO line (`po_cost_centers`; null = "Not tagged"; set null when the
  line is deleted), `occurred_on` (default Melbourne today), `amount_ex_gst`
  (> 0), `description` (1–2000), `cause` (≤ 500, optional), `staff_id` (whose
  mistake, optional), `entered_by` (forced to the caller), created/updated.
  Trigger `job_mistakes_guard` refuses a cost centre from another job's PO
  (23514). **RLS: one FOR ALL policy, `is_office_or_admin()`** in USING and
  WITH CHECK — a technician reads and writes nothing, even on their own job.
  Granted to authenticated + service_role, revoked from anon; asserted at the
  end of the migration (exact policy set, grants, trigger, money-named
  amount, NOT in the `powersync` publication). In no sync stream —
  `sync-streams.yaml` untouched. CI's `seed-roles.sql` seeds one row so the
  money sweep checks `amount_ex_gst` with real data.
- **Ledger** (`lib/job-ledger.ts`): `mistakes` input; each row gets a
  `mistakes` figure that is part of `cost`, so per-cost-centre and job
  margins drop by it; untagged → "Not tagged". `costCentreTotals` carries it.
  Costing tab's Job Ledger (admin) shows a **Mistakes** column when any exist
  (it reads them itself); Reports → Job margins (admin) adds "Of which
  mistakes" to the by-cost-centre and per-job tables.
- **Entry** (`components/job/job-mistakes.tsx`): a **Mistakes** card under the
  job's **Purchase Orders** tab — that tab is office AND admin (Costing is
  admin only), never technicians. List (date, cost centre, what went wrong,
  cause, whose, cost), Log / edit / delete, browser writes as the caller like
  the rest of the PO tab. Rules `lib/job-mistakes.ts` (`buildMistakeRow`).
- **Report:** Reports → **Mistakes** (`app/dashboard/reports/mistakes`,
  office/admin, linked from the Reports header): last 12 months × company
  cost centre (the line's `cost_centre_id`, else "Not tagged"); click a month
  or a cell for the list with job links. Sums `lib/mistakes-report.ts`
  (tested in `tests/unit/mistakes-report.test.ts`).
- **No phone changes** — the office uses the website.
- **Before 0115 is applied nothing breaks:** readers treat
  42P01/PGRST205/42703/PGRST204 as "no mistakes"; the card and the report
  say mistake costs aren't switched on yet; the ledger has no Mistakes column.
- **Checked** on a scratch Postgres 16 (minimal shim: roles, `auth.uid()`
  from `request.jwt.claims`, profiles, `is_office_or_admin`, jobs/POs/lines):
  0115 applies twice cleanly; the gate test passes (17 scenarios) and fails,
  naming scenarios, with an extra permissive SELECT policy, with a loose
  FOR ALL policy in place of the office one, or with the guard trigger and
  amount check dropped.
- **Apply order:** paste `supabase/migrations/0115_job_mistakes.sql` → paste
  `supabase/tests/0115_job_mistakes_test.sql` (needs an active technician and
  an active office/admin), trust only `0115 PASSED` → change 0115's STATUS
  line to applied, add the ledger row, regenerate types
  (`lib/database.types.ts` has the table by hand). No PowerSync redeploy.
  The web may merge before or after.

**Address search on the map pin, drag & drop / paste on Photos and Documents (24 Nov 2026; no migration; web only).**
Justin: "no search function to look for the address — only a map to click
on", and "Photos or adding docs — can't drag & drop".
- **Map pin search.** The only click-the-map picker is
  `components/site-location-dialog.tsx` (job Overview "Set location on map /
  Adjust map pin", and Customer → each site's **Set pin / Pin**). It now has a
  search box prefilled with the site's address, **Search** (or Enter) and
  one-click **Find this address**. Matches list below; a building-level match
  moves the pin there and recentres; a street/suburb match is labelled
  **Approximate** and only recentres the map (zoom 17) — the user clicks the
  exact house or lot, because a street centroid can be hundreds of metres out
  for a 150 m fence. Dragging/clicking still nudges the pin; nothing is saved
  until **Save location** (same browser write as before, sites office-writable
  by 0064). Server: `GET /api/geocode?search=1&q=…` — **office/admin only**
  (`requireOfficeOrAdmin`), same per-user limit as the plain lookup, 3–200
  chars, fixed sentences; up to 6 Australian Nominatim matches shaped by
  `shapeAddressSuggestions` (`lib/geocode.ts`: precise first, near-duplicates
  dropped, label "12 Smith Street, Epping, …"; tested in
  `tests/unit/geocode.test.ts`, route in `routes-auth.test.ts`). The plain
  `?address=` lookup, the hourly geocoder, the script and Add site keep
  accepting building-level matches only. **No search-as-you-type** —
  Nominatim's usage policy forbids autocomplete. The PO tab's site address and
  the Add site dialog geocode typed text and have no map, unchanged.
- **Drag & drop and paste.** `components/ui/file-drop-zone.tsx` wraps the
  whole Photos tab (`job-photos.tsx`) and Documents tab (`job-documents.tsx`
  — it replaces that tab's older list-only drop handlers): a highlighted
  overlay while files are dragged over, several files at once, **Ctrl/Cmd+V**
  of a screenshot or a copied file while the tab is showing (not while typing
  in a field or with a dialog open), and an image dragged from another tab or
  an email when the browser hands over the file (an inline `data:` image is
  rebuilt; a plain web link gets "save it first"). Everything goes through the
  tab's existing upload path: Photos resizes (`lib/image-resize.ts`) and
  uploads 3 at a time with the Before/After/General tag picked; Documents
  uploads to the folder chosen beside the button (default Other since 0116; Photos the folder picked —
  move afterwards as before), not office-only, same paths and RLS. Refused
  types (the Upload button's own accept list, now also checked on drop/paste;
  folders too) are named in a toast. Pasted screenshots are renamed
  `pasted-YYYYMMDD-HHMMSS.png`. Disabled on view-only jobs. Rules
  `lib/file-drop.ts` (tested, `tests/unit/file-drop.test.ts`). The
  single-file form box is still `components/ui/file-dropzone.tsx`.
- Checked in Chromium with a mock Supabase: two PNGs + a PDF dropped on Photos
  (2 uploaded, the PDF refused by name), a pasted image saved as
  `pasted-….png`, a PDF + a .txt dropped on Documents with Drainage chosen
  (PDF saved to Drainage, .txt refused), Find this address → pick → pin and
  coordinates moved; an Approximate pick recentred and left the pin.

**Job folders for documents AND photos (24 Nov 2026; migration `0116` applied 2026-11-25; PowerSync streams to redeploy).**
Justin: the 0114 document folders (Site Documents / Drainage / Plumbing /
Soil) become **Drains, Soil & Rock, R1, R2, Rough In, Fit Off, Camera
Inspections** (+ **Other** = NULL), and **photos get the same folders** on the
website and the phone; technicians pick the folder when taking a photo.
- **Migration `0116_job_folders.sql`:** keys `drains`, `soil_rock`, `r1`,
  `r2`, `rough_in`, `fit_off`, `camera_inspections`. `job_documents.folder`:
  0114's check dropped BY DEFINITION (enumerated from `pg_constraint`, not a
  guessed name), existing rows remapped (Justin's choice: `drainage` → Drains,
  `soil` → Soil & Rock, `site_documents` / `plumbing` → Other; nothing
  deleted), new `job_documents_folder_check`. New `job_photos.folder text`
  with the same check (`job_photos_folder_check`). No new grants needed —
  both tables are granted at table level (no column grants); asserted
  (select/insert/update for `authenticated`). Who may set a folder is the
  existing RLS: documents 0065/0074 (office-only stay office/admin), photos
  0074 (the job's crew and office/admin). End state asserted: exactly one
  folder check per table with the new list, no old values left, not
  money-named, `job_photos` still in the `powersync` publication (whole
  table, so the column replicates).
- **Gate test** `supabase/tests/0116_folders_test.sql` (one self-undoing DO
  block; needs an active technician and office/admin): no document left on
  an old key; old/unknown keys refused and all 7 new keys accepted on both
  tables; NULL allowed; the job's technician files their job's photo, adds a
  photo straight into a folder and files a document, but not a photo on a
  job they aren't on nor an office-only document; office files any photo.
  **Checked** on a scratch Postgres 16 (minimal shim: roles, `auth.uid()`
  from `request.jwt.claims`, profiles/customers/jobs, `user_can_manage_job`,
  the 0074 restrictive policies, 0114 applied with legacy rows): 0116 applies
  twice cleanly, remaps (drainage→drains, soil→soil_rock, the rest Other),
  `0116 PASSED`; fails naming scenarios with job_photos' update policy dropped
  plus an old key allowed, and with documents left on 0114 keys under the old
  check (re-running 0116 then fixed it and passed).
- **Rules** (`lib/document-folders.ts`, one list for documents and photos,
  mirrored byte for byte below the header at `mobile/lib/documentFolders.ts`,
  `tests/unit/document-folders.test.ts` — which also pins the list to 0116's
  two checks): labels/order, `folderValue` (Other → null),
  `DEFAULT_FOLDER_GROUP` = **Other** (none of the stage folders is a safe
  guess for an unsorted upload, and every legacy row is already there). The
  old keys are **read** as 0116 maps them (so a database without 0116 shows
  the right folders) and **accepted** from an older phone build's request
  (mapped the same way). `isFolderNotSwitchedOn` = the column is missing, or
  0114's check refused a new key (23514 naming folder).
- **Web Documents tab:** the new folders; the upload picker lists them plus
  Other (default Other). **Web Photos tab** (`components/job/job-photos.tsx`):
  grouped by folder with counts, collapsible; a folder picker beside the
  Before/After/General one for uploads; a "move to folder" select on each
  photo (on hover) for everyone who can edit the tab (the crew and
  office/admin — RLS 0074). Hidden on view-only jobs.
- **Phone Photos tab** (`mobile/components/job/photos.tsx`): "New photos go
  in" folder chips above the buttons (also on the timestamp camera's preview),
  remembered per job on the phone (`mobile/lib/photoFolderMemory.ts`,
  AsyncStorage, tested); grid grouped by folder, collapsible; the viewer has
  a folder button → "Move photo to" sheet. Writes through the outbox: the
  photo insert carries `folder` only when filed
  (`JobPhotosRepository.add`), a move is a one-column update
  (`JobPhotosRepository.setFolder`, `usePhotoLibrary().movePhoto`); a move
  still queued stays on screen across reloads. Reads: `listJobPhotos` selects
  `folder` (local and remote; the remote retries without it on 42703/PGRST204
  and answers `folder: null`). **Phone Documents** (office/admin): the new
  folders on upload and move, through the existing routes.
- **Stream change:** `tech_job_photos` in `mobile/powersync/sync-streams.yaml`
  now lists `folder` (no money; the contract test passes);
  `office_job_photos` is `job_photos.*`. `folder` added to
  `mobile/lib/powersync/schema.ts` by hand. Not validated with
  `@powersync/service-sync-rules` here (not installed in this checkout).
- **Before 0116 is applied nothing breaks:** document uploads that 0114's
  check refuses are saved under Other (web browser upload and
  `POST /api/jobs/[id]/documents`); a document move answers "folders aren't
  switched on yet" (web toast, route 409); old document keys show in their
  new folders; web photo uploads retry without `folder`, and with no `folder`
  key on the rows the move controls hide; the phone's gateway drops
  `job_photos.folder` from queued writes (`mobile/lib/data/optionalColumns.ts`)
  — a photo lands under Other, a folder-only move is done with nothing to
  write — so nothing dead-letters.
- **Apply / deploy order:** paste `supabase/migrations/0116_job_folders.sql`
  → paste `supabase/tests/0116_folders_test.sql`, trust only `0116 PASSED` →
  change 0116's STATUS line to applied, add the ledger row, regenerate types
  (`lib/database.types.ts` has `job_photos.folder` by hand) → **redeploy the
  PowerSync streams** (`docs/powersync-deploy.md` — `tech_job_photos` names
  `folder`, so not before 0116) → merge web → ship the phone build (no new
  native module).
- **Not done:** folders can't be renamed or added (a fixed list, a check
  constraint); signature and docket photos are filed like any other photo
  (under Other) — the job report and docket rules don't look at folders.

**Five October migrations were never applied (found 24 Nov 2026; catch-up `0117` applied 2026-11-24 — `CATCH-UP PASSED`, then a read-only check of production found nothing from 0060–0116 missing after 0114–0116 went in on 25 Nov).**
A read-only check against production (every migration 0060–0116 by a column,
table, index, trigger or policy it creates) found **0064, 0065, 0066, 0067 and
0070 missing**, although their headers and this file said "applied 8–15 Oct".
Most likely each paste raised and rolled back while only a quiet notice showed
(the same failure as 0089/0090/0092, §1 "Migration pastes"). Effects until the
catch-up: technicians could update/archive/delete sites (0064); office-only
documents didn't exist, so the Simpro attachments with prices were visible to
technicians in the app and through the API (0065 — **the money rule**);
phone-signed backflow tests dead-lettered (0066); the office to-do list was
hidden everywhere (0067); some list pages lacked indexes (0070). 0114 (and so
0116) also failed on it — 0114's gate test uses `office_only`.
- **Fix:** one paste = 0067, 0070 as written, then **`0117`**, which does
  0064's, 0065's and 0066's job. 0066 as written failed in the SQL editor
  (`relation "m0066_other_storage_policies" does not exist` — its temp table
  did not survive between statements there; likely why it never went in), so
  0117 keeps every before/after snapshot inside one DO block. 0064/0065 lose
  their "drop every policy" step: 0074 and 0110
  have since added RESTRICTIVE policies on `sites` / `job_documents`, which
  0064/0065 would have dropped (then failed their own "0 restrictive"
  assertion). 0117 drops only permissive policies, by enumeration, writes the
  calls wrapped (0069's form), widens `storage_object_is_money_document()`,
  re-creates the backflow-certificates policies, and asserts every
  restrictive policy and every other storage policy is unchanged. **Don't use
  temp tables in a migration meant for the SQL editor.** Idempotent; on CI (where
  0064/0065 ran) it ends in the same rules.
- **Checked** on a scratch Postgres 16 built like production (the full chain
  with 0064–0067 and 0070 skipped, then CI's seed): catch-up → `CATCH-UP
  PASSED`; then the 0114, 0116 and 0115 pastes each `PASSED`. Also the full
  chain 0000–0117 in order, and 0117 re-run.
- **Lesson:** a header saying "applied" is not evidence. Check production
  for an object the migration creates (the check query is in this PR's
  conversation; `npm run check:migrations` compares headers to the ledger).
- **Applied** 2026-11-24 (catch-up) and 2026-11-25 (0114, 0116, 0115); headers marked. Still to do: ledger rows (§7), and
  run `scripts/audit-job-documents.mjs` (dry run, then `--commit`) to flag the
  Simpro attachments that show prices as office-only.

**Web and phone schedules aligned: completed jobs on the web board, "Over allowed hours", no 1,000-row cap (24 Nov 2026; no migration, no stream change).**
Justin: "The 2 schedules not aligned … it needs to be the same as the mobile
so it's visible when jobs have been completed, with an alert for the jobs that
have gone over the allocated time."
- **Completed jobs on the web board** (`app/dashboard/schedule/page.tsx`): as
  well as every open scheduled job, the page now loads COMPLETED jobs (never
  cancelled) whose window touches the board's dates — `boardLeaveRange()`, 60
  days back to 300 ahead — with their bookings (the phone loads completed jobs
  for the days on screen; same filter: `scheduled_start < to` and
  `scheduled_end >= from`, or no end and `scheduled_start >= from`). Read-only
  and greyed (`team-schedule-view.tsx`): dimmed card, ✓ and "Completed" on
  the Week chip, the status pill on the Day card; dnd-kit drag disabled, no
  resize handles (as before for closed jobs), double-click cut and paste
  refused with "#n is completed — its bookings can't be moved.", and the hold
  / right-click menu offers only **Open job** (`bookingMenuItems`, closed →
  `[open]`). A click still opens the job. Like the phone, they count toward a
  technician's booked hours that day (and so the "N h free" gap) and toward
  "already booked then" clash prompts; unlike before on the phone, neither
  side flags a completed job's booking **Needs reassigning** (it can't be
  reassigned) — the phone's `reassign` now leaves completed jobs out too. The
  web List tab was open work only until 27 Nov 2026 (see "List tab shows
  what's done", below; the phone's List still has no completed jobs); the
  header's "N scheduled jobs" counts open jobs.
- **The 1,000-row cap.** PostgREST answers at most 1000 rows per request
  (`max_rows`) without an error, so past 1000 the two schedules silently
  dropped DIFFERENT rows. Web: the board's jobs reads (open and completed, with
  every column fallback) go through `lib/fetch-all-rows.ts`, ordered
  `scheduled_start, id` (its failure result now also carries the PostgREST
  `code`, so the 42703 / missing-table fallbacks still work); the cost-centre
  name read is chunked (100 ids). Embedded `job_bookings` aren't capped per
  job. Phone: new `mobile/lib/data/reads/pagedRows.ts` (`readAllPages`,
  `chunkIds`, `mergeResults`; tested) pages the Schedule tab's open-jobs read,
  its completed-jobs read, `listOpenJobBookingsRemote` (ordered `starts_at,
  id`) and `listJobBookingsForJobsRemote` (chunked + paged).
- **"Over allowed hours"** — office/admin only on both (technicians see the
  boards as before; the web page doesn't even read the hours for them). Rule
  `lib/over-hours.ts` (pure, `tests/unit/over-hours.test.ts`), mirrored from
  the first export at `mobile/lib/overHours.ts`
  (`tests/unit/over-hours-mirror.test.ts`):
  - **Allowed:** each builder PO line's `allocated_hours`
    (`po_cost_centers_public`); the job's total = the lines' sum, or — when no
    line has hours — the POs' `total_hours` (`purchase_orders_public`). Both
    money-free views; no amount/value/rate column is selected anywhere
    (pinned by `tests/unit/over-hours-data.test.ts` and the phone's
    `reads/overHours.test.ts`).
  - **Used:** `time_entries` on the job, WORK only (travel never counts — as
    the technicians' hours scoreboard, `lib/hours-scoreboard.ts`); a closed
    entry its `hours`, an open one the live time since `clock_in`. Unlike the
    scoreboard (which takes only the first open entry), every open entry
    counts — several crew can be clocked on at once. Per line by the entry's
    `cost_center_id`; entries with no or another cost centre count only to
    the job total.
  - **Per booking:** its own cost-centre line when that line has allowed
    hours and is over ("Over hours: 34 h of 30 h (Drainage)"), otherwise the
    whole job when its total is over ("Over hours: 120 h of 100 h"). Over =
    used > allowed after rounding both to 0.1 h. Nothing allowed → never
    flagged. Completed jobs included.
  - **Web:** the page reads hours for the board's jobs as the CALLER
    (`lib/over-hours-data.ts` `loadJobHours`: `.in()` in chunks of 100, every
    chunk paged; a failed read = no badges, never a partial total) and passes
    a plain object to the board. Cards get an amber "Over 34 h/30 h" tag (the
    full sentence on hover); above the board **"N jobs over their allowed
    hours"** opens the list (job link, each over line / the whole job, used of
    allowed), worst first (`components/schedule/over-hours-summary.tsx`).
  - **Phone:** `mobile/lib/data/reads/overHours.ts` `listJobHours` (online,
    best-effort, same reads) for every job on screen; grid blocks get an amber
    border and "⚠ Over 34 h/30 h ·", the booking's menu sheet shows the full
    sentence, List rows a "⚠ Over hours ·" prefix, and a bar under the to-do
    buttons "N jobs over their allowed hours" opens the list (tap → the job).
- Checked in Chromium with mock data (1500 px): a completed booking greyed
  with "Completed", right-click menu = Open job only, not in the List tab; two
  over-hours tags (a line and a whole-job alert, the completed job included)
  and the header list. Phone not yet checked on a device; it reaches phones
  with the next build (no native module).

**List tab shows what's done: completed jobs and stage ticks (27 Nov 2026; no migration, no stream change; web only).**
Emma: the office wants to see at a glance on the Schedule page's **List** tab
whether each job has been completed, without clicking into it.
- **Completed jobs listed** (`components/schedule/team-schedule-view.tsx`,
  rule `listSection` in `lib/schedule-list.ts`): a COMPLETED job (never
  cancelled) whose bookings fall on today or a later day is now in Today /
  Upcoming beside the open work — greyed, with a green **"✓ Completed"**
  pill instead of the status pill. Completed jobs booked only on past days
  stay off the list (they're on the Week/Day board). Open work is listed as
  before (past-dated open jobs under Upcoming). Today is now sorted by
  today's start time; Upcoming by first booked day, as before. Data: the
  completed jobs the page already loads for the board.
- **Stage ticks per row** (`listStages` / `listStagesLabel`): under each row,
  the stages (PO lines, `po_cost_centers`) of that day's bookings — Today:
  bookings on today; Upcoming: bookings from today on (all, for past-dated
  open work) — each once, with a green ✓ when its `completed_at` (0095) is
  set: "Sewer ✓ · Stormwater". The page's cost-centre name read
  (`app/dashboard/schedule/page.tsx`, chunked, from the money-free
  `po_cost_centers_public` view, which has `completed_at` since 0118) now
  selects `id, name, completed_at` — never an amount — and retries names only
  if the view lacks the column. `BoardBooking` gained the optional
  `cost_center_completed_at` (mirrored at `mobile/lib/boardModel.ts`; the
  phone doesn't use it). Tests `tests/unit/schedule-list.test.ts`.
- Not checked in a browser.

**Web board drawn like the phone's schedule, and a hover card with the job's details (25 Nov 2026; no migration, no stream change; web only).**
Justin: "Confirm that the web and the mobile app have the same looking
schedule. We prefer the mobile app's schedule … hover over it on the web app
with the mouse, it brings up all the job's details … the full address and
everything."
- **What differed** (before this change): web **Day** was a column of big
  cards per technician (avatar header, time, status pill, title, cost centre,
  note, "Day 2 of 3", customer, Waze link), not a timeline; the phone's Day is
  technicians down the side × hours across, each booking a block spanning its
  hours, overlaps in lanes, a red now-line. Web **Week** had the same row ×
  day grid as the phone, but white cards with five lines of text, an avatar
  per name and a two-line day header; the phone's blocks are tinted in the
  job status's colour with a thick left edge, "#123" + technician tag, then
  flags (✓/Completed, Needs reassigning, ⚠ Over x/y) and the title (Week: the
  start time first). Completed: phone slate + dashed border, web faded. Over
  hours / leave: phone amber / rose border + inline text, web badges and a
  ring.
- **Now the web uses the phone's model:** Day is a timeline
  (`team-schedule-view.tsx`, `DroppableTimelineRow`) laid out by the phone's
  own rules — `dayTimelineHours` (6:00–19:00, widened to fit) and
  `layoutDayRow` (positions + lanes, leave in the top lane). Those rules moved
  to **`lib/schedule-grid.ts`**, the web file first; `mobile/lib/scheduleGrid.ts`
  is its byte-identical copy below the imports
  (`tests/unit/schedule-grid-mirror.test.ts`). The only change to the rules:
  `layoutDayRow` takes optional `GridSizes` (hour width, lane height) — the
  phone passes none and is unchanged; the web draws 84 px per hour and a
  62 px lane. Unassigned row first, then busiest; names pinned left, hours
  pinned on top. Every block (Day, Week, drag overlay) is one
  `DraggableBlock` + `BlockBody` in the phone's order and colours
  (`lib/schedule-block-tones.ts` = the phone's `statusColors`, pinned by the
  same test). Week name cells lose their avatars; the day header is one line;
  each cell stacks leave first, then bookings, with hours / "N h free" / "+"
  underneath (where the phone has its gap strip).
- **Kept / deliberately different:** the web block has a third line (cost
  centre · booking note) — the phone shows those in its sheet; the Week view
  is still a CSS grid (equal row heights do what `layoutWeekRow` does); Week
  times read "07:00 am" (the web's `formatTime`). Every behaviour is as
  before: drag (a Day drop on a row changes the technician only, as on the
  phone and as the web Day columns did), Shift-copy, Week edge resize,
  double-click cut / paste, press-and-hold / right-click menu, copy mode,
  to-do drag in/out and tap-to-place, gaps, leave tiles and the leave confirm,
  completed read-only, over-hours, notes, List tab. The customer name and
  Waze link left the blocks — they are on the hover card (and the List tab).
- **Hover card** (`components/schedule/booking-hover-card.tsx`, content
  `lib/schedule-hover.ts`, tested in `tests/unit/schedule-hover.test.ts`):
  rest the mouse on a booking 350 ms (mouse only — touch keeps hold-for-menu;
  Tab focus shows it too) → job number/title, status, priority (unless
  normal), customer billed as on invoices (`billingName` + Attn), the **full
  site address** (site name, street, line 2, suburb state postcode) with
  Navigate, the site's contact/access notes (`sites.notes`), technician,
  day/time and "Day 2 of 3 · Mon 23 – Wed 25 Nov", cost centre, the booking
  note, everyone else on the job that day with their hours, the description
  (trimmed) and the over-hours / leave flags, plus **Open job**. It closes on
  leaving (150 ms grace to reach Open job), any press, scroll, Esc, and never
  shows during a drag, resize, the menu or a pick mode. **No money** —
  nothing in it can carry an amount (asserted in the test).
- **Data:** the page's board select adds `jobs.priority, description`,
  `customers.company`, `sites.address_line2, postcode, notes` (all baseline
  columns; no extra request, still paged). Description and site notes are
  trimmed to 600 characters on the server, and a technician receives them
  only for jobs they're on (`boardTextForViewer`) — the board draws only
  those jobs' bookings for them anyway (0107). `BoardJob` (both mirrors)
  gained the optional fields.
- **Per-booking tags** (e.g. a future "Added by technician"): render them in
  `BlockBody` (web, `team-schedule-view.tsx` — used by Day, Week and the drag
  overlay) and in `Block` (phone, `mobile/components/schedule/ScheduleGrid.tsx`,
  the `blockTitle` line).
- Checked in Chromium with mock data at 1500 px: Week and Day draw like the
  phone; hover shows the card with the full address; right-click menu; drag
  onto a technician's row (the leave confirm on a sick day, the write
  otherwise); Week edge resize; completed greyed; over-hours tagged; Tab
  focus opens the card. Not tried on a real touch device (touch paths are
  unchanged).

**Load page data on the server, not in the browser.** A browser→Supabase
query from Australia costs ~100 ms+; a server query in `sin1` costs ~2 ms. So
My Jobs, Approvals, Staff, Fleet and Customers are server pages that pass
initial data (and the role, from `getViewer()`) to their client UI, and lists
search/paginate in the database (Customers `?q=&page=`, Quotes/Pricing "Load
more", the customer picker queries as you type, max 20). `lib/fetch-all-rows.ts`
takes a query *builder function* and fetches pages 2..n in parallel — a
Supabase query object mutates its own range, so pages cannot share one.

**Scheduling notes belong to the booking (migration `0109` applied 2026-11-16).**
Justin, 16 Nov 2026: "When we schedule people and we have a schedule note,
that note needs to be just for that schedule and not carry on every time the
job is opened." Before: the note was only a `job_notes` row (`source:
"schedule"`, 0062) and the phone's Overview banner showed the job's LATEST
such note forever. Now:
- **Stored on each booking:** `job_bookings.note` (text, ≤2000, 0109). The web
  Schedule dialog has a note per booking row (inside the row editor; several
  technicians on a row = the same note on each booking); the phone's Add /
  Edit booking sheet has a "Note for this booking" step (edit reopens with
  the saved note). Writes: web `planBookingSave` (`lib/bookings.ts`, note in
  inserts / in the patch only when changed), phone
  `ScheduleRepository.addBookings/updateBooking` through the outbox. Board
  moves keep the note; Shift-copy carries it (`planBoardAdd`, mirrored).
- **History unchanged:** a new or CHANGED note is also posted to `job_notes`
  (`source: "schedule"`, once per distinct text — `scheduleNotesToLog`), so
  Notes & Activity still shows it badged "Scheduling note". Re-saving to move a
  booking posts nothing. The pre-bookings single-schedule form (database
  without 0079) only writes `job_notes`, as before.
- **Banner** (`mobile/components/job/schedule-note-banner.tsx`, rules
  `mobile/lib/bookingNotes.ts`, tested): the notes of the job's bookings whose
  last booked Melbourne day is today or later; a technician sees only their
  own bookings' notes, office every booking's, labelled day/time (and whose).
  No such note → no banner. Legacy `job_notes` schedule notes are no longer
  read by it. Pop-up seen-ness is per booking id + note text. Hidden on
  view-only jobs, as before. Data: the job screen's `listJobBookings` (local
  first — `tech_job_bookings` now lists `note`; `office_job_bookings` is
  `job_bookings.*`; `note` added to `mobile/lib/powersync/schema.ts` by hand).
- **Web display:** the job Overview's bookings list and the board cards (one
  line, full text on hover) show a booking's note.
- **Before 0109 is applied nothing breaks:** readers select `note` and retry
  without it on 42703 (web `loadJobBookings`, the board's embed, phone
  `listJobBookings`); web writes retry without `note` on 42703/PGRST204
  (`isMissingNoteColumn`), and the phone gateway does the same for queued
  writes (`mobile/lib/data/optionalColumns.ts`) so a queued booking never
  dead-letters over its note. The note then only reaches `job_notes`.
- **Apply / deploy order:** paste `0109_job_booking_note.sql`, then
  `supabase/tests/0109_job_booking_note_test.sql`, trust only `0109 PASSED`
  (checked on a scratch Postgres 16 with the real 0079/0096/0107: applies
  twice cleanly, passes, and fails with the length check dropped or the update
  grant revoked; a note-only edit on a completed job's booking passes 0096 and
  leaves the job's derived schedule alone). Mark 0109's header applied; record
  it in the ledger. THEN redeploy the PowerSync streams
  (`docs/powersync-deploy.md`) — not before: `tech_job_bookings` names
  `note`, and PowerSync's validator was not run here against a database
  without it (expect a "column not found" warning at best). Then merge web,
  then ship the phone (the banner and sheet reach phones with the next build;
  older builds keep showing the latest `job_notes` schedule note).

**Limited-access accounts for the App Store reviewer (migration `0110` applied 2026-11-17).**
Justin, 17 Nov 2026: Apple's reviewer signs in as a technician ("App Review")
and must see only the jobs it is on (QA job #834) — not search other jobs, not
see other customers or sites, not receive the backflow register. Real
technicians must be unaffected.
- **Flag:** `profiles.limited_access boolean not null default false`. Admin-only
  like `role` / `is_active` / `auto_clock`: 0110 adds it to
  `prevent_unauthorised_role_change()` (service role or an active admin; a
  technician setting or clearing their own flag is refused). Signup can't set
  it — `handle_new_user()` (0044) never copies it, so it starts false. No UI:
  it is set once in the SQL editor (below).
- **Database:** `is_limited_account()` (SECURITY DEFINER, authenticated only)
  and RESTRICTIVE `for select to authenticated` policies, so every existing
  permissive policy is untouched and an unlimited caller passes at the first
  term (an init-plan, once per statement). For a limited account: `jobs` →
  `user_can_manage_job(id)`; `customers` / `sites` → those of a job they can
  manage (`limited_account_can_see_customer/_site`, SECURITY DEFINER — no RLS
  recursion); `job_photos`, `job_documents`, `job_notes`, `job_stage_notes` →
  `user_can_manage_job(job_id)`; `backflow_devices`, `backflow_tests` →
  nothing; `storage.objects` in `job-photos` / `job-documents` / `job-audio`
  → only `<jobId>/…` keys of their jobs. The owner-run views
  `purchase_orders_public`, `po_cost_centers_public`, `job_variations_public`
  (RLS never reaches them) are re-created with the same columns, the same job
  filter and `security_barrier`. Already scoped, left alone: job_assignments,
  job_bookings, hire_entries, time_entries, equipment_usage_log, money tables.
  **Not narrowed:** `profiles` (staff names — the phone's `profiles` stream
  sends them to every device anyway), cost centres, variation types, fleet.
- **Sync streams:** the four `backflow_*` streams (the only technician-visible
  data not already scoped to the caller's jobs) join the caller's profile and
  require `profiles.limited_access IS NOT true`; pinned by
  `tests/unit/sync-streams-contract.test.ts`. Checked with
  `@powersync/service-sync-rules` 0.45: 0 diagnostics with the column, 4
  "column not found" warnings without it; a profile row with the flag set
  yields no parameter lookup for those streams (so no backflow bucket), flag
  false or absent yields one. The `tech_*` streams already carry only the
  caller's own jobs.
- **Phone:** the Backflow tab is hidden when the profile has `limited_access`
  (`app/(tabs)/_layout.tsx`, `toCachedProfile` keeps the flag only when
  exactly `true`; `select("*")`, so no read breaks without the column). Next
  build; data is withheld either way.
- **Writes:** on their own job everything works (notes, photos, time,
  sign-off). A limited account creating a customer, site or backflow device
  gets an RLS error (the row it would read back is hidden) — intended.
- **Checked** on a scratch Postgres 16 with the full migration chain 0000–0109
  (Supabase roles/auth/storage shimmed): 0110 applies twice cleanly; the gate
  test passes (30 scenarios) and fails, naming the scenario, with the jobs,
  customers, backflow or storage policy dropped, with the 0082 trigger body
  restored, or with an unfiltered `purchase_orders_public`.
- **Order:** paste 0110 → paste `supabase/tests/0110_limited_access_accounts_test.sql`,
  trust only `0110 PASSED` → mark the reviewer (§7) → THEN redeploy the
  PowerSync streams. Merging the web/phone code first is harmless.

**Staff leave on the schedule (migration `0112` applied 2026-11-19).**
Justin, 17 Nov 2026: when someone has sick leave entered, show it on the
schedule so nobody books them; bookings already on those days get flagged.
- **Source — no new place to enter leave.** `staff_leave` (0014): one row per
  period, `start_date..end_date`, total `hours`, `leave_type` (sick / annual /
  public_holiday / long_service / other), `notes`. Entered by an admin in
  Staff → Cost & Leave → **Leave Log**, or imported from Xero Payroll leave
  applications (0101, `lib/xero-payroll-import.ts`). Admin-only by RLS, and
  it stays that way. 0112 adds optional `start_time`/`end_time` (Melbourne
  wall-clock, both or neither) for a **part day**, set from the same Leave
  Log form ("From / To (part day)"); Xero imports leave them null.
- **Day rules** (`lib/staff-leave.ts`, mirrored byte-identical below the
  imports at `mobile/lib/staffLeave.ts`, pinned by
  `tests/unit/staff-leave.test.ts`): leave covers the WEEKDAYS of its range
  (a weekend-only range covers those days); with times, those hours each day;
  without, the hours are spread evenly — ≥ 6 h a day (or unknown hours) is a
  full day, less is a part day of unknown time, which still blocks the whole
  day for clash checks. A booking day clashes when it overlaps a leave span
  (`bookingLeaveConflicts`); `bookingsNeedingReassignment` lists bookings on
  leave days from today on (past days are never flagged).
- **Who sees the type** — `schedule_settings.leave_type_visible_to`
  (one row; `office_admin` default, or `admin`, or `everyone`; Settings →
  **Leave on the schedule**, admin-only by RLS). Enforced in the database:
  the schedule reads leave ONLY through `schedule_leave(p_from, p_to)`
  (SECURITY DEFINER, ≤ 400 days): staff, dates, hours, part-day times, and
  `leave_type` — NULL for anyone outside the setting, shown as
  "Unavailable". `id` only for an admin; `notes` never; nothing for an
  inactive or limited-access (0110) caller.
- **Web board** (`components/schedule/team-schedule-view.tsx`, data from
  `app/dashboard/schedule/page.tsx` via `lib/staff-leave-data.ts`, 60 days
  back to 300 ahead): a striped tile per leave day in the person's cell / Day
  column, coloured by type (rose Sick, teal Annual, violet Public holiday,
  sky Long service, amber other, slate Unavailable — `LEAVE_COLOURS`).
  Read-only: not draggable, no handles, a click opens a details dialog (admin
  gets **Open leave record** → `/dashboard/staff?leave=<id>`, which opens that
  person's Leave Log). Bookings on a leave day get a rose ring and a **Needs
  reassigning** tag. Drag, cut/paste and Shift-copy onto a leave day ask
  "isn't available then — Book anyway?"; a resize asks when it GAINS a leave
  day (same dialog as booking clashes).
- **Web Schedule dialog** (`components/job/schedule-job-dialog.tsx`): reads
  leave on open; rows that would book someone onto leave say so inline and
  Save turns into **Book anyway** (an unchanged saved booking isn't re-warned).
- **Web job page**: Overview's bookings list shows **Needs reassigning** with
  the leave days; the header shows the tag (with a count) and jumps to Overview.
- **Phone** (online only — see §2): office Schedule tab Day/Week draws leave
  blocks in the person's row (`layoutDayRow` / `layoutWeekRow` in
  `mobile/lib/scheduleGrid.ts`, tested in `scheduleGridLeave.test.ts`; a leave
  block takes its own lane), tap → read-only alert; List shows "Off: …" under
  each day and prefixes flagged rows. Moves/resizes warn in the existing
  confirm (`Book anyway`). The Add/Edit booking sheet warns on its confirm
  step and asks before saving. The job screen header flags booked lines.
  Read: `mobile/lib/data/reads/leave.ts` (tested). Offline → no leave shown.
- **Before 0112 is applied nothing breaks**: every reader treats a missing
  function/column (42883/PGRST202/42703/PGRST204/42P01/PGRST205) as "no
  leave"; the Leave Log only sends From/To when given and says why if the
  columns aren't there; Settings says it isn't switched on.
- **Apply order:** paste `0112_schedule_leave.sql`, then
  `supabase/tests/0112_schedule_leave_test.sql` (needs an active technician
  and admin; office checks skip without an office user), trust only
  `0112 PASSED`. Checked on a scratch Postgres 16 with a minimal Supabase
  shim (roles, `auth.uid()`, profiles, `is_admin`, staff_leave as of 0101):
  applies twice cleanly, passes, and fails naming the scenarios when the
  function returns the type unconditionally. Mark the header applied, add the
  ledger row, regenerate types (`lib/database.types.ts` has the columns,
  table and function added by hand). No PowerSync redeploy — no stream
  changed. Web and phone may merge/ship before or after.
- **Not done:** leave isn't on the phone offline (deliberate); a part day of
  unknown time can't be placed on the Day timeline, so it covers the whole
  day; "Needs reassigning" is a flag, not a task list.
- **Phone crew picker (Reassign technician) warns too** (19 Nov 2026):
  ticking someone NEW into a job's crew asks "<name> isn't available then —
  Sick Tue 18 Nov. Book anyway?", and the picker row shows the clash. The
  window checked is the one 0079 would book them on (`crewJoinWindow`,
  `mobile/lib/crewLeave.ts`, tested): the job's bookings' one shared window,
  none when they differ (the newcomer joins without a booking), the job's own
  window before 0079. Uses the mirrored `bookingLeaveConflicts` and the same
  online leave read, so offline it says nothing; a withheld type reads
  "Unavailable".

**Supplier POs from the phone (migration `0085` applied 2026-10-28).**
Justin, 28 Oct 2026: any technician, on any job, can raise a purchase order to
any supplier against a cost centre, and it is emailed straight to the supplier
(office copied, no approval step). Mobile: **Orders** tab on the job (shown
even on view-only jobs) → `components/job/supplier-orders.tsx`, calling
`lib/supplierOrders.ts`. **Online only, not the outbox** — the tech needs the PO
number back at the counter, and a PO that sat queued without signal would
reach the supplier late and silently. Server: `app/api/jobs/[id]/supplier-orders`
(GET list + form defaults, POST raise + email) using the service-role client
after `requireUser`; rules and email HTML in `lib/supplier-orders.ts`.
- Rows are `vendor_orders` (0061) + new `vendor_order_items` (description and
  quantity, **no price**). Both stay office/admin-only by RLS and are in no
  PowerSync stream; the route never selects `amount`/`gst_amount`
  (`tests/unit/supplier-orders.test.ts` pins that).
- `po_number` (`PO-1001`…) is assigned by a sequence. The phone generates the
  row id, so a retry after a dropped connection returns the same PO and does
  not email twice.
- **No PO without a cost centre** (Justin, 28 Oct 2026): the form makes them
  pick it first; the route and `vendor_orders.cost_center_id NOT NULL` both
  refuse one without it. It defaults to the cost centre the tech is clocked
  into, else `jobs.scheduled_cost_center_id`, else the only one. A job with no
  cost centres shows "ask the office to add one" instead of the button. The
  office types the amount (ex GST) on the order from the supplier invoice.
- 0085 was applied (gate test passed) before this merged — the web job
  page's vendor-order query embeds `vendor_order_items`, which errors on a
  database without it.

**New cost-centre POs fill themselves in (web PO tab).** Justin, 29 Oct 2026:
"Add Purchase Order" opens with the number `<job number>-1`, `-2`, … (next
after the highest of that shape on the job, so a deleted one is never reused —
`lib/job-po-number.ts`), the client's name in the Client field
(`purchase_orders.client_reference`, otherwise unused — see 0083), and the job
site's address, already pinned when the site has coordinates. All editable.
Simpro-imported `SIMPRO-…` numbers are left alone.

**Stage 0 fixes (31 Oct 2026 workflow review; migration `0086` applied 2026-10-31).**
- **No website geofence.** `components/job/job-time.tsx` no longer watches the
  browser's location. Its first reading away from site closed the viewer's open
  entry, so a tech clocked in on the phone who opened the job in the office was
  clocked out. Automatic clocking is the phone app's alone; the web is manual.
- **No automatic hourly labour lines.** `billing_rate_config.auto_labour_lines`
  (0086, default false) makes `syncJobBilling` a no-op: no new "Labour" / "Call
  Out Fee" job_items, and existing ones are left as they are. Builder work is
  fixed price; the office adds labour by hand for day work. A database without
  the column keeps the old behaviour, so merging before applying is harmless.
- **"Project" job type saves.** 0086 replaces the jobs `job_type` check
  (found by definition, not name) with one that includes `project`.
- **Sign-off clocks the signer off.** Phone (`useSignoff` →
  `getOpenWorkEntryOnJob`, through the outbox) and web (`job-signature.tsx`)
  close the signer's own open work entry on that job. Other crew are untouched.
- **Margin flag 20%** (`min_margin_pct`, set by 0086; fallbacks in the job page
  and `mobile/lib/data/reads/jobCosting.ts` also 20).

**Company cost centres and the supplier list (Stage 1; migration `0087` applied 2026-10-31).**
- `cost_centres`: the company list (Below Ground Drainage, Transport, Above
  Ground Plumbing, Civil, plus any added). Settings → **Cost Centres**
  (`app/dashboard/settings/cost-centre-templates`) shows each with its stages
  (`cost_center_templates.cost_centre_id`; `group_name` is kept equal to the
  cost centre's name for older readers). "Truck Cartage" became Transport.
- `po_cost_centers.cost_centre_id` tags a job's budget lines. 0087 matched the
  existing lines by keyword; unmatched ones stay null for the office. Lines
  loaded from a stage template on the PO tab are tagged by themselves. The
  phone's offline schema has the column (`mobile/lib/powersync/schema.ts`,
  added by hand: the generator needs a linked CLI).
- `suppliers`: copied from Xero contacts marked as suppliers
  (`lib/xero-suppliers.ts`; Settings → **Suppliers** "Copy from Xero", and
  nightly via `/api/xero/poll-suppliers` at 16:40 UTC). Xero owns name, account
  number, phone and active; the ordering email is the office's once set, and
  each supplier can have a usual cost centre (the quarry → Transport).
  Office/admin only by RLS.
- **Phone:** the Orders tab picks the supplier from the list (search by any
  word), with "Other supplier" for one-offs. Picking a supplier with a usual
  cost centre selects the job's matching line, unless the tech already chose
  one. `vendor_orders.supplier_id` records the pick; the route stores the name
  on file, not what the phone sent. The route returns `suppliers` and
  `costCentreLines`; older phone builds read only `name`/`email`.
- **Web PO tab:** the vendor-order form suggests suppliers from the list and
  links a matching name by id.

**Builder POs split by cost centre (Stage 2, 31 Oct 2026; no migration).**
Justin: the builder issues a PO per stage (or we work to a quote total), one
job per lot; each PO's value is split across cost centres and each share is
that cost centre's budget. Cartage comes out of the drainage PO.
- Same tables: `purchase_orders.po_number` is the builder's number (or
  `<job number>-1` for quoted work), `total_value` is the value **as entered**
  — no longer the sum of the lines — and each split line is a
  `po_cost_centers` row with `cost_centre_id`. Lines that don't add up show as
  "not split yet" / "over" on the PO card. Rules in `lib/builder-po.ts`; the
  shared form is `components/job/builder-po-lines.tsx`.
- **New Job** takes the builder's PO number (`jobs.customer_po`, as before),
  a PO value and the split, and creates the PO with the job (not atomic: a PO
  failure sends the office to the job's PO tab).
- **PO tab**: new POs take a value and a split; each PO card edits its value,
  tags any line with a cost centre (Simpro lines 0087 couldn't place), and
  "Add cost centre to this PO" splits what's left.
- **Edit and $0 POs** (Justin, Nov 2026): each PO card has **Edit** — number,
  client, site, value and its lines — saved in place (`planBuilderPoEdit`:
  lines updated by id, new inserted, removed deleted; `total_hours` = sum of
  line hours). A line with supplier orders (0061 would cascade-delete them),
  logged time or expenses can't be removed — set it to $0. On New Job and the
  PO tab the value may be left blank when there are lines: it becomes the
  lines' total, which may be $0 (a cartage line with hours only).
- **Several POs, one job; invoice each, margin per cost centre** (Justin, 16 Nov
  2026): one builder's Sewer and Stormwater POs, done the same day, stay on one
  job so the figures merge, but each is invoiced on its own. Each PO card has
  **Invoice this PO** → `/dashboard/invoices/new?job_id=…&po_id=…`, which
  fills that PO's number, a title naming it, and its value as the lines
  (`lib/po-invoice.ts`: one line per priced cost-centre line when they add up,
  else one line for the value; tested) instead of the job's items, and warns
  when the PO already has an invoice. The Job Ledger shows a margin % per cost
  centre (red under `min_margin_pct`; `rowMarginPct` / `rowBelowMinimum`), and
  Reports → Job margins adds a by-cost-centre total across the open jobs
  (`costCentreTotals`) and each job's per-centre margins.
- **Quote → job** creates `<job number>-1` with the quote's subtotal (ex
  GST), unsplit (rule `lib/quote-job-po.ts`, tested in
  `tests/unit/quote-job-po.test.ts`); the web then opens the PO tab. The
  phone (16 Nov 2026) does the same offline-safely: the job number is a
  database serial it only learns once its queued job insert syncs, so after
  the job insert, items and quote link it queues a `quote-po` side effect →
  `POST /api/jobs/[id]/quote-po` (office/admin; runs as the caller under RLS,
  never the service role). The server numbers the PO against the real job
  (next after any existing `<n>-k`), values it from the quote — which must
  already be linked to that job — never from the request, and inserts it with
  the phone's client UUID, so a retry finds it and adds nothing. No
  `purchase_orders` write leaves the phone and no stream changed
  (`office_purchase_orders` is office-gated). Needs the web deployed before
  the phone build that carries it (a missing route would dead-letter the
  step, reported); reaches phones with the next build.
- **Which builder PO an invoice is for** (1 Nov 2026): on New Invoice, a job
  with more than one priced PO shows a picker; it sets the invoice's
  `customer_po` to that PO's number, and a progress claim then defaults its
  contract value to that PO's value and its previous claims to earlier claims
  on the same PO number (`ProgressClaimFields builderPo`). A job with one PO
  behaves as before. Edit Invoice is unchanged.

**Migration pastes: trust only a final "PASSED" row (2 Nov 2026).** The
Supabase SQL editor runs a whole paste as one transaction. If any statement or
the gate test raises, EVERYTHING is rolled back — but the earlier pastes ended
in `raise notice` (shown on a tab most people never open), so 0089, 0090 and
0092 were reported "passed" on 31 Oct–1 Nov and were not in production. The
phone then showed "Couldn't load purchase orders" (0089) and stuck "Syncing"
(0092 columns missing). All of 0086–0092 were re-run one by one on 2 Nov, each
ending `select '00xx PASSED' as result;`, and passed. 0090 needed a fix (its
clean-up broke 0051's duration rule); 0087's test was relaxed (it asserted on
office-editable data). **Every future paste ends with that select**, so a
rolled-back run shows a red error, never a quiet notice.

**New tables need explicit grants (migration `0088` applied 2026-10-31).**
After 0087 the cost centre drop-down came up empty: the new tables had RLS but
the `authenticated` role had no table privileges, so reads returned nothing
without an error. 0088 grants them (RLS still decides rows) and the list
filled at once. **Any future migration that creates a table must `grant` it
to `authenticated` (and `service_role`) explicitly** — this project does not
expose new tables by itself. The cost centre picker
(`components/job/builder-po-lines.tsx`) now says when the list can't load,
and has "+ New cost centre…" to add one on the spot (it joins the company
list in Settings).

**Job ledger and Job Margins (Stage 3, 31 Oct 2026; no migration).**
`lib/job-ledger.ts` (pure, tested in `tests/unit/job-ledger.test.ts`) gives
one job's budget per company cost centre (its PO lines, by `cost_centre_id`)
against cost so far: labour (hours × loaded rate, by the entry's line), travel
(own row), materials (`job_expenses` + priced `vendor_orders`; an order with
no amount counts as "to be priced", not $0), plant (usage × cost/hour, under
"Not tagged" — usage has no cost centre yet). Margin = builder's price (sum of
`purchase_orders.total_value`) − cost; flagged when below `min_margin_pct`,
i.e. already under the minimum even if nothing more is spent.
- Admin only: the **Costing** tab's new "Job Ledger" card
  (`components/job/job-ledger.tsx`) and **Reports → Job margins**
  (`app/dashboard/reports/job-margins`), every open job with a price, worst
  margin first. "Open" = not cancelled and not completed-and-approved.
- Known overlap until Stage 4: one supplier invoice entered both as an expense
  and as a PO's amount counts twice.
- Mistake costs (`job_mistakes`, 0115 draft, 23 Nov 2026) are a fifth cost
  kind, shown as their own column — see "Mistake costs per cost centre".

**Supplier invoices against POs, deliveries (Stage 4; migration `0089` applied 2026-10-31).**
Justin: supplier bills are typed into Xero by hand. Now the office types each
one once, against its PO, and the app makes the Xero bill.
- **Supplier POs** page (`app/dashboard/supplier-pos`, office): type the PO
  number off the invoice ("1234" finds PO-1234), open the job's PO tab. Below
  it, every live order still waiting for its invoice, oldest first.
- **PO tab**: "+ Enter supplier invoice" on each order — invoice number, date,
  amount ex GST (GST 10%), file. The file goes to job-documents as
  `{job}/expense-receipt-{PO}-...`, so 0047's money-file rule hides it from
  technicians. "Send to Xero" (`/api/xero/push-vendor-order`, office/admin)
  makes an AUTHORISED ACCPAY bill: invoice number = supplier's, reference =
  `PO-x / JOB-n`, contact = the supplier's Xero contact when picked from the
  list (0087), coded to the default expense account. `xero_bill_id` (unique)
  blocks a second bill; the amount locks once sent.
- **Phone**: "Delivered" on each ordered PO
  (`/api/jobs/[id]/supplier-orders/[orderId]/delivered`, service role after
  `requireUser`, writes only status/delivered_at/delivered_by).
- The Expenses form now says to enter a PO's invoice on the PO, so it isn't
  counted twice in the ledger.
- 0089 was applied before this merged (the supplier-orders route selects `delivered_at`).

**Scheduling and PO batch (13 Nov 2026; migrations `0096`, `0097` applied 2026-11-14).**
- **Closed jobs can't be scheduled.** The board and the phone's Schedule tab
  hide completed/cancelled jobs, so a booking on one used to "save" and never
  appear. Web "Schedule Job" is disabled for them with a link to change the
  status; the phone sheet explains and offers "Change status". Rule in
  `lib/job-schedulable.ts`, mirrored at `mobile/lib/jobSchedulable.ts`
  (`tests/unit/job-schedulable.test.ts`). `0096` makes the database refuse new
  or moved bookings and job-level schedule writes on closed jobs (ERRCODE
  MJ001, HTTP 400); status changes, deletes, unassigning, calendar links,
  flag-only refreshes and 0079's own follow-on writes still pass. The calendar
  poll counts a refusal as skipped. Gate test
  `supabase/tests/0096_refuse_scheduling_closed_jobs_test.sql`.
- **Keyboard-safe forms.** Phone sheets with text fields use
  `mobile/components/KeyboardSheet.tsx` (buttons outside the scroll, Done bar,
  dismiss on tap/drag, 16pt); web dialogs use
  `components/ui/keyboard-safe-dialog.tsx`, sized to the *visual* viewport —
  iPhone Safari does not shrink `vh`/`dvh` for the keyboard. Use these for any
  new form with a text area.
- **Add a site while creating a job** (web New Job and job Overview, phone New
  Job). Address rules and duplicate check in `lib/site-address.ts`, mirrored at
  `mobile/lib/siteAddress.ts` (`tests/unit/site-address.test.ts`). Contact and
  access notes go into `sites.notes`, labelled (no columns for them). On the
  phone a site waits for its still-queued customer, and a job for its
  still-queued site (`Outbox.pendingInsertOpId`). No database duplicate guard
  yet.
- **Web board: resize and name tags.** Week view: drag a booking's first/last
  day edge (mouse or touch) to change its days — `planBookingResize` in
  `components/schedule/board-model.ts`, through the dialog's own
  `buildBookingWindow`; clashes on added days ask first (`resizeConflicts`);
  success only after the server confirms, snap-back on refusal. Every tile
  names its technician (initials when narrow, "+N" others on the job that day).
- **Phone schedule grid.** Office Schedule tab is Day / Week / List
  (`mobile/components/schedule/ScheduleGrid.tsx`, layout in
  `mobile/lib/scheduleGrid.ts`), placement from `mobile/lib/boardModel.ts` —
  a copy of the web board model pinned by `tests/unit/board-model-mirror.test.ts`
  (change the web file first, then copy its body). Long-press drag moves; the
  Week-view grip resizes; both go through `ScheduleRepository.updateBooking`.
  `GestureHandlerRootView` now wraps the app root. The phone's
  `lib/bookings.ts` `BookingWindowColumns` now has the web's booking shape; the
  old schedule-shaped type is `ScheduleWindowColumns`.
- **Supplier picker: Pinned / Recent / A–Z** on every PO supplier picker (web
  `components/job/supplier-picker.tsx`, phone
  `mobile/components/job/supplier-picker.tsx`), rules in
  `lib/supplier-picker.ts` mirrored at `mobile/lib/supplierPicker.ts`. Pins are
  `suppliers.pin_order` (0097; Settings → Suppliers); Recent comes from
  `vendor_orders` (user's own first, then the company's). 0097 also defaults
  `vendor_orders.entered_by` to the signed-in user and seeds the four pins by
  name (applied: Reece, Plumbers Co-op, Northern Quarries, Boral pinned).
- **Allowed hours per cost centre already existed** — PO tab, Hours on each
  cost-centre line (`po_cost_centers.allocated_hours`); not rebuilt.

**New Job: site search and a crew (16 Nov 2026; no migration).** Office
feedback. The Site picker on web New Job, the job Overview and phone New Job
is now searchable (name, street, suburb, postcode; every word must match),
A–Z with numbers in order ("Lot 2" before "Lot 10"), with "+ Add new site" as
the FIRST row. Rules `lib/site-picker.ts`, mirrored at
`mobile/lib/sitePicker.ts` (`tests/unit/site-picker.test.ts`); pickers
`components/job/site-picker.tsx` and `mobile/components/job/site-picker.tsx`.
"Assign To" on New Job (web and phone) takes one or more technicians: the job
is inserted with the first as `assigned_to` (0059 makes them the crew; with a
schedule 0079 books them), then `set_job_assignments` adds the rest — 0079's
`job_assignments_to_bookings` gives each newcomer their own booking on the
job's one window, so N technicians = N bookings (checked on a scratch Postgres
with the real 0059/0079 functions, scheduled and unscheduled). Web reports a
failed crew write with a toast and opens the job; the phone queues it as an
`assign-technicians` side effect after the insert, with the calendar sync
after that.

**Customer job report with the invoice (14 Nov 2026; no migration).** Justin
approved: the web **Send Invoice** dialog has "Include job report and photos"
(only when the invoice has a job). Ticked, it loads a draft
(`GET /api/invoices/[id]/job-report`) and the email gets a second PDF,
`job-report-<invoice no>.pdf`, with a line in the body saying so.
- **Content:** header as on the invoice; job number/title, customer, site,
  invoice number; **dates attended** with each day's technicians (work
  `time_entries`, Melbourne days, names from `profiles` — **no hours, no
  money**: fixed-price builders must not see hours); **work carried out** —
  defaulted from `job_stage_notes`, the voice report and `completion_notes`
  (never `job_notes`, which can be internal), edited by the office, sent
  exactly as left (plain text, ≤20,000 chars); **photos**, all ticked by
  default, two per row with caption and date; the latest **signature** row as
  the customer sign-off (tickbox). Excluded always: `photo_type='signature'`
  from the photo grid, **docket photos** (`vendor_order_id` set — they can show
  prices), and files that are not JPEG/PNG/WebP (HEIC etc.; the dialog says how
  many).
- **Server:** photos are downloaded through the caller's client (4 at a time)
  and re-encoded with `sharp` (now a direct dependency) to ≤1200px JPEG q70;
  at most 40 photos / ~14 MB of images — the first N go in and the office is
  told the rest did not fit. The requested photo ids are intersected with the
  job's eligible photos; the client list is never trusted. **If a requested
  report can't be made, nothing is sent** (500 with a fixed sentence; reported
  to Sentry by tag). `maxDuration` 60 on send and preview. A send without
  `jobReport` is unchanged.
- "Preview report" posts the same selection to
  `/api/invoices/[id]/job-report/preview` and opens the PDF in a new tab.
- Files: rules `lib/job-report.ts` (tested in `tests/unit/job-report.test.ts`),
  loading/rendering `lib/job-report-data.ts`, PDF
  `lib/pdf/job-report-template.tsx` + `render-job-report.ts`, dialog panel
  `components/invoice/job-report-options.tsx`; route behaviour in
  `tests/unit/invoice-send-job-report.test.ts`.
- **Phone (19 Nov 2026; no migration):** the invoice detail screen has
  **Send to Customer / Resend** → `mobile/app/invoices/[id]/send.tsx`
  (office group route + `RoleGate`; the route's `requireOfficeOrAdmin` is the
  authority): send to, message, attachments (below) and, when the invoice has
  a job, "Include job report and photos"
  (`mobile/components/finance/job-report-options.tsx`) — the same draft, dates
  attended, work text edited in a `KeyboardSheet`, photo tick boxes (server
  signed thumbnails through expo-image), sign-off tickbox, and **Preview
  report** (`mobile/components/finance/pdf-preview.tsx`: the PDF is saved to
  the app cache; iOS shows it in react-native-webview, Android draws it with
  pdf.js from cdnjs, since Android's WebView can't render a PDF — no new
  native module). The unpriced-hours 409 asks "Send anyway". Calls and checks
  in `mobile/lib/invoiceSend.ts` (Bearer, online only — not the outbox; tested
  in `invoiceSend.test.ts`); errors are the routes' own sentences. The phone
  had no invoice send before this; `getInvoice` now also returns `job_id`.
  Reaches phones with the next build.

**Attach files to the invoice email (16 Nov 2026; no migration).** The web
Send Invoice dialog has an "Attachments" drop zone: drag files on (or browse)
and they go with the invoice PDF (and the job report, when ticked). PDF,
photos, Word, Excel, CSV, text; up to 10 files and **3 MB in total** — they
travel inside the send request as base64 and Vercel caps a request at 4.5 MB.
Photos are shrunk in the browser first (`lib/image-resize.ts`). Not stored
anywhere; the email names them ("Also attached: …"). A bad file refuses the
whole send. Rules `lib/invoice-attachments.ts` (tested), field
`components/invoice/invoice-attachments-field.tsx`. Bigger files would need a
Storage upload first (a new office-only bucket + migration).
- **Phone (19 Nov 2026):** the Send screen's Attachments take photos from the
  library or camera (shrunk by `mobile/lib/imageUpload.ts`, sent as `.jpg`)
  and the job's own **documents** (from Storage, any allowed type), with the
  same limits and checks: `mobile/lib/invoiceAttachments.ts` is the web file
  byte for byte below its header (`tests/unit/invoice-attachments-mirror.test.ts`),
  and the size used shows under the list. Since 27 Nov 2026 a third source,
  **Files**, attaches any file on the phone (a PDF in Files / Downloads…)
  through `expo-document-picker` — see "PDF and other files from the phone"
  below; it needs a NEW BUILD.

**Invoices are made out to the Company (16 Nov 2026; no migration).**
Invoice and quote PDFs, their detail pages and the Xero contact used
`customers.name` alone and ignored `company`, so the office swapped the two
fields to get the business on the invoice. Now `billingName()` (company,
else name) is billed and `attentionName()` adds "Attn: <name>" when they
differ (`lib/customer-billing.ts`, tested). The form labels are "Contact Name"
and "Company (invoices are made out to this)". Customers already swapped by
hand should be swapped back. Xero matches contacts by name, so a customer
whose Xero contact is the person's name gets a new contact under the company
on its next push.

**Stage notes can be edited and deleted (web and phone, 16 Nov 2026; no migration).**
Pencil and bin icons on the "Currently at" banner and on each stage note
(web `components/job/job-notes.tsx`, phone `mobile/components/job/notes.tsx`).
Shown for your own notes, or every note for office/admin, which is the 0074
RLS rule; never on view-only jobs. Rule in `mobile/lib/stageNoteEdits.ts`
(`canChangeStageNote`, tested). On the phone, edit opens a `KeyboardSheet`
and delete asks to confirm; both go through the outbox
(`JobStageNotesRepository.update` — `content` only — and `.remove`), so they
work offline. A write the server refuses (0 rows → the gateway fails it) gives
an alert after the flush and ends in "not synced"; reloads keep a queued
edit/delete on screen (`mergeStageNotes`) until it lands or dies. No sync-rule
change (`tech_job_stage_notes` already has `author_id`). Reaches phones with
the next build.

**Technicians don't see other people's schedules (16 Nov 2026; migration `0107` applied 2026-11-16).**
Justin: technicians may look any job up for its plans, but must not watch the
schedule or the office's work. On a job they are NOT on (web and phone):
- no schedule anywhere — header line, Overview's Schedule card, the phone's
  booking lines and "Scheduling note" banner; the web job page strips the
  bookings, job dates, notes and stage notes on the server
  (`app/dashboard/jobs/[id]/page.tsx` `hideSchedule`), so none reaches the browser;
- tabs are Overview, Documents, Photos (+ Orders on the phone, per the 28 Oct
  "PO on any job" rule) — **Notes is gone** (`VIEW_ONLY_TABS`, web
  `lib/job-view-only.ts`, phone `app/job/[id].tsx`);
- the web Jobs list shows no dates to technicians.
On jobs they ARE on, nothing changes: they see the whole crew's bookings
(Justin's choice). Search and opening any job still work.
- **Database:** `0107` (applied 2026-11-16, gate test passed) replaces
  job_bookings' `using (true)` SELECT with "office/admin, or
  `user_can_manage_job`", dropped by enumeration and asserted.
- **Still readable at the database** (left open, hidden in the app): jobs'
  dates, job_notes, job_stage_notes. Closing those needs column-level work on
  `jobs` and would break job look-ups; not done.
- `requireOnJob` (`lib/api/guards.ts`, tested): office/admin, the lead or the
  crew. Now guards `/api/jobs/[id]/plant-usage` (who logged which truck) and
  `/api/jobs/[id]/stages` — the latter also fixes office being refused
  (requireUser left `role` null).
- Phone parts reach devices with the next build.

**Email replies and the sending domain (16 Nov 2026; no migration).** Every
customer and supplier email (invoices, quotes, supplier POs) now sets
Reply-To from `getReplyTo()` (`lib/resend.ts`): `EMAIL_REPLY_TO` (comma-separated
allowed), else `BUSINESS_EMAIL`, else admin@mellerick.com — so replies reach a
monitored mailbox even while `EMAIL_FROM` is an unmonitored Resend address.
`EMAIL_FROM` stays the one setting for the sender. Settings → Email shows both
and has **Send test invoice** (`POST /api/email/test`, admin only: sample PDF,
same From/Reply-To; returns Resend's refusal text so a domain problem is
visible). Moving the sender to the real .com domain is a Resend + DNS job:
verify a sending SUBDOMAIN (e.g. `send.mellerick.com`) so the Google Workspace
SPF/MX on the root are untouched, add the records Resend lists, then set
`EMAIL_FROM` to e.g. `Mellerick Pty Ltd <accounts@send.mellerick.com>` and redeploy.

**Xero analytics mirror (14 Nov 2026; branch `feat/xero-analytics-sync`; migration `0105`, first numbered 0098, applied 2026-11-14).**
Renumbered 0098→0105 and 0099→0106 on merge (main already had its own 0098/0099).
Record them in the ledger once: `insert into supabase_migrations.schema_migrations (version,name) values ('0105','xero_analytics'),('0106','xero_bill_allocations') on conflict do nothing;`
Justin: pull Xero's data back so "where should the business head" can be answered
from our own database. Read-only toward Xero; nothing is written back.
- **Already existed, unchanged:** `pollXeroInvoicePayments` (`lib/xero.ts`, cron
  `/api/xero/poll-invoices` every 30 min) marks CRM-pushed invoices paid. It only
  sees invoices the CRM pushed. The mirror below covers everything else.
- **Tables (`0105`, office/admin read by RLS, service-role write, in no PowerSync
  stream):** `xero_invoices` (sales invoices AND bills, last 24 months, header
  totals only), `xero_payments`, `xero_pl_monthly` (one row per account line per
  month), `xero_sync_state` (resume point + last result per entity).
- **Sync:** `lib/xero-analytics.ts` `syncXeroAnalytics`. Invoices/payments are read
  `UpdatedDateUTC ASC` and the cursor is saved after every page, so a run that
  hits its 40 s budget or Xero's 429 just resumes next run — the first runs are the
  backfill. P&L: 24 months while the table is empty, then the latest 3 months
  (closed months can still change). Route `/api/xero/sync-analytics`: GET = cron
  (secret, nightly 17:25 UTC), POST = admin manual run. Before `0105` was applied
  the route answered `{skipped: true}`.
- **Scopes:** `XERO_SCOPES` in `lib/xero.ts` gained `accounting.payments.read` and
  `accounting.reports.profitandloss.read` (granular names; the broad
  `accounting.transactions` / `accounting.reports.read` are retired for apps created
  after 2 Mar 2026). They take effect only when Xero is **reconnected**; the current
  connection keeps its old scopes and keeps working. Without them the sync fails
  with Xero's own error, recorded in `xero_sync_state.last_error`.
- **Not verified against live Xero.** Tests mock the Xero SDK. The P&L column-header
  parser (`monthFromHeader`) is the likeliest thing to need a tweak on first real
  run; it throws naming the header rather than filing figures under a guessed month.
- `lib/database.types.ts` got the four tables by hand (`gen:types` needs the linked
  CLI); regenerate after applying.

**Unallocated bills + Monday office email (14 Nov 2026; branch `feat/unallocated-bills`, stacked on `feat/xero-analytics-sync`; migration `0106`, first numbered 0099, applied 2026-11-14).**
Justin: job profit has been inaccurate because a supplier bill reaches Xero by
account, not by job. This finds the bills with no job and gets them assigned.
- **Rules:** `lib/unallocated-bills.ts`. A Xero ACCPAY bill (AUTHORISED/PAID, ex-GST
  `sub_total`) is `crm` (the app made it: a `vendor_orders` / `job_expenses`
  `xero_bill_id`), `manual` (office assigned it), `overhead` (office marked it a
  running cost), `referenced` (PO-/JOB- number in its Xero reference — NOT checked
  against the CRM), else `unallocated`. Precedence: what the app knows > what the
  office decided > what a reference suggests. "Traced %" = (crm+manual+referenced) /
  (everything except overhead), per month.
- **`0106` `xero_bill_allocations`:** one row per bill the office has decided
  (job or overhead; no amounts — they are read from `xero_invoices`). Office/admin
  RLS, granted explicitly. Needs `0105`. Deleting a job deletes its allocations
  (the bill shows as unallocated again).
- **Page:** Reports → **Unallocated bills** (`app/dashboard/reports/unallocated-bills`,
  office/admin): traced-% by month and the oldest 100 bills with an assign control
  (job number, or Overhead) → `POST/DELETE /api/xero/bills/[id]/allocate`
  (office/admin guard; runs as the caller under RLS; job resolved by number
  server-side). Without 0105/0106 the page says so.
- **Email:** `GET /api/reports/weekly-digest` (cron secret; Sunday 19:30 UTC = Monday
  06:30 Melbourne in daylight time) emails bills-with-no-job, traced-% for the last 3
  months, overdue debtors and supplier POs still waiting for an invoice, linking to the
  page. **Recipients are the `WEEKLY_DIGEST_TO` env var (comma-separated) — set it in
  Vercel; unset = skipped.** Addresses are deliberately not in source (public repo).
  Sends from `EMAIL_FROM` (must be a Resend-verified domain, as for supplier POs).
- **Supplier invoices from the Gmail label:** built 27 Nov 2026 (0124 applied 2026-11-27) — see
  "Supplier invoices from Gmail", below. A bill it puts on a PO reaches Xero through
  that PO's Send to Xero, so it shows here as `crm` once sent.

**Supplier invoices from Gmail, filed against the job automatically (27 Nov 2026; migration `0124` applied 2026-11-27, gate test passed; no PowerSync change).**
Justin: bills land in a Gmail LABEL in the accounts mailbox ("Supplier invoices" by
default, renamable in Settings → Google); the app reads new ones every hour.
- **Scope:** `lib/google.ts` `SCOPES` gained `gmail.readonly` (`GMAIL_READONLY_SCOPE`).
  It reaches the stored refresh token only when Google is **reconnected** (Settings →
  Google → Reconnect — the callback is admin-only); the existing calendar connection
  keeps working unchanged (same token row and refresh path — `getGoogleAuthClient()`
  is now shared by Calendar and Gmail; `getGoogleCalendarClient` wraps it). The
  callback records whether the consent granted Gmail (`tokens.scope`,
  `grantsGmailRead`) in `gmail_invoice_settings.gmail_allowed`; a Gmail 403
  insufficient-scope answer sets it false with "Reconnect Google to allow reading
  supplier invoices", shown on Supplier POs and Settings. Gmail read is a Google
  **restricted** scope: fine for an Internal (Workspace) OAuth app; an External app
  needs it added on the consent screen (and Google's verification for real users).
  The Gmail API must be enabled in the Google Cloud project (its 403 is told apart:
  "The Gmail API isn't switched on…").
- **Import** (`lib/gmail-invoices.ts` `importGmailInvoices`, rules
  `lib/gmail-invoice-rules.ts`): `GET /api/gmail/poll-invoices` (cron secret, hourly at
  :05, `maxDuration` 300) and `POST` (admin — "Check now" on Supplier POs). Gmail via
  REST with the shared OAuth client (no new package). Lists the label's messages
  `after:` the last one read minus a day (first run: 7 days back), skips any message
  already recorded, oldest first; each named PDF / JPEG / PNG / WebP attachment
  (≤ 10 MB; images under 30 KB are signature logos, skipped; bytes sniffed) is claimed
  as a row first (`(gmail_message_id, part_id)` unique — the MIME part id, because
  Gmail's attachmentId changes between fetches), kept in the office-only
  `supplier-invoices` bucket at `gmail/<day>/<row>.<ext>`, read with Claude
  (`readSupplierInvoiceFile` — the 0103 reader, now taking photos too; photos over
  ~5 MB are shrunk with sharp), and checked (`checkRead`: one invoice, an invoice
  number, amount > 0 and ≤ $1 M, GST within 0.2% (≥ 5c) of 10% or derived at 10% when
  not printed, amount + GST = total, date not in the future nor > 2 years ago).
  **Matched** (`decideMatch`) = exactly one of our `PO-…` numbers printed that exists in
  `vendor_orders`, isn't cancelled, has no invoice and no Xero bill, is with the same
  supplier (loose name match), and the supplier's invoice number wasn't already
  received (emails, 0103 uploads or any PO). Then the file is copied to
  `job-documents` at the PO tab's `{job}/expense-receipt-{PO}-{ts}_{name}` (0047 hides
  it from technicians) and the PO's invoice number, date, amount, GST, file and
  `received` are filled **in one UPDATE conditioned on `invoice_number is null and
  xero_bill_id is null`** — an invoice the office typed meanwhile is never
  overwritten (file removed again) — with `vendor_orders.invoice_needs_check = true`.
  **Nothing is ever sent to Xero by the import.** Anything else → `needs_review` with a
  sentence. Limits: ≤ 12 Claude reads a run (≤ 240 a day), stops starting new emails
  after 200 s, ≤ 200 messages listed; rows a dead run left `new` for 30 min go to
  review. Errors: fixed sentences in `gmail_invoice_settings.last_error`; Sentry tags
  only; Google's status + enumerated reasons only — no email content, sender, subject
  or amounts are logged or reported. Read-only toward Gmail (nothing labelled, moved
  or marked read).
- **Migration `0124_gmail_supplier_invoices.sql`:** `gmail_supplier_invoices` (one row
  per attachment; an email with nothing readable gets one row, part `-`): message id,
  part id, file name/type, received at, sender, subject, storage path, job-document
  path, status new / matched / needs_review / dismissed, reason, error, the read
  fields (supplier, invoice number/date, amount ex GST, GST, total — **money**), PO and
  job refs, `vendor_order_id`, `job_id`, handled by/at. ONE FOR ALL policy on
  `is_office_or_admin()`, granted to authenticated + service_role, revoked from anon,
  in no publication/stream. `gmail_invoice_settings` (one row: `label_name` — the only
  column a person may update, by column grant; `gmail_allowed`, last poll/ok/error,
  resume point — service role). `vendor_orders.invoice_needs_check boolean not null
  default false` (vendor_orders is granted at table level; asserted). Idempotent, no
  temp tables, end state asserted. CI's `seed-roles.sql` seeds one imported row so the
  money sweep checks its amounts.
- **Web (office/admin):** Supplier POs gets **Emailed supplier invoices**
  (`components/supplier-invoices/emailed-invoices-panel.tsx`, loaded on the server as
  the caller): needs review (reason, PDF via a 1-hour signed URL, "Put on this PO" by
  number or **Dismiss**) and the last 30 days' matches (PO link → the job's PO tab,
  "Check and send to Xero" / "Checked"); the label, last check and any error; admin
  **Check now**. Actions → `POST /api/gmail/invoices/[id]` (`assign` / `dismiss` /
  `reopen`, `requireOfficeOrAdmin`, every read and write as the CALLER, row claimed
  first and put back if filing fails; the same conditional PO write). **PO tab:** a
  PO whose invoice came from email shows **"From email — check"** with Edit and
  **Confirm** (clears the flag) instead of Send to Xero; saving the invoice form also
  clears it; `/api/xero/push-vendor-order` refuses (409) while it is set (column read
  separately, so it sends as before without 0124). **Settings → Google:** whether
  Gmail reading is allowed, the label name (editable), link to Supplier POs.
- **Before 0124 is applied nothing breaks:** the cron/Check now answer `{skipped}`;
  the panel and Settings say it isn't switched on; the PO tab never sends the flag
  (the key is only present when the column exists).
- **Tests** (Gmail and Anthropic mocked): `tests/unit/gmail-invoices.test.ts` (rules,
  attachment picking, the Gmail client's 403-scope handling, the import against an
  in-memory database: match + flag + file path, no overwrite of an entered invoice,
  idempotency, no-attachment email, missing scope, no label / not connected,
  untrusted read → review, tables missing) and `tests/unit/gmail-invoice-routes.test.ts`
  (route auth, assign / dismiss / undo, Xero refusal).
- **Checked** on a scratch Postgres 16 (full chain 0000–0122 + CI seed, `/var/tmp/pg124`):
  0124 applies twice cleanly; `supabase/tests/0124_gmail_supplier_invoices_test.sql`
  passes (21 scenarios: anon nothing; a technician reads/inserts/updates/deletes
  nothing in either table; office reads, inserts, dismisses, sets the label but not
  the import state; (message, part) unique; status and blank-label checks) and fails
  naming 8 scenarios with the policy loosened to `using (true)`; the money sweep stays
  intact with the seeded row. **Not verified against live Gmail or the Anthropic API**
  (unreachable from where it was written) — likeliest first-run tweaks: attachment
  shapes from particular suppliers' mailers, and whether the Workspace OAuth app
  lists the Gmail scope.
- **Not done:** credit notes and statements go to review (entered by hand); an
  invoice quoting only a job number (no PO) goes to review — no automatic job
  expense; the phone's office PO tab doesn't show the flag (its Send to Xero gets the
  route's 409 sentence); nothing is labelled back in Gmail.
- **Apply / deploy order:** paste `supabase/migrations/0124_gmail_supplier_invoices.sql`
  → paste `supabase/tests/0124_gmail_supplier_invoices_test.sql` (needs an active
  technician and an active office/admin), trust only `0124 PASSED` → change 0124's
  STATUS line to applied, add the ledger row (`('0124','gmail_supplier_invoices')`),
  regenerate types (`lib/database.types.ts` has both tables and
  `vendor_orders.invoice_needs_check` by hand) → deploy the web → admin: Settings →
  Google → **Reconnect** (grants Gmail read) → in the accounts mailbox create/confirm
  the **Supplier invoices** label and a Gmail filter that applies it to supplier bills
  → Supplier POs → **Check now**. No PowerSync redeploy.

**Invoice payment terms (16 Nov 2026; no migration).** New and Edit Invoice
have a "Payment terms" drop-down (14 days / 30 days / Custom date) beside the
due date (`components/invoice/payment-terms-field.tsx`, rules in
`lib/invoice-terms.ts`, tested). A term fills `due_date` from the invoice date
(today on New, `created_at` on Edit, Melbourne days); only `due_date` is
stored. The phone's New Invoice has "14 days" / "30 days" chips.

**Office invoice and quote actions on the phone (19 Nov 2026; no migration).**
Justin: the office should be able to run invoices and quotes from the phone,
not only create drafts. Office/admin only on every layer: the screens are in
the office route group (`app/_layout.tsx`) and a `RoleGate`, amounts only via
`MoneyText` (no dollar figure in an alert), and every route checks the role.
**Online only** — Xero, email and the PDF renderer answer while the office
waits, and `invoice_payments` is in no sync stream; offline the buttons say
they need signal. Calls in `mobile/lib/invoiceOffice.ts` (Bearer, tested in
`invoiceOffice.test.ts`); errors are the routes' own sentences.
- **Invoice screen** (`mobile/app/invoices/[id].tsx`, reloads on focus and on
  pull): **PDF** (`GET /api/invoices/[id]/pdf` → the job-report viewer,
  `components/finance/document-pdf-button.tsx` + `pdf-preview.tsx`), Send /
  Resend (the existing send screen), **Push / Update in Xero** (admin — the
  route is `requireAdmin`; asks first when the job has unpriced hours, and
  the route's 409 asks again; "Connect Xero on the web first" when not
  connected), the **progress claim** breakdown, the **Payments** card,
  **Hours from the job** with **Apply hourly rate** (`GET/POST
  /api/invoices/[id]/hours`, unchanged; one rate / per technician / per cost
  centre; the "already in Xero / emailed" 409 asks to confirm), Customer PO,
  and **Delete invoice** (office/admin, the web's confirm words incl. the Xero
  warning). The old "PDF and Xero are managed on the web" notes are gone.
- **Payments and delete moved to routes** (they were browser writes on the
  web; the web now uses them too, so both behave alike):
  `GET/POST /api/invoices/[id]/payments` (office/admin; GET also says whether
  Xero is connected, from `xero_tokens.tenant_name` as the web page reads it;
  `payments: null` on a database without 0081), `DELETE
  /api/invoices/[id]/payments/[paymentId]`, and `DELETE /api/invoices/[id]`
  — office/admin, as the web's Delete button always was. All run as the CALLER, so RLS
  and 0081's triggers decide as before; an invoice in Xero refuses a manual
  payment (fixed sentence `PAYMENT_IN_XERO`). Validation `parsePayment` in
  `lib/invoice-payments.ts`; tests `tests/unit/invoice-office-routes.test.ts`.
- **Owed to us** (`components/finance/owed-to-us.tsx`) on top of the office
  Invoices list: outstanding / overdue / not yet due and the late invoices by
  bucket, from `listOwedInvoices` (`lib/data/reads/invoiceExtras.ts`; local —
  unpaid invoices are always in the office window — with a Supabase fallback).
- **New / Edit Invoice:** **Customer PO number**, and when the job has more
  than one priced PO, a picker ("Which builder PO is this invoice for?") with
  "Use PO n's value as the line items"; `/invoices/new?jobId=…&poId=…`
  invoices one PO (its number, a title naming it, `poInvoiceLines`, and "this
  PO already has an invoice"). **Progress claim** fields with the live
  breakdown; ticking fills from the job's previous claim (on the picked PO;
  read from Supabase — it may be outside the window; offline you type them)
  or the job's PO value. Written through the outbox with the invoice
  (`FinanceRepository` `customerPo` / `claim`, sent only when the form has
  them). Nothing on the phone links to `poId` yet — the job's PO tab is a
  separate piece of work.
- **Quotes:** **PDF** and **Send to Customer / Resend** →
  `mobile/app/quotes/[id]/send.tsx` (`POST /api/quotes/[id]/send`).
- **Rules are mirrored, not re-written:** `mobile/lib/invoicePayments.ts`,
  `progressClaim.ts`, `poInvoice.ts`, `invoiceActions.ts` (Push/Delete
  wording, new `lib/invoice-actions.ts`), `customerPo.ts` are the web files
  byte for byte below their header (`tests/unit/invoice-phone-mirrors.test.ts`
  — change the web file first, then copy its body). `ClaimDraft` /
  `claimColumns` / `claimDraftFromInvoice` moved from the web component into
  `lib/progress-claim.ts`; the PO picker helpers (`pricedPos`,
  `poForCustomerPo`, `claimBuilderPo`) into `lib/po-invoice.ts`.
- `getInvoice` now also returns `amount_paid`, `customer_po` and the claim
  columns (all already in the office mirror). No new native module — reaches
  phones with the next build.

**Day Works / Hire, Stage 1 (16 Nov 2026; migration `0108` applied 2026-11-16).**
Justin: hire and cartage are always their own line under a job, never part of
the quoted value or progress claims. Each day's line is signed by the
builder's rep on a phone or tablet, then locks; signed lines are invoiced
weekly or monthly. Operator labour is a separate cost, not in the hire rate.
Stage 1 is web + database + pure rules; the phone comes next.
- **Database (`0108`):** `equipment_hire_options` (per machine: `hire_type`
  wet/dry/cartage/float × `hire_unit` hour/day/engine_hour/km/contract/move,
  `rate`, `fuel_included`, `whole_days_only`, float base / km included / per
  km, `cost_centre_id` — null = the default for the type) and
  `hire_attachments` (name, `day_rate`) are **office/admin only** (they carry
  rates). `hire_entries` (one line per machine per day on a job — floats may
  make several moves — quantities only: hours, days, meter open/close, km,
  pickup/dropoff, description; draft → signed → invoiced, or void; signer
  name, signature path, `invoice_id`) and `hire_entry_attachments` are
  readable and writable by the job's crew (`user_can_manage_job`) and have
  **no money column**. Seeds the four cost centres (Truck Cartage, Plant Wet
  Hire, Plant Dry Hire, Float Moves) and Justin's rates by machine name
  (PC88, PC18, PC35, SVL75/Bobcat, 700L, 962H wet + dry, roller, Warrior
  screener, quad-axle and twin-steer floats; machines not matched are left
  for the office) plus the Trencher attachment at $200/day. Not in any
  PowerSync stream.
- **The lock** (`hire_entries_guard` trigger): an entry is born a draft; the
  cost centre comes from the machine's hire setup (the crew can't choose it;
  `hire_entry_cost_centre()` is SECURITY DEFINER and returns only the id);
  sign-off needs a name, a signature and the quantity for its unit; once
  signed nothing about the machine, date, quantities, description or sign-off
  can change — for anyone. Only office/admin move signed → invoiced (an
  invoice on the same job) or void it; void is final; deleting the invoice
  puts its lines back to signed. Attachments change only on drafts.
- **Pricing:** `lib/hire-pricing.ts` (tested, `tests/unit/hire-pricing.test.ts`):
  wet = hours × rate; dry day = days × rate (the roller rounds up to full
  days); engine hour = (close − open) × rate; cartage by hour, km or contract;
  float = base + max(0, km − included) × per km (quad, 50 km = $570);
  attachments a full day each; clash detection (same attachment, same day,
  two machines — a warning, not a block); totals by cost centre; invoice lines
  from signed entries. Amounts are computed office-side only, at the rates
  current when shown or invoiced (entries don't snapshot a rate).
- **Fleet:** "Hire setup" on each machine (`components/fleet/
  equipment-hire-dialog.tsx`) and an **Attachments** card with day rates
  (`components/fleet/hire-attachments.tsx`), office/admin.
- **Job page:** new **Day Works / Hire** tab (`components/job/
  job-day-works.tsx`, office and the job's crew; not on view-only jobs). Pick
  the machine from the register; the inputs follow its hire type. Office sees
  amounts and totals by cost centre; technicians see quantities only — the tab
  reads through `GET /api/jobs/[id]/hire-entries`, which reads the rate tables
  with the service role after `requireOnJob` and is shaped by
  `lib/day-works-view.ts` (`tests/unit/day-works-view.test.ts` walks the
  technician payload for money keys and rate values). Builder sign-off = name +
  signature drawn on screen (the pad is now shared,
  `components/job/signature-pad.tsx`, also used by the customer sign-off),
  stored in `job-documents` at `<job>/day-works/signature-<entry>-<ts>.png`.
- **Invoice Day Works** (office, on the tab): pick a period (last week / last
  month / all waiting), untick any line, Create invoice →
  `POST /api/jobs/[id]/hire-entries/invoice`: one ordinary draft invoice
  titled "Day Works / Hire — <period>", one line per machine-day plus one per
  attachment, then the lines are marked invoiced. Never touches
  `purchase_orders`, progress-claim fields, `customer_po` or Ready to Invoice.
  Refuses a line whose machine has no rate rather than invoicing $0.
- **0108 applied 2026-11-16 (gate test passed).** Before it, the tab said Day Works isn't switched on and
  Fleet hides the hire controls; nothing else changes. To apply: paste 0108,
  then run `supabase/tests/0108_day_works_hire_test.sql` (needs an active
  technician and an active office/admin profile) and trust only `0108 PASSED`;
  then change 0108's header to applied. Checked on a scratch Postgres 16 with
  the real 0059/0073/0087 functions: applies twice cleanly, seeds by name as
  intended (PC180 and a quad-axle *tipper* not matched), the gate test passes,
  and fails when the lock trigger is disabled.
- **Not done in Stage 1:** the Job Ledger / Job margins don't include hire
  yet — hire revenue is per company cost centre but plant cost is still
  costed from `equipment_usage_log` against PO lines, and operator labour
  would be counted against the quoted work; mixing them now would make the
  quoted margin wrong. Next stages:
  1. ~~**Phone:** Day Works entry and builder sign-off~~ — **done, Stage 2
     (below).** Still to come on the phone: truck day stops (float and
     load km: "Work out km", 27 Nov 2026 — see "Distance lookup"), and an offline path
     if it is ever wanted (outbox + `hire_entries` in a technician stream
     with its columns listed — it has no money column). Office void and
     Invoice Day Works reached the phone on 19 Nov 2026 (Stage 2, below).
  2. **Dry hire controls:** hirer details, condition photos out/in, meter
     readings at hand-over.
  3. **Truck register:** body volume and cartage rates per truck.
  4. **Operator labour not double counted:** the operator's time on a wet
     hire is a cost against the hire line, not the quoted cost centres.
  5. **Reports:** ~~Day Works by cost centre per month~~ — **done (16 Nov
     2026, no migration):** Reports → **Day Works**
     (`app/dashboard/reports/day-works`, office/admin; linked from the
     Reports header). Last 12 months × company cost centre, signed and
     invoiced kept apart (toggle: signed + invoiced / signed only /
     invoiced), drafts shown as a "not yet signed" count and amount, void
     left out; click a month for its job-by-job breakdown, each linking to
     the job's Day Works tab. Priced with `lib/hire-pricing.ts` at
     **today's** rates (entries keep no rate — the page says so); a line
     whose machine has no hire setup is counted as unpriced, never $0. Cost
     centre = the entry's own, else its hire setup's, else the type's
     default by name (as `hire_entry_cost_centre()`), else "Not tagged".
     Reads run under the viewer's session (rate tables are office-only by
     RLS — no service role). Sums in `lib/day-works-report.ts` (pure,
     `tests/unit/day-works-report.test.ts`); without 0108 the page says
     Day Works isn't switched on. **Still to do:** hire revenue (and its
     costs) in the Job Ledger / Job margins.
  6. **Open items from Justin's list:** rates for the other excavators and
     attachments, standby rates (700L dozer and others), fuel and tip-fee
     pass-through, and confirm the twin-steer float's 30 km / $5 per km
     (assumed equal to the quad axle).

**Day Works / Hire, Stage 2 — the phone (16 Nov 2026; no migration).**
Justin's workflow 1 (wet hire, hours) and 2 (dry hire, days or engine hours):
on a job they are on, the crew (and office on the phone) add the day's hire
line and hand the phone to the builder's rep, who signs it; it then locks.
- **Online only, like supplier POs.** No outbox, nothing in PowerSync /
  `sync-streams.yaml`: the builder signs on the spot, and an entry that only
  synced later couldn't be shown to them as locked. Offline the tab says "Day
  Works needs signal".
- **Routes** (all `requireOnJob`; every write uses the CALLER's client via
  `callerClient`, so RLS and 0108's `hire_entries_guard` apply exactly as on
  the web — never the service role for a write; each answers with the fresh
  tab): `POST /api/jobs/[id]/hire-entries` (add a draft; a retry with the
  same client id is answered as saved), `PATCH`/`DELETE
  .../hire-entries/[entryId]` (drafts only), `POST .../[entryId]/sign`
  (`signer_name` + base64 PNG; uploaded to `job-documents` at
  `<job>/day-works/signature-<entry>-<ts>.png`, the web's path, then set
  signed; a retry by the same signer is answered as signed). The GET's reads
  moved unchanged into `lib/day-works-load.ts`.
- **Validation** shared with the web form: `lib/day-works-entry.ts`
  (`buildHireEntryRow` — the web tab now calls it, same words —
  `parseHireEntryBody`, `dayWorksWriteError`: fixed sentences, 0108's own
  refusals passed through only from an exact allow list). Tests:
  `tests/unit/day-works-routes.test.ts` (incl. a technician's GET and POST
  answers walked for money keys and rate/amount values) and
  `tests/unit/day-works-entry.test.ts`.
- **Phone:** a "Day Works" tab after Time (`mobile/app/job/[id].tsx`), only
  for office or someone on the job (lead or crew), never on view-only jobs.
  Calls in `mobile/lib/dayWorks.ts` (Bearer, like `supplierOrders.ts`;
  tested); UI `mobile/components/job/day-works.tsx`: entries by date with
  status, "+ Add day" (KeyboardSheet: machine, hire option, the inputs for
  its unit — hours / days / meter open-close / km + from-to for a float or
  cartage — attachments, description), clash warnings, "Get builder to sign"
  (full-screen name + signature, the same `react-native-signature-canvas`
  pad as the job sign-off). Office amounts only through `MoneyText` inside a
  `RoleGate`, and only when the server sent them.
- Reaches phones with the next build (`react-native-signature-canvas` is
  already in the binary).
- **Office Day Works on the phone (19 Nov 2026; no migration).** The Day
  Works tab's office/admin controls, as on the web, all inside a `RoleGate`
  for office/admin with amounts only via `MoneyText` and only when the server
  sent them (`mobile/components/job/day-works-office.tsx`): **Void** on a
  signed Day Works line or signed truck load (a reason sheet; void is final),
  **Quarry product on this job** (included / extra), each load's **docket
  cost + margin override** with its price breakdown and why it isn't priced,
  **View docket photo** (the office's signed URL), and **Invoice Day Works**
  (Last week / Last month / All waiting, untick lines, "Create draft
  invoice" → the existing `POST …/hire-entries/invoice`; selection rules
  `mobile/lib/dayWorksInvoice.ts`, tested — amounts come only from the
  office's pricing answer, nothing is priced on the phone, an unpriced line
  blocks the invoice). The web used to do four of these as direct browser
  writes; they are now routes both use, all `requireOfficeOrAdmin` + the
  CALLER's client (RLS and the 0108/0111 triggers decide as before; body
  rules in `lib/day-works-office.ts`, routes tested in
  `tests/unit/day-works-office.test.ts`): `POST …/hire-entries/[entryId]/void`,
  `POST …/cartage-loads/[loadId]/void`, `PUT …/cartage-loads/[loadId]/cost`,
  `PUT …/cartage-loads/quarry`. Only a signed line/load is voided (an
  invoiced one must come off its invoice first); a cost is refused once the
  load is invoiced or void. Reaches phones with the next build.
- **Not on the phone:** truck day stops, offline entry. (Km: "Work out km",
  see "Distance lookup for floats and truck loads".)

**Office PO tab and job documents on the phone (19 Nov 2026; no migration).**
Justin: the office should be able to run a job's POs from the phone. Office/admin
only, online only ("Purchase orders need signal"), never the outbox: supplier
orders are in no PowerSync stream, a supplier invoice becomes a Xero bill, and a
PO's value is what the job is measured against.
- **Phone:** a **POs** tab on the job screen (`mobile/app/job/[id].tsx`, shown only
  to office/admin; the component is also inside a `RoleGate`, every figure through
  `MoneyText`) — `mobile/components/job/purchase-orders.tsx`, calls in
  `mobile/lib/jobPurchaseOrders.ts` (tested). Add / Edit / Remove a builder PO
  (number defaults to `<job>-n`, client, site, value, split lines per company cost
  centre with hours; "not split yet" / "over"; a line with supplier orders, time or
  expenses can't be removed — set it to $0); **Add cost centre** (the edit form
  with a line holding what's left); **Invoice this PO** → the phone's New Invoice
  with `poId` (`app/invoices/new.tsx`: the PO's lines from `mobile/lib/poInvoice.ts`,
  a title naming it, `invoices.customer_po` set — `CreateInvoiceInput.customerPo` —
  and a note when the PO already has an invoice). Under each line its supplier
  orders: amount ex GST, **+ Enter supplier invoice** (number, date, amount, GST
  shown, a photo from the camera or library), **Send to Xero**
  (`/api/xero/push-vendor-order`, unchanged), status, remove; a Xero bill's amount
  stays locked. Rules mirrored byte-for-byte below the header: `lib/builder-po.ts`
  → `mobile/lib/builderPo.ts`, `lib/po-invoice.ts` → `mobile/lib/poInvoice.ts`
  (`tests/unit/builder-po-mirror.test.ts`).
- **Routes** (all `requireOfficeOrAdmin`, every read and write as the CALLER via
  `callerClient`, never the service role; fixed sentences; `lib/job-purchase-orders.ts`
  holds the reads and helpers): `GET/POST /api/jobs/[id]/purchase-orders` (the tab;
  add, idempotent on the phone's PO id), `PATCH/DELETE .../purchase-orders/[poId]`
  (the web's `planBuilderPoEdit`, with "in use" worked out on the server from fresh
  reads — the phone's word isn't trusted), `PATCH/DELETE
  .../supplier-orders/[orderId]` (amount / status / remove), `POST
  .../supplier-orders/[orderId]/invoice` (file to `job-documents` at the web's
  `{job}/expense-receipt-{PO}-{ts}_{name}`, so 0047 hides it from technicians;
  removed again if the row write fails). Tests: `tests/unit/job-purchase-orders.test.ts`.
  The web PO tab still writes from the browser as before (unchanged); it could move
  onto these routes later.
- **Job documents (phone, office/admin):** the Documents tab gets **Take photo / Add
  photo** (name, "Office only" switch), a lock to toggle office-only (0065) and
  delete — `POST /api/jobs/[id]/documents` (base64 ≤ 3 MB, sniffed JPEG/PNG/WebP/PDF,
  the web's `{job}/{ts}_{name}` path, row as the caller, file removed if the row
  fails) and `PATCH/DELETE .../documents/[docId]` (row first, then the file).
  **Choose file** (27 Nov 2026, needs a new build) uploads a PDF or photo from the
  phone's files — see "PDF and other files from the phone" below.
- **Not on the phone:** pinning a typed PO site on the map (the job site's pin is
  reused when the address is the job site's, otherwise none — pin it on the web),
  opening the crew's docket photos from the PO card, "Mark stage complete" from the
  PO card. Reaches phones with the next build (no new native module); needs the web
  deployed first.

**PDF and other files from the phone (27 Nov 2026; no migration, no stream change; NEEDS A NEW BUILD — native module).**
The binary had no document picker, so PDFs (supplier invoices, plans, fleet
service invoices) could only be uploaded on the website. `expo-document-picker`
(~14.0.8, the SDK 54 pin; no config plugin needed — no iCloud entitlement) is
now a dependency of `mobile/`. It is a **native module**: it reaches phones only
through a new `eas build`, never an OTA update. It is loaded **lazily**
(`mobile/lib/documentPicker.ts`, the `lib/dictation.ts` pattern), so an OTA
update reaching an older binary just hides the new buttons.
- **Where:** the four existing office/admin upload paths, nothing new on the
  server — every route already accepted PDFs (bytes sniffed, ≤ 3 MB as base64):
  job **Documents** tab → **Choose file** (`POST /api/jobs/[id]/documents`; name
  prefilled from the file, folder and Office only as before); the **POs** tab's
  supplier invoice → **Choose file** (`…/supplier-orders/[orderId]/invoice`; the
  file name now carries the real extension); Fleet **Log a service** → **File**
  (read by `/api/fleet/service-invoice/read`, saved through
  `/api/fleet/[id]/service-records` as `service-invoice-<date>.pdf`); Fleet
  machine **Documents** → **File** (`/api/fleet/[id]/documents`); the invoice
  email's **Attachments** → **Files** (several at once, any allowed type —
  Word, Excel, CSV… — against the same 10-file / 3 MB rules).
- **Checks before sending** (`documentPicker.ts`, tested in
  `mobile/lib/documentPicker.test.ts` with the module mocked): only PDF or a
  photo for the upload routes; a PDF over 3 MB is refused by its reported size
  before it is read ("… the phone can send 3.0 MB at most. Upload it on the
  website instead."); a picked photo (HEIC included) is shrunk by `prepareImage`
  like the camera path; the bytes are sniffed as the routes do (a renamed Word
  file is refused); the picker's cache copy is deleted after reading.
- Technicians: unchanged — no technician screen uploads documents on the phone
  (the routes above are office/admin).

**Fleet service history takes the invoice by drag and drop (17 Nov 2026; no migration).**
Justin: "What happened to the drag and drop in the fleet? We drop the invoices
for servicing … so it populates the service history." The drop zone lived on
the old "Expenses & Service" tab; the Service history tab (0099) added on
15 Nov had no file field, so invoices stopped reaching it. "Log a service"
(`components/fleet/equipment-service-records.tsx`) now has a drop zone:
dropping a file switches the cost to "Log the cost now", and the file is
uploaded to `equipment-documents` at `serviceInvoicePath()`
(`lib/service-due.ts`, tested — the `expense-receipt-` shape, so 0047 keeps it
from technicians) and saved as that expense's `receipt_storage_path`. A failed
upload saves nothing; a failed expense or service insert removes the file
again. Each service card shows "View invoice" when its cost has a file. The
old tab is now labelled **Expenses**.
- **The invoice is read automatically** (Justin, 17 Nov 2026). On drop, a
  photo is shrunk in the browser (`lib/image-resize.ts`) and the file goes to
  `POST /api/fleet/service-invoice/read` (office/admin; ≤3 MB — it travels as
  base64 in the request; bytes sniffed, PDF/JPEG/PNG/WebP only; rate limit
  `service-invoice-read`, 30 per 10 min). `lib/service-invoice-read.ts` reads
  it with `claude-opus-5-5` (structured output, effort low, server-side
  refusal fallback): workshop, invoice number, date, amount ex GST and GST,
  odometer / engine hours, service type, a short work-done summary, the next
  service due if printed, and the vehicle as printed; `cleanServiceInvoice`
  drops impossible dates, negatives and a next-due that isn't ahead. The
  form is filled by `applyServiceInvoiceRead` (`lib/service-invoice-form.ts`):
  only fields still empty (or on their defaults — today, "Scheduled
  service"); typed values are never overwritten; an already-linked expense is
  kept. A note says "check it's this machine" with the vehicle the invoice
  names, and warns when the file isn't a service invoice. Nothing is saved
  until the office presses Save. A failed or skipped read leaves the file
  attached. Tests: `tests/unit/service-invoice-read.test.ts`.

**Fleet office features on the phone (19 Nov 2026; no migration, no stream change).**
Justin: bring the website's Fleet office/admin features to the phone. All
office/admin only, all **online only** (service records, hire rates and
attachments are office-only tables in no PowerSync stream); every write goes
through a web route guarded by `requireOfficeOrAdmin` that writes with
`callerClient` (RLS runs as the caller, never the service role), with fixed
error sentences. Rules in `lib/fleet-office.ts`; routes tested in
`tests/unit/fleet-office-routes.test.ts`. The web screens still write
directly as before; the routes are there for them to share.
- **Service history** (`mobile/components/fleet/ServiceHistory.tsx` on the
  machine screen): due banner, services with "View invoice", delete; **Log a
  service** with the invoice as a **photo** (camera or library → `prepareImage`
  1600px JPEG) or, from the next build, a **PDF from the phone's files**, read automatically by `POST /api/fleet/service-invoice/read`
  and filled by `applyServiceInvoiceRead` (only empty / default fields),
  next service due, no cost / log the cost now / link an existing expense.
  Nothing is saved until Save → `GET/POST /api/fleet/[id]/service-records`
  (+ `DELETE …/[recordId]`): the server uploads the invoice to
  `equipment-documents` at `serviceInvoicePath()` (so 0047 hides it from
  technicians), then the new cost, then the service — a failed upload saves
  nothing; a failed service removes the cost and file again. The phone sends a
  client id, so a retry after a lost answer is answered as saved.
- **Hire setup per machine** (`mobile/components/fleet/HireSetupSheet.tsx`,
  "Hire setup" on the machine screen) and **Fleet → Hire rates**
  (`mobile/app/fleet/hire-rates.tsx`, tag icon in the Fleet header; office
  route group): every hireable machine, unpriced first, Set up / Edit, plus
  hire attachments (add, day rate, offered). Units include cartage per tonne /
  m³ (0111). Routes `GET/PUT /api/fleet/[id]/hire-options` (the web dialog's
  save rule: upsert by machine+type+unit, remove what's no longer listed),
  `GET /api/fleet/hire-rates` (built with `lib/fleet-hire-overview.ts`),
  `POST /api/fleet/hire-attachments`, `PATCH …/[attachmentId]`.
- **Per load carted** (0091 `equipment.cost_per_load`) in the phone's
  equipment edit form (outbox, as the rest of the cost profile; sent only
  when given, so an older form never wipes it), shown on the machine's running
  cost; **year-cost summaries**: "Costs logged — FY" per machine
  (`components/fleet/EquipmentYearCost.tsx`) and "Fleet costs logged — FY" on
  the Fleet list (`components/fleet/FleetYearSummary.tsx`, read
  `listFleetExpenses`, local-first — `equipment_expenses` is unwindowed).
- **Equipment documents upload** (photos; PDFs from the next build) → `POST /api/fleet/[id]/documents`
  (≤ 3 MB base64, bytes sniffed PDF/JPEG/PNG/WebP; file then row as the
  caller, file removed if the row fails).
- **Mirrors** pinned by `tests/unit/fleet-mobile-mirror.test.ts`:
  `mobile/lib/serviceDue.ts` = `lib/service-due.ts`,
  `mobile/lib/serviceInvoiceForm.ts` = `lib/service-invoice-form.ts`,
  `mobile/lib/fleetCosts.ts` = `lib/fleet-costs.ts` (below the imports),
  `mobile/lib/hireLabels.ts` = `lib/hire-pricing.ts`'s hire vocabulary. Change
  the web file first, then copy. Calls in `mobile/lib/fleetOffice.ts` (tested).
- **PDF** invoices and documents from the phone: see "PDF and other files
  from the phone" (27 Nov 2026, needs a new build). Money only through
  `MoneyText` inside `RoleGate` (Hire rates' rate lines are server-formatted
  text, shown only inside the office-only route and a `RoleGate`). Reaches
  phones with the next build (no new native module); the web routes must be
  deployed first.

**Notebook list (20 Nov 2026): existing jobs on the schedule, Copy job, site pin at clock-on, customer billing address, document folders (migration `0114` applied 2026-11-25, after the 0117 catch-up — an earlier note wrongly said 21 Nov).**
Five items from Justin's list, web and phone.
- **A. Schedule an existing job.** The board only offered New Job. Web board
  (`components/schedule/team-schedule-view.tsx`, office/admin): a
  **Schedule existing job** button in the toolbar and a **+** on each
  technician's day (Week cell, on hover; Day view under the name; today on)
  open `components/schedule/schedule-existing-job-dialog.tsx` — open jobs
  (not completed/cancelled) by number, or every word in the title or
  customer name/company, searched in the database as you type, ≤ 20. Picking
  one went to `/dashboard/jobs/<id>?schedule=1&tech=<staff>&day=<YYYY-MM-DD>`
  (since 23 Nov 2026 the board opens the dialog over itself instead — "Schedule
  from the board" under Job bookings — web; the link still works);
  the job page opens `ScheduleJobDialog` with a NEW row for that technician
  and day beside any saved bookings (`prefill`; a technician not in the staff
  list or a bad date is dropped). Cost centre, leave and clash rules are the
  dialog's own, unchanged. Phone office Schedule tab: **Schedule existing
  job** beside To-do → `components/schedule/ScheduleExistingSheet.tsx`
  (`lib/data/reads/scheduleSearch.ts`, online) → "Tap a technician's day to
  schedule #n" (or **Skip**) → `/job/<id>?schedule=1&tech=&day=`, which opens
  the Schedule Job sheet on a new booking for them (`prefill` in
  `components/job/schedule-job-modal.tsx`). Rules `lib/schedule-existing-job.ts`,
  mirrored at `mobile/lib/scheduleExistingJob.ts`
  (`tests/unit/schedule-existing-job.test.ts`).
- **B. Copy job / use as a template.** Web job page header **Copy job**
  (office/admin, `components/job/copy-job-dialog.tsx`, title editable,
  "Copy of …" by default) and the phone's Update job sheet (**Copy job**,
  `RoleGate` office/admin, online) both call **`POST /api/jobs/[id]/copy`**
  (`requireOfficeOrAdmin`, every read and write as the CALLER, fixed
  sentences; tests `tests/unit/job-copy.test.ts`). Copies customer, site,
  title, job type, priority, description; makes the job `pending`; copies the
  source's PO cost-centre LINES (name, company cost-centre tag, code, allowed
  hours — amount 0) under a new `<new job number>-1` PO valued $0. Never
  copies bookings, time, photos, notes, documents, invoices, variations,
  schedule or money. `newJobId` (client UUID) makes a retry return the job it
  already made; if the PO can't be saved the job is kept and the answer warns
  (add the cost centres on the PO tab). Rules `lib/job-copy.ts`.
- **C. Site location at a manual clock-on (phone).** After a manual clock-on
  (Time tab, Today card), `mobile/lib/sitePinOffer.ts` reads the job's site
  online; if it has no `site_lat/site_lng` and the clock-on fix is within
  ±50 m, it asks once per job (AsyncStorage) "This site has no map location —
  save where you are now…?" Yes → the existing `/api/jobs/[id]/site-location`
  route (`postSiteLocation` in `lib/siteLocation.ts`, the same fix). Never
  silent, never with a pin already there, offline it doesn't ask. Web job
  Overview's "No map location" warning now says how to set it on site.
- **D. Customer billing address.** `customers.billing_address` (0114, text,
  ≤ 500). Web: New / Edit Customer (edit hides the field until the column
  exists), shown on the customer page; printed under the billed name (and
  Attn:) on invoice and quote PDFs (`lib/pdf/document-template.tsx`; the
  invoice/quote pdf and send routes) and on the invoice/quote detail pages.
  Read with its own small query (`lib/customer-address-load.ts`): a missing
  column (before 0114) or any failure = no address, never a broken document.
  No fallback to the site address. Phone: customer form + detail; the address
  is read ONLINE (`getCustomerBillingAddress`) — no PowerSync stream carries
  it, so no sync-rule redeploy; when it couldn't be read the edit form hides
  the field and never sends it; writes go through the outbox
  (`CustomersRepository`, sent only when given) and the gateway drops the
  column on a database without it (`optionalColumns.ts`). Rules
  `lib/customer-address.ts`, mirrored at `mobile/lib/customerAddress.ts`.
- **E. Document folders.** (Keys replaced on 24 Nov 2026 by the drafted
  0116 — see "Job folders for documents AND photos"; the text below is the
  0114 state.) `job_documents.folder` (0114): `site_documents`,
  `drainage`, `plumbing`, `soil`, NULL = **Other** (all legacy rows). Web
  Documents tab: grouped by folder with counts, collapsible; the upload asks
  which folder (default Site Documents); each document has a "move to folder"
  select for office/admin and for the job's crew on documents they can edit
  (the 0065/0074 RLS — office-only documents stay office/admin). Phone
  Documents tab: grouped and collapsible for everyone; office/admin pick the
  folder on upload and move documents (folder icon) through
  `POST /api/jobs/[id]/documents` (`folder`) and `PATCH …/documents/[docId]`
  (`folder`, alone or with `officeOnly`; 409 "folders aren't switched on yet"
  before 0114). job_documents is in no stream, so no PowerSync change.
  Rules `lib/document-folders.ts`, mirrored at `mobile/lib/documentFolders.ts`.
- **Before 0114 is applied nothing breaks:** web uploads and route inserts
  retry without `folder`; folder controls hide while rows have no `folder`
  key; billing-address readers answer null; New Customer saves without the
  address and says so.
- **Apply order:** paste `supabase/migrations/0114_customer_address_doc_folders.sql`
  → paste `supabase/tests/0114_customer_address_doc_folders_test.sql` (needs
  an active technician and an active office/admin), trust only `0114 PASSED`
  → mark 0114's header applied, add the ledger row, regenerate types
  (`lib/database.types.ts` has both columns by hand) → merge web → ship the
  phone build. **No PowerSync redeploy** (no stream changed). The phone parts
  need the web deployed first (`/api/jobs/[id]/copy`, the documents `folder`).
- **Not done:** the phone's invoice/quote detail screens don't show the
  billing address (the PDFs do); technicians can't move documents on the
  phone; folders can't be renamed or added (fixed list, a check constraint).

**Komtrax (Komatsu machine data), 20 Nov 2026; migration `0113` applied 2026-11-20.**
Justin: connect Komatsu's Komtrax ISO 15143-3 (AEMP 2.0) web API so the
Komatsu machines' own data flows into Fleet. Read-only toward Komatsu.
- **What it reads** (`lib/komtrax.ts` sync, `lib/komtrax-parse.ts` parsing):
  a fleet snapshot (`/v1/400673/Fleet/{page}`, 100 per page) — engine hours
  (SMR, `CumulativeOperatingHours`), last known location + time, fuel used
  (cumulative + last 24 h), fuel/DEF remaining %, idle hours — then per
  machine the last 2 days' hour-meter and fault-code time series
  (`…/MakeModelSerial/{make}/{model}/{serial}/{CumulativeOperatingHours|FaultCode}/{start}/{end}`;
  `FaultCodes` is tried when `FaultCode` answers 404).
- **Tables (`0113`)**: `komtrax_machines` (one per make/model/serial, latest
  snapshot, `equipment_id` link + `matched_by` auto/office), `komtrax_hour_readings`,
  `komtrax_faults`, `komtrax_sync_state` (one row: last run/ok, per-URL last
  call times, `last_error` — no column grant to signed-in users). Office/admin
  read by RLS; only the service role writes, except the office may set the
  link (`equipment_id`, `matched_by` column grant). **No money column** (the
  money-sweep regex is asserted). In no PowerSync stream (`sync-streams.yaml`
  untouched); granted explicitly.
- **Matching:** the register has no serial column, so the sync links a new
  Komtrax machine when its serial appears as a whole word in exactly one
  active fleet item's name, rego or notes (`matchEquipmentBySerial`).
  Everything else: **Fleet → Komtrax machines** card (office/admin) — a
  select per machine → `PATCH /api/komtrax/machines/[id]` (caller's client;
  `matched_by='office'`, which the sync never overrides, including an unlink).
- **Sync:** `GET /api/komtrax/sync` (cron `47 */6 * * *`, `requireCronSecret`)
  and `POST` (admin — "Sync Komtrax" on the card). Token: `POST /token`,
  form-encoded password grant, kept in memory for the run only (never
  stored). **Rate limit:** Komatsu allows each URL once per 15 min per user —
  a run within 15 min of the last one is answered `{skipped:true}` without
  calling Komatsu, every URL's last call is kept in `url_calls` and skipped if
  recent, and a run makes at most 80 requests (40 s budget). Errors: fixed
  sentence to callers; status-only message to logs, `last_error` and
  `reportError` (tags only) — never a body or credential.
- **Service due** (`lib/service-due.ts`, mirrored at `mobile/lib/serviceDue.ts`):
  `serviceDue(records, today, live)` takes Komtrax's hours as a live meter —
  past the record's `next_due_hours` = overdue, within 50 h = due soon, the
  worse of date and hours decides ("Service overdue by 12 engine hours").
  Without a live meter, behaviour is unchanged. Used by the Fleet list, the
  machine page and its Service history (web) and the phone's Service history.
- **Machine page** (web `components/fleet/equipment-komtrax.tsx`; phone
  `mobile/components/fleet/KomtraxCard.tsx` via `GET /api/fleet/[id]/komtrax`,
  office/admin, online): hours + when read, idle hours, location ("Open in
  maps"), fuel last 24 h / lifetime, tank/DEF %, fault codes from the last 30
  days.
- **Day Works engine-hour lines:** the hire-entries GET payload carries
  `meter_readings` (machine → Melbourne day → first/last reading; hours only,
  read with the service role after `requireOnJob`, last 62 days). A NEW
  `engine_hour` line on a linked machine has its meter open/close filled from
  that day's first and last readings (`lib/komtrax-meter.ts`, mirrored at
  `mobile/lib/komtraxMeter.ts`, pinned by `tests/unit/komtrax-mirror.test.ts`);
  editable, typed values never overwritten, the builder still signs.
- **Weekly digest:** "Active machine faults (last 7 days)" — one line per
  machine + code (`loadRecentFaultsForDigest`); left out when Komtrax tables
  aren't there; a read failure never stops the email.
- **Env:** `KOMTRAX_USERNAME`, `KOMTRAX_PASSWORD` (secret; already in Vercel
  Production), optional `KOMTRAX_SUBSCRIBER_ID` (default `400673`) — accessors
  in `lib/env.ts`. Unset → the sync answers `{skipped:true}` and Fleet says
  "Komtrax not connected".
- **Not verified against the live API** (no access from where it was
  written). Parsing is built from the standard + Komatsu's manual and is
  deliberately forgiving (case/`@`-insensitive keys, a single object as a list,
  `{"#text": …}` values). Likeliest first-run tweaks: the exact JSON wrapping
  of a time-series answer, the fault data-item name, the date format in the
  series URL (`YYYY-MM-DDTHH:mm:ssZ` unencoded), and `MakeCode` vs `OEMName`
  as the URL's make. The "first reading of the day" is only as early as
  Komtrax's ~6-hourly refresh — the crew should check it against the meter.
- **Apply order:** paste `0113_komtrax.sql` → paste
  `supabase/tests/0113_komtrax_test.sql` (needs an active technician and
  admin), trust only `0113 PASSED` → mark 0113's header applied and add the
  ledger row → merge/deploy the web → admin: Fleet → Komtrax machines → Sync
  Komtrax, then link any machine not linked by serial. The phone parts reach
  devices with the next build (no native module) and need the web deployed.
  No PowerSync redeploy.

**Day Works lists the whole fleet; Fleet → Hire rates (16 Nov 2026; no migration).**
Justin: "The whole Fleet doesn't seem to be there." The picker used to list
only machines with an active `equipment_hire_options` row, and 0108 seeded
rates by name match only, so every other machine was invisible.
- **Day Works picker** (web `components/job/job-day-works.tsx`, phone
  `mobile/components/job/day-works.tsx`): every active machine that is not a
  `tool` (0108's seed rule; `isHireableMachine` in `lib/day-works-view.ts`).
  One with no active hire option arrives with `options: []` and is shown
  greyed, unpickable, under "No hire rate yet — office to set up in Fleet"
  (office on the web gets a link to Fleet → Hire rates and a count of
  unpriced machines). Split by `splitMachinesByHire` (web lib, mirrored in
  `mobile/lib/dayWorks.ts`). Technicians still get names, hire types and
  flags only. The server already refused a line for a machine with no
  option (`hireOptionFlags` → 400); now tested for an unpriced machine.
  "No machines in the fleet register" shows only when the register is empty.
- **Fleet → Hire rates** card (`components/fleet/fleet-hire-rates.tsx`,
  office/admin, anchor `#hire-rates`, above Attachments): every hireable
  machine with its options and rates (`lib/fleet-hire-overview.ts`, tested),
  or an amber "No hire rate yet"; unpriced first with a count, each with
  Set up / Edit opening the existing Hire setup dialog.

**Truck loads (cartage), 17 Nov 2026; migration `0111` applied 2026-11-19.**
Justin: the truck driver logs each trip on the job as it happens — **material
in** (quarry product, e.g. crushed rock / quarter-minus, from a quarry to the
job) and **spoil out** (dirt carted from the job to a tip) — instead of only
end-of-day hours and loads. His rules:
1. "Some jobs include quarry products, some don't." Each material-in load is
   **included** (in the quoted price — a cost only, never invoiced) or
   **extra** (charged to the builder). `jobs.quarry_included` is the job's
   default (null = included), set by the office on the Day Works tab (a
   trigger refuses anyone else); the driver can change it per load.
2. "The spoil removal is almost always an extra charge." Spoil-out loads
   default to **extra**; the driver can switch one to included.
3. Spoil cartage is charged per tonne or per m³ (off the tip docket) at the
   truck's own rate: `equipment_hire_options` (0108) now takes `hire_unit`
   `tonne` / `m3` for `hire_type = 'cartage'` (Fleet → Hire setup offers
   them). They are never a Day Works entry's unit (hire_entries' check is
   unchanged; the Day Works picker leaves them out).
4. Quarry product and tip fees charged on are **cost + margin + km**. Rules in
   `lib/cartage-pricing.ts` (pure, `tests/unit/cartage-pricing.test.ts`):
   extra spoil = quantity × per-tonne/m³ rate + tip fee × (1 + margin) + km ×
   per km; extra material = product cost × (1 + margin) + km × per km (+
   quantity × per-tonne/m³ when the truck has that unit's rate). Margin =
   the load's override (`cartage_load_costs.margin_pct`, office) else
   `billing_rate_config.cartage_margin_pct` (Settings → Truck loads, default
   15%). **An extra whose docket cost isn't entered, or whose truck lacks a
   needed rate (per km when km > 0; per tonne/m³ for spoil), is not priced and
   can't be invoiced** — never $0. Spoil as a bare "load" is refused unless
   it's included.
- **Database (`0111`):** `cartage_loads` — one row per trip, **no money
  column** (the included/extra flag is named `billing`, not "charge", so the
  money sweep's regex doesn't match it). Crew read/write via
  `user_can_manage_job`, office everything. Same lock as 0108's Day Works
  (`cartage_loads_guard`): born draft; cost centre from the truck's cartage
  hire setup, else **Transport**, else Truck Cartage (crew can't choose it;
  `cartage_load_cost_centre()` SECURITY DEFINER, also refuses a tool); the
  `billing` default is filled in by the trigger; sign-off needs name +
  signature + quantity; once signed nothing changes for anyone (only the
  office may still attach a docket photo); only office moves signed →
  invoiced (extras only, same job's invoice) or void; void is final;
  deleting the invoice puts its loads back to signed. Included loads need no
  signing. `cartage_load_costs` (load_id → `docket_cost_ex_gst`,
  `margin_pct`, entered_by/at): **office/admin only**, locked once the load
  is invoiced or void. `billing_rate_config.cartage_margin_pct` (admin table;
  the app reads/writes that one column through the service role after
  `requireOfficeOrAdmin`). In no PowerSync stream; `sync-streams.yaml`
  untouched (`jobs.quarry_included` reaches office devices through
  `office_jobs`' `jobs.*`; added to `mobile/lib/powersync/schema.ts` by
  hand). CI's `supabase/ci/seed-roles.sql` seeds one load + cost so the money
  sweep checks the new money table.
- **Docket photos show prices.** Stored in `job-documents` at
  `<job>/expense-receipt-cartage-<load>-<ts>.<ext>`, which 0047/0065's
  `storage_object_is_money_document()` hides from technicians (0111 asserts
  it). Technicians can't write there, so `POST …/cartage-loads/[loadId]/docket`
  checks `requireOnJob` + reads the load as the caller (draft, or office on a
  non-void load), sniffs JPEG/PNG/WebP ≤ 3 MB, uploads with the service role
  and sets `docket_photo_path` with the service role (the guard keeps that
  column out of the crew's own writes). The crew only ever see
  `has_docket_photo`; office gets a signed URL.
- **Routes** (`app/api/jobs/[id]/cartage-loads/**`, mirroring hire-entries;
  `requireOnJob`, writes with `callerClient` except the docket path above,
  fixed-sentence errors via `lib/cartage-load-entry.ts`): GET (reads in
  `lib/cartage-load.ts`, shaped by `lib/cartage-view.ts` — trucks are active
  non-tool vehicles or anything with a cartage rate; quarries are the
  `suppliers` list, names only), POST add (idempotent on client id), PATCH /
  DELETE drafts, `sign/` (several loads, one name + signature, one UPDATE so
  all sign or none; signature at `<job>/day-works/signature-loads-<ts>.png`),
  `[loadId]/docket`. `tests/unit/cartage-routes.test.ts` walks a technician's
  GET/POST/docket answers for money keys, rate/cost/margin/price values and
  docket paths.
- **Phone** (`mobile/components/job/truck-loads.tsx`, calls/rules
  `mobile/lib/truckLoads.ts`, tested): a "Truck loads" section at the foot of
  the job's Day Works tab — "+ Material in" / "+ Spoil out" → KeyboardSheet:
  date, truck, quarry (the supplier picker; "Other" types one) + material, or
  the tip, quantity + unit (t / m³ / loads), km, docket number + photo
  (`prepareImage`, uploaded after the load saves), included/extra with the
  defaults above, optional from/to. "Get builder to sign (N extras)" per day
  signs that day's draft extras at once. Online only, like Day Works. Office
  amounts only via `MoneyText` in `RoleGate`. Reaches phones with the next
  build (no new native module).
- **Web** (`components/job/job-truck-loads.tsx`, on the Day Works tab): the
  loads by day; office sets the job's quarry default, enters each load's
  docket cost (and margin override) and sees each extra's breakdown or why it
  isn't priced, views the docket photo, voids a signed load. **Invoice Day
  Works** lists signed extra loads beside the Day Works lines and puts them on
  the same invoice, one line each ("Spoil removal 12 t — 12 Smith St,
  Craigieburn → Wollert tip, docket 1234"; quantity 1 at the load's price, the
  margin not shown), marking them invoiced (`hire-entries/invoice` takes
  `loadIds`). The web does not add or sign loads — that's the phone. The
  office's writes (quarry default, docket cost, void) go through office-only
  routes shared with the phone (Day Works Stage 2, "Office Day Works on the
  phone").
- **Today's run — the driver's run sheet (phone, 19 Nov 2026; no migration).**
  Justin: a driver booked on cartage floats between jobs in a day (rock to
  Job A, on to Job B, back to Job A). My Jobs shows a **"Today's run (N
  jobs)"** card on top when the signed-in user (technician or office) has at
  least one of THEIR OWN bookings today (Melbourne day, the 0071 day rules via
  `bookingWindow` — never `starts_at` alone) whose cost centre is cartage:
  the booking's PO line tagged with company cost centre **Transport** or
  **Truck Cartage** (0087/0108 — the names 0111 falls back to), or, for a
  line the office never tagged, 0087's keyword rule on its name. No such
  booking (or offline) → no card. The card opens `app/run/today.tsx`
  (registered beside `job/[id]` for every role; screen
  `mobile/components/run/todays-run-screen.tsx`, calls/helpers
  `mobile/lib/todaysRun.ts`, tested): today's cartage jobs in booking order —
  number/title, customer, site + **Navigate** (`openNavigation`), booking
  time and cost centre, today's loads (counts, t / m³ / km by direction,
  each load's status), **+ Material in** / **+ Spoil out** (the same form
  as the job's Truck loads — moved to
  `mobile/components/job/truck-load-forms.tsx`, shared), **Get builder to
  sign (N extras)** (the existing sign flow), **Open job**; day totals at
  the foot; **+ Add a job** logs against another of their own open jobs
  (lead or crew) not booked today (it then stays on the run for the day);
  pull to refresh. Online only ("Today's run needs signal"). Writes are the
  existing `…/cartage-loads` routes, unchanged.
  - **Server:** `GET /api/runs/today` (`?summary=1` = the card's count only),
    rules `lib/todays-run.ts` (tested in `tests/unit/todays-run.test.ts`).
    Bookings, jobs and loads are read with the CALLER's client (RLS);
    the service role reads only (a) `po_cost_centers` `id, name` + its
    company cost centre's name, for the cost-centre ids on the caller's own
    bookings — technicians can't read that table (it carries money), and it
    is what says a booking is cartage — and (b) trucks/quarries/cost-centre
    names through `loadCartageLists()` → `buildTruckLoadsView` (names only),
    as the job's Truck loads section already does. **No money for anyone**:
    the run sheet is quantities only; office sees prices on the job's tab.
    `tests/unit/todays-run-route.test.ts` walks technician and office
    payloads for money keys, rate/allocation values and docket paths. Guard:
    `requireRole` (admin/office/technician — an active user with a role).
- **Before 0111 is applied** nothing breaks: the section says truck loads
  aren't switched on (GET answers `{ready:false}` on 42P01/42703/PGRST2xx),
  Settings → Truck loads says the same, Invoice Day Works works as before.
  Fleet → Hire setup will offer per tonne / m³ but the database refuses to
  save them until 0111 — so don't set those rates before applying it.
- **Not done (follow-ups):** load costs are **not** in the Job Ledger / Job
  margins (`lib/job-ledger.ts`) — quarry product already reaches the ledger
  through supplier PO invoices, so adding docket costs now would count it
  twice; decide which source wins first. No report of loads by month yet.
- **Apply order:** paste `0111_cartage_loads.sql` → paste
  `supabase/tests/0111_cartage_loads_test.sql` (needs an active technician and
  an active office/admin) and trust only `0111 PASSED` → change 0111's header
  to applied and add the ledger row → merge (web first, then the phone
  build). Checked on a scratch Postgres 16 with the full chain 0000–0110
  (Supabase roles/auth/storage/pg_net shimmed): 0111 applies twice cleanly,
  the gate test passes (35 scenarios) and fails, naming scenarios, with the
  lock trigger disabled or the cost table's RLS off; the money boundary sweep
  stays intact with the seeded load and cost.

**Distance lookup for floats and truck loads (27 Nov 2026; no migration, no stream change).**
Km were typed by hand. Justin chose the FREE OpenStreetMap route — no key, no account.
- **"Work out km"** beside the km box: phone truck loads
  (`mobile/components/job/truck-load-forms.tsx` — used by the job's Truck
  loads and Today's run), phone Day Works km / float lines
  (`mobile/components/job/day-works.tsx`), web Day Works km / float lines
  (`components/job/job-day-works.tsx`; the web box now takes 0.1 km). Button
  components `mobile/components/job/km-lookup.tsx` and
  `components/job/km-lookup-button.tsx`. The answer fills the box only if
  nobody typed in it while the lookup ran (`shouldFillKm`); the box stays
  editable; a note says "≈ 23.4 km by road from Boral Wollert … to 12 Smith
  St", in amber with "approximate" when an end only matched a street or
  suburb. Online only — offline the phone says it needs signal. Technicians
  may use it; no money anywhere.
- **The trip** (`lib/distance-trip.ts`, mirrored byte for byte from the
  first export at `mobile/lib/distanceTrip.ts`,
  `tests/unit/distance-trip-mirror.test.ts`): a float / km line is pick-up →
  drop-off, an empty end = the job site; a load uses its From / To boxes,
  else material in = the picked quarry (or typed place) → the job site, spoil
  out = the job site → the tip.
- **Route** `GET /api/distance?from=&to=&jobId=` or `POST {from, to, jobId}`
  (`app/api/distance/route.ts`): `requireRole(admin, office, technician)`;
  per-user `consume_rate_limit()` bucket `distance` (30 per 10 min); each end
  is `lat,lng`, a place/address, or `site` = the job's site, read as the
  CALLER (RLS): its pin when set, else its address geocoded. Answer
  `{ km, from: {label, precise}, to: {label, precise}, approximate }`; km
  rounded UP to 0.1. Fixed sentences on every failure (both ends needed, job
  not found, no site address, start/end not found, no road route, service
  unavailable — 502). Helpers `lib/distance.ts` (tested with mocked fetch in
  `tests/unit/distance.test.ts`, which also covers the route, auth, limiter
  and sentences; phone call `mobile/lib/distanceLookup.ts`, tested).
- **Places:** Nominatim (`lib/geocode.ts`'s User-Agent, Australia only,
  `limit=1`). Unlike the geofence rule (building-level only), the best match
  is accepted and its precision reported: a house/building or a named place
  (a quarry, a tip) is precise; a street, suburb or bigger area is
  approximate (`isPreciseForDistance`). Calls spaced 1.1 s apart (its 1/s
  policy).
- **Road distance:** OSRM's public demo server
  (`router.project-osrm.org/route/v1/driving/…?overview=false`), one request
  per lookup, 8 s timeout. Identical places and point pairs are answered from
  a per-process LRU (300 entries, 24 h). **The demo server is fair-use only**
  (light traffic, no guarantee, may throttle or go away); if volume grows,
  a self-hosted OSRM or a paid routing service is the upgrade path — only
  `osrmRouteMeters` in `lib/distance.ts` changes.
- **Not verified against the live services** — neither OSRM nor Nominatim
  could be reached from where this was written; tests mock them. Reaches
  phones with the next build (no native module); the web must be deployed
  first (the route).

**Office/admin Time, Approvals and Staff on the phone (19 Nov 2026; no migration, no stream change).**
Justin: bring the office's website tools for time, approvals and staff to the
phone. Office/admin only throughout; technicians see exactly what they saw.
- **Time tab** (`mobile/components/job/time.tsx`, role from `useRole` — no
  change to `app/job/[id].tsx`): office/admin can open and correct **anyone's**
  entry and **log time for another person** (staff picker + Work/Travel; RLS
  0030 already allowed it; the web dialog still offers the picker to admins
  only). `edited_by` is the office user, `staff_id` the technician
  (`TimeEntriesRepository.addManual` `editorId`, `editEntry` `staffId`),
  through the outbox as before. **Billing rate** chips (Normal / 1.5× / 2× /
  Auto) are **admin only** — the 0025 trigger reverts anyone else's
  `rate_override`. Nobody can read that column (0045), so editing opens on
  "Leave as it is" and sends nothing unless the admin picks one
  (`mobile/lib/timeEntryOffice.ts`, tested) — the web dialog opens on "Auto"
  and silently clears an existing override; that web gap is unchanged. Each
  entry shows **"In: on site / Out: 320 m from site"**, amber ⚠ outside the
  fence allowing for accuracy — `mobile/lib/clockLocation.ts`, a byte copy of
  `lib/clock-location.ts` pinned by `tests/unit/clock-location-mirror.test.ts`.
  The site pin and staff list are read online (offline: no picker, no flag).
  Technician reads are unchanged: `TIME_ENTRY_COLUMNS` still excludes
  `rate_override`; `tech_time_entries` untouched.
- **Approvals** (`mobile/app/(office)/approvals.tsx`): each job shows "Xh to
  invoice" and, expanded, the hours table by cost centre × technician from the
  new **`GET /api/approvals/hours?jobIds=…`** (office/admin, caller's client
  under RLS, hours only — `approvalHoursByJob` in `lib/invoice-hours.ts`, which
  the web page now uses too; `tests/unit/approval-hours-route.test.ts`). After
  an approval that leaves hours unpriced, "Apply hourly rate" opens
  `mobile/components/approvals/apply-hourly-rate-sheet.tsx` — the existing
  `GET/POST /api/invoices/[id]/hours` with Bearer (one rate / per technician /
  per cost centre, server defaults, the 409 "already in Xero / emailed"
  confirmation; rules `mobile/lib/approvalHours.ts`, tested). **Variations to
  invoice** (approved, not invoiced, by job, QA fixture left out) with Create
  invoice → `/invoices/new?jobId=` or Open invoice #n; amounts via
  `MoneyText` in `RoleGate` (`mobile/lib/unbilledVariations.ts`, tested).
- **Staff** (`mobile/app/staff.tsx`, admin route group): **+ Invite**, **Resend
  invite**, edit **Name / Login email** (→ `/api/staff/update`, which also moves
  the Supabase Auth login; called only when they changed, before the rest is
  saved), and the **Auto clock on/off** switch (`/api/staff/set-auto-clock`,
  saved at once, shows the by-role default). Calls in `mobile/lib/staffAdmin.ts`
  via the shared Bearer helper `mobile/lib/officeApi.ts` (tested). **Leave Log**
  gains **Long service** and part-day **From/To** (HH:MM, `validateLeaveTimes`;
  sent only when both given; a database without 0112's columns is told so).
- **Staff routes hardened** (they now serve the phone too): `invite`,
  `resend-invite`, `update` answer fixed sentences (GoTrue/DB text to the log
  only — the `app/api/staff/` skip in `no-raw-error-responses.test.ts` is
  gone), validate email and role, store the email lowercase on edit as on
  invite, link invites to `appUrl()` instead of the request Host, and the
  invite **upserts** the profile: `handle_new_user()` (0044) has already made
  the row, so the old plain insert collided and reported a failed invite for
  one that had been sent. Shared rules `lib/staff-invite.ts`.
- Reaches phones with the next build (no new native module). The web must be
  deployed first for `/api/approvals/hours`; without it the phone's hours panel
  says it couldn't load the hours and approving still works.

**Small office/admin website features on the phone (19 Nov 2026; no migration, no stream change).**
Justin: the bits of the website the office still had to open a laptop for.
All office/admin only (office route group + `RoleGate`; the server or RLS
decides), money only through `MoneyText`. Reach phones with the next build
(no new native module).
- **Delete a job (admin).** Phone: job screen → status badge (Update job) →
  **Delete job** (`RoleGate` admin), the web dialog's wording, then the Jobs
  tab. The web dialog (`components/job/delete-job-dialog.tsx`) used to delete
  from the browser client; both now call **`DELETE /api/jobs/[id]`**
  (`requireAdmin`, then the CALLER's client — never the service role — so
  0049's "only office/admin may delete a job" still stands behind it). A
  linked quote or invoice (23503) answers 409 with the dialog's sentence;
  anything else a fixed sentence (`tests/unit/job-delete-route.test.ts`).
  Online only on the phone (`mobile/lib/officeActions.ts` `deleteJob`): a
  refusal must be seen at once, not dead-letter in the outbox. Until the
  office mirror syncs the delete, the Jobs list may still show the job.
- **Delete (deactivate) a backflow device.** Device screen → **Delete device**
  (`RoleGate` office/admin), the web's confirm text; `is_active = false`
  through the outbox (`BackflowRepository.deactivateDevice`), so it works
  offline. History is kept, as on the web.
- **Dashboard tiles** (`mobile/app/(office)/dashboard.tsx`, rules
  `mobile/lib/dashboardLooseEnds.ts`, tested): **Needs a look from
  yesterday** — open jobs booked yesterday (Melbourne) and not today, and open
  work clocks from before today (`listOpenWorkClocks` in
  `reads/dashboard.ts`, local-first for office/admin; filtered by instant in
  JS, never by comparing timestamp text) — and **Variations to Invoice**
  (count + `MoneyText` total via `StatCard`'s new `detail`, QA fixture left
  out, from `listReadyToInvoice`; taps through to Invoices, whose "Ready to
  invoice" lists them).
- **Set a site's map pin from the office.** Customer → each active site →
  **Set pin / Pin** (`mobile/components/customer/site-pin-button.tsx`). The
  binary has no map module (no react-native-maps — none added), so: **Look up
  the address** (`/api/geocode`, house/building matches only, the web's
  `siteAddress()` copied into `officeActions.ts`), **Where I am now** (a fix
  within ±50 m, as the crew's "Set site location here"), and **View on map**
  for a pinned site (opens the maps app). Each asks before saving; the two
  coordinates go through the outbox (`CustomersRepository.setSitePin`; sites
  are office-writable, 0064). Dragging a pin on a map stays a website job.
  `getCustomer` now returns `site_lat`/`site_lng` on each site.
- **Copy a booking to another technician / day** — the web board's
  Shift-drop. Schedule tab → tap a booking (Day, Week or List) → **Copy to
  another technician or day** → pick the technician and the start day (the
  tapped day or today onward, 14 days). Planned by the mirrored
  `planBoardAdd` (`mobile/lib/bookingCopy.ts`, tested): same hours, shape,
  cost centre and note; on another day it starts there. Same guards as a move:
  refused on a closed job (0096) or a stand-in row; a duplicate (same tech,
  window and cost centre) is refused; a clash or the technician's leave (0112)
  asks "Book anyway". Written by `ScheduleRepository.addBookings` (its window
  type widened to allow a start-only block) through the outbox, with the same
  "Saving / Not on the server yet / Saved" notices as a drag.
- **Loads on equipment usage** (job → Billing → Equipment usage; 0091): a
  "Loads carted" field; hours may be 0 when loads > 0, one must be > 0
  (`parseUsageAmounts`). `getJobEquipment` returns `loads` and prices each
  entry as the web Equipment tab does: hours × cost/hour + loads × cost per
  load + days × day rate. Still not on the phone: the entry's cost centre
  (the Time tab's "Truck & plant" has it), and the admin Costing screen
  (`reads/jobCosting.ts`) still prices usage without loads.
- **"Open leave record"** on a leave block (Schedule tab, admin only, and
  only when `schedule_leave()` returned the record's id): opens Staff with
  `?staff=<id>`, which opens that person's editor where the phone's Leave log
  is. Office users still get the read-only alert.

**Technicians start work on a job themselves; the right cost centre on every clock-on (25 Nov 2026; migration `0118` applied 2026-11-25; no stream change).**
Justin: "technicians in the area … pop in and see a job needs something done.
We need them to be able to search the job, clock onto it, but … it [must]
show up in schedule rather than it being very office heavy." And: "It is also
critical that they clock on to the correct cost centre." His decisions: the
booking runs from clock-on to clock-off; any open job; they pick the stage; the
office sees an "Added by technician" tag on both schedules (no push).
- **Phone — "Start work on this job"** (`mobile/components/job/start-work.tsx`,
  on the Overview of a VIEW-ONLY open job, i.e. one they found by Search and
  aren't on; technicians only). Online only ("Starting work needs signal").
  It loads the job's stages from `GET /api/jobs/[id]/self-start` (ids, names,
  company cost centre, completion — never money) and shows the OPEN ones:
  exactly one open → preselected but still shown; several → nothing
  preselected, they must tap one; none → "This job has no open cost centre to
  clock on to. Ask the office to add one before you start." and no button.
  Confirm: "Clock on to #123 — Stage 2 (Drainage)?". Then `POST
  /api/jobs/[id]/self-start` with the phone's booking id and clock-on entry
  id (both kept for a retry), then the ordinary outbox clock-on
  (`TimeEntriesRepository.clockIn` now takes an optional `id`) with that
  entry id and the same cost centre. The screen switches to the full tabs and
  the Time tab at once (crew + booking set locally; the job reaches the
  phone's mirror with the next sync). Rules `lib/self-start-booking.ts`
  (stage list, preselect, label, the tag and running-end rules), mirrored at
  `mobile/lib/selfStartBooking.ts` (byte for byte from the imports,
  `tests/unit/self-start-booking.test.ts`); calls `mobile/lib/startWork.ts`.
  **Not on the web job page** — phone first; the route works for any caller
  with a Bearer token or cookie, so a web button is a UI-only follow-up.
- **The route** (`app/api/jobs/[id]/self-start/route.ts`, sentences in
  `lib/self-start.ts`): POST is `requireRole(["technician"])`, refuses a
  limited-access account (0110), an unknown job, a closed job with 0096's own
  sentence, a job with no open stage, and a cost centre that isn't one of
  THIS job's open lines — then calls `self_start_job_booking()` through
  `callerClient` (as the CALLER; never the service role for the write).
  Service role only for reads after the guard: the job's status/number and
  the stages via `listJobStages` (names + completion, field by field). Errors
  are fixed sentences (`42883`/`PGRST202` → "isn't switched on yet").
  `tests/unit/self-start-route.test.ts` walks both answers for money keys and
  the PO line's amount.
- **Migration `0118_self_start_bookings.sql` (DRAFT):**
  - `job_bookings.clock_entry_id uuid` (unique when set, no FK — the booking
    is made before the queued clock-on reaches the server): the time entry a
    self-started booking follows.
  - `self_start_job_booking(booking, job, cost centre, entry)` — SECURITY
    DEFINER, `authenticated` may execute, anon not. It re-checks everything:
    active TECHNICIAN, not limited-access; job exists and is open (MJ001,
    0096's words); the cost centre is a PO line of that job (MJ114) and not
    completed (MJ115); idempotent on the booking id (MJ112 if the id is
    someone else's). Inserts the caller's booking: today from now (to the
    minute), no end, `created_by = staff_id = auth.uid()`. 0079 then puts
    them on the crew (so RLS 0074 lets their clock-on in). On a job with no
    lead, 0059 makes them the lead, which 0074's
    `enforce_job_assignment_office_only` refuses for a technician — so that
    one insert runs with the role claim set to `service_role` (sub unchanged,
    so 0077 still doesn't push them their own assignment) and the claim is
    put back. job_bookings RLS is unchanged (office/admin writes).
  - Trigger `time_entries_follow_booking` (after insert/update of clock_in,
    clock_out, staff_id): the linked booking's start = clock_in, end =
    clock_out. So EVERY clock-off path ends it — the phone button, a queued
    offline clock-off, the web Time tab, an office correction, the geofence,
    a clock prompt — with no client code. Written as a follow-on
    (`app.booking_sync = 'on'`), so 0096 doesn't refuse it when the job was
    signed off before the clock-off. An entry re-attributed to someone else
    stops steering the booking. Deleting the entry leaves the booking.
  - `po_cost_centers_public` re-created with `completed_at` appended (no
    money; 0110's limited-account filter kept), so phones can skip completed
    stages in batch.
  - End state asserted (column, trigger, SECURITY DEFINER + grants, every
    job_bookings write policy still office/admin, the view's exact columns,
    its filter, no money-named column).
- **The schedule.** The booking shows at once on the web board and the
  phone's office Schedule tab with an **"Added by technician"** tag (web:
  `components/schedule/added-by-technician-tag.tsx`, one element in each of
  the board's two card variants in `team-schedule-view.tsx`, right under
  the booking note line; phone: in the block's title line in
  `mobile/components/schedule/ScheduleGrid.tsx`). Rule
  `isAddedByTechnician`: `created_by === staff_id` and the creator's role is
  technician (from the staff list both boards already read; the board embed
  and the phone's two office booking reads now select `created_by`, which
  exists since 0079 — no new fallback). While they are still clocked on
  (`ends_at` null) the boards draw it **running**: to now, at least to 15:30
  of its day, never past its day (a forgotten clock-off doesn't paint the
  week), at least 30 min — tagged "· on now" (`withRunningEnds`, nothing
  written). An office drag of a running booking writes the drawn end, and
  the clock-off then overwrites the window with the real times. No calendar
  event is pushed for a self-started booking (its end isn't known yet); the
  next calendar sync of the job adds one.
- **The right cost centre on every clock-on (item 3).** Rules in
  `mobile/lib/bookings.ts`, tested:
  - `clockInCostCentre(bookings, at, jobLevel, completedIds?)` — the
    automatic paths (geofence arrival `arrivalCostCentre`, the clock prompts'
    `promptCostCentre`) keep their rule (own booking covering now, else the
    nearest that day, else the job-level stage) but a booking on a completed
    stage is passed over and a completed job-level stage gives null. The
    completed ids come from `po_cost_centers_public.completed_at`
    (`mobile/lib/data/reads/clockStages.ts withCompletedStages`, online,
    best-effort) attached to the geofence's sites (`location-tracking.tsx`,
    also handed to the background task) and the prompt candidates
    (`clockPromptContext.ts`). Before 0118, offline or on a failed read:
    unknown, exactly as before.
  - `manualClockOnCostCentre` — the Time tab's Clock on and the Today card's
    (`components/job/clock-on-stage-picker.tsx useClockOnCostCentre`): their
    booking's open stage, else the office's job-level stage if open, else the
    only open stage, else — two or more open — a sheet **"Which cost centre
    are you working on?"** listing the open ones, nothing preselected, Clock
    on disabled until one is tapped; Cancel clocks nothing. Stages from `GET
    /api/jobs/[id]/stages` (crew/office, names + completion; refreshed at
    the tap, at most 4 s wait). Offline / unknown → the old rule. Completed
    stages are never chosen or offered.
  - **Not changed:** the per-entry stage picker on the Time tab (re-tagging an
    existing entry still lists every line), backdated "Add entry", the web
    job page's own Clock in (`components/job/job-time.tsx`, still the
    job-level stage) — follow-ups if wanted.
- **Before 0118 is applied nothing breaks:** the Start-work POST answers
  "Starting work on a job isn't switched on yet — ask the office to book you
  on." (409) and nothing is written; the GET (stage list) works; the boards'
  tag reads only `created_by`; the completed-stage batch read answers
  "unknown"; the manual clock-on picker already works (it uses the stages
  route).
- **Checked** on a scratch Postgres 16 with the full chain 0000–0117 and CI's
  seed: 0118 applies twice cleanly; `supabase/tests/0118_self_start_bookings_test.sql`
  passes (27 scenarios: direct insert blocked, completed stage / another
  job's line / no line / closed job refused, the booking is the caller's own
  with no end and linked, crew joined, retry idempotent, clock-on sets the
  start, clock-off the end, a clock-off after sign-off still saves and ends
  the booking, technicians see completion through the view, office and a
  limited account refused) and fails naming scenarios with the trigger
  dropped (3) or the completed-stage check removed (6). Not tried against
  PostgREST or on a device.
- **Apply / deploy order:** paste `0118_self_start_bookings.sql` → paste
  `supabase/tests/0118_self_start_bookings_test.sql` (needs an active
  technician and office/admin), trust only `0118 PASSED` → mark 0118's
  STATUS line applied, add the ledger row (`('0118','self_start_bookings')`),
  regenerate types (`lib/database.types.ts` has `clock_entry_id` and the
  view's `completed_at` by hand) → deploy the web (the route) → ship the
  phone build (no native module; `mobile/lib/powersync/schema.ts` has
  `clock_entry_id` by hand for `office_job_bookings`' `job_bookings.*`).
  **No PowerSync redeploy** — `tech_job_bookings` lists its columns and
  needs none of the new ones.

**An invoiced PO stops offering "Invoice this PO" (25 Nov 2026; no migration, no stream change).**
Emma: the sewer PO for Lot 827 Ribbonwood (Luxton Homes) was invoiced and
pushed to Xero, yet the job's PO tab still offered it to invoice. Rule
`poInvoiceState` in `lib/po-invoice.ts` (mirrored at `mobile/lib/poInvoice.ts`,
tested in `tests/unit/po-invoice.test.ts`): an invoice is against a PO when its
`customer_po` is the PO's number (trimmed, any case) — "Invoice this PO" and
the New Invoice picker both set it; cancelled invoices don't count; subtotals
(ex GST) add up against the PO's value → `none` / `part` (progress claims so
far) / `full`.
- **Web PO tab** (`components/job/job-po.tsx`, reads the job's invoices as the
  caller): a fully invoiced PO shows a green "Invoiced #n" (linking to the
  invoice) instead of the button; part-invoiced shows "Invoiced $x of $y" and
  "Invoice next claim".
- **New Invoice** (`app/dashboard/invoices/new/page.tsx`): the PO picker marks
  "(invoiced)" / "(part invoiced)"; picking a fully invoiced PO says in red it
  is already invoiced and that saving makes a second invoice (not blocked —
  a re-issue after a cancelled one in Xero still works).
- **Phone POs tab** (office/admin): `GET /api/jobs/[id]/purchase-orders` adds
  `poInvoiced` (per PO: status, amount, invoice numbers — office-only route);
  a fully invoiced PO shows "Invoiced #n" instead of the button, a part one
  "Invoiced so far $x" (MoneyText) and "Invoice next claim". Next build.
- **Not caught:** an invoice raised without the PO number in Customer PO
  (typed by hand on New Invoice with no PO picked) — it can't be tied to a PO.

**Cost of mistakes, stages 1–4 (25 Nov 2026; migration `0119` applied 2026-11-25; no stream change).**
Justin: record every mistake — rework, wrong materials, damage, callbacks,
mis-quotes, missed inspections — against a job and cost centre with its true
cost, so he sees where money leaks and why. **Don't double-enter cost**: a
mistake is a tag plus LINKS over costs the CRM already holds, plus a manual
line only where no record exists. His decisions: crew raise, office costs; no
Rework cost centre (tag only); callbacks are a mistake on the original job
(closed jobs included); stages 1–4 only (no pattern flags).
- **Migration `0119_mistake_tracking.sql`** evolves 0115's `job_mistakes`
  (0115 untouched): `job_id` nullable (a mistake with no job — truck/plant
  overhead — then needs `cost_centre_id`, the COMPANY cost centre; on a job it
  is derived from the PO line by the guard), `category_id`
  (`mistake_categories`, editable, 10 seeded), `cause_code` (fixed list:
  quoting, ordering, supplier, install, communication_handover,
  plans_builder_change, site_conditions, other; the old free-text `cause`
  stays as cause notes), `raised_by/raised_at`, `status` open → costed →
  closed (`closed_at`), `supplier_id`, and the recovery columns
  (`recovery_source` supplier_credit/builder_recharge/insurance/other,
  `recovery_claimed_ex_gst`, `recovered_ex_gst`, `recovery_claimed_on`,
  `recovery_note`). New tables: `mistake_cost_lines` (office/admin; a LINK to
  a time_entry / job_expense / vendor_order / equipment_usage / hire_entry —
  no amount stored, a record links to at most one mistake, the guard checks
  it is on the mistake's own job, deleting the record deletes the link — or
  MANUAL: amount ex GST, optional hours), `mistake_photos` (job-photos bucket
  `<job>/mistakes/<id>/…`; office/admin RLS), `mistake_responsibility`
  (whose mistake — **ADMIN ONLY**, not office; 0115's `staff_id` moved here
  and is always null from now on: a trigger moves an admin's write and drops
  anyone else's). `job_mistakes` keeps 0115's single office/admin FOR ALL
  policy, so **technicians read nothing** in any mistake table but the
  categories. **`amount_ex_gst` is deprecated**: each 0115 amount became one
  `legacy` manual line, and triggers keep the two in step both ways, so the
  web build from before 0119 still reads/writes correct totals in the gap.
- **The crew's door:** `raise_job_mistake()` (SECURITY DEFINER; caller active
  and `user_can_manage_job`, or office; category active; stage on that job;
  date not in the future; their OWN work time entries on that job become
  linked labour lines; idempotent on the client id; returns only the id),
  `my_job_mistakes()` (what the caller raised, money-free columns),
  `add_job_mistake_photo()` (raiser or office; path must be the mistake's).
  Errors MJ120–MJ134 → fixed sentences (`lib/mistake-raise.ts`).
- **Routes:** `GET/POST /api/jobs/[id]/mistakes` (`requireOnJob`; categories,
  stage names via `listJobStages`, the caller's own work entries, their
  mistakes; POST runs the function as the CALLER) and `POST
  …/mistakes/[mistakeId]/photos` (base64 ≤ 3 MB, sniffed, uploaded to
  job-photos as the caller, then filed; the file is removed if refused).
  `tests/unit/mistakes-routes.test.ts` walks both answers for money keys and
  amount values.
- **Costing** (`lib/mistake-costs.ts`, pure): a link is costed from its source
  every time, the ledger's way — time entry hours (or the line's partial
  hours, capped) × loaded rate (payroll — **admin only**; office sees hours,
  "admin sees cost", counted $0), expense amount, supplier PO amount
  (unpriced flagged, cancelled $0), equipment usage `usageCost`, Day Works
  line at today's hire rates (hire isn't in the Job Ledger yet, so this only
  shows in the mistake's own cost). Net = lines − recovery received. Reads in
  `lib/mistakes-data.ts` (three modes: missing / legacy 0115 / tracking).
- **Ledger fixed** (`lib/job-ledger.ts`): mistakes are now a SUBSET — the row's
  `mistakes` = linked + manual; only `mistakesAdded` = manual − recovered
  goes into `cost`. Costing tab's Job Ledger and Reports → Job margins use it.
- **Web:** crew (technicians on a job they're on) — a **Mistakes** card on the
  Overview with **Log mistake** (`components/job/crew-mistakes.tsx`,
  `log-mistake-dialog.tsx`: category, stage, cause, date, description, photos,
  own time as rework; no money). Office — the PO tab card
  (`components/job/job-mistakes.tsx` → `components/mistakes/mistakes-panel.tsx`):
  each mistake's details, photos, cost lines, **Link existing cost**
  (`link-cost-dialog.tsx`, anything on the job not yet linked; partial hours
  for time), manual cost, money back, whose (admin), status. Before 0119 it
  falls back to the old 0115 card (`job-mistakes-0115.tsx`, unchanged). A
  **"part of a mistake?"** ⚠ button (`link-to-mistake-button.tsx`) on each
  finished work entry (Time tab), each expense and each supplier PO (office):
  link to a mistake on the job or a new one; unlink. Equipment usage and Day
  Works lines are linked from the mistake's own picker. **Settings → Mistake
  categories.** **Approvals** shows "N mistakes to review" linking to the report.
- **Reports → Mistakes** (office/admin): the month × company cost centre table
  now on each mistake's cost (jobless ones under their own centre), by
  category, cause, supplier (claimed vs received), by job (net as % of the
  builder PO value), **by person (admin only)**, open items (net > 0, nothing
  claimed), the month list with status/net, "Log a mistake with no job", and
  the **review** of every mistake not closed. Sums in `lib/mistakes-report.ts`.
- **Monday email:** "Mistakes: N logged this week, N not closed, $X claimed
  back and not yet received" (`lib/mistakes-digest.ts`; a failure never stops
  the email; left out before 0119).
- **Phone:** a **Mistakes** tab on the job (on the job or office; never
  view-only), online only — `mobile/components/job/mistakes.tsx`, calls
  `mobile/lib/mistakes.ts`; photos from camera/library via `prepareImage`.
  Rules mirrored: `mobile/lib/mistakeRaise.ts` = `lib/mistake-raise.ts` from
  the first export (`tests/unit/mistake-tracking.test.ts`). No money on the
  phone (costing is on the web). Next build; no native module; the web first.
- **Checked** on a scratch Postgres 16 (full chain 0000–0118 + CI seed): 0119
  applies three times cleanly; `supabase/tests/0119_mistake_tracking_test.sql`
  passes (44 scenarios) and fails naming scenarios with a permissive SELECT
  policy on `job_mistakes`, with whose-mistake opened to office, and with the
  cost-line guard disabled plus a readable `mistake_cost_lines`; the money
  sweep stays intact with the seeded cost line and recovery. Not tried against
  PostgREST, in a browser or on a device.
- **Not done / to know:** supplier credits aren't matched to Xero credit notes;
  a linked supplier PO / expense is the WHOLE record (a part of it → unlink and
  add a manual line, which then counts as new cost); hire lines in a mistake
  aren't in the Job Ledger (as hire isn't); job-less mistakes have no photos.
- **Stage 5 — pattern flags (27 Nov 2026; no migration, no stream change; web
  only, office/admin).** Justin: see where money KEEPS leaking. Worked out
  every time from the mistakes the report already loads — nothing stored.
  Rules `lib/mistake-patterns.ts` (pure, `tests/unit/mistake-patterns.test.ts`),
  thresholds as constants at its top (no settings UI): the same `cause_code`
  3+ times in the last 90 days (overall, and within one company cost centre —
  the centre flag is left out when it is the whole overall flag again); the
  same category 3+; the same supplier 2+ (with claimed / received); the same
  builder (the job's customer) 3+; the same site 2+ **ever** (callbacks);
  **admin only**, the same person (`mistake_responsibility`) 2+ in 90 days —
  the reader only reads that table for an admin and `patternsForViewer` drops
  it for anyone else; and a company cost centre whose mistakes on OPEN jobs
  (not cancelled, not completed-and-approved — the Job margins rule) net more
  than 5% of its builder PO value (sum of `po_cost_centers.allocated_amount`)
  across every open job. Each flag: what, how many, cost / claimed /
  received / net so far, and its mistakes newest first. Reads in
  `lib/mistake-patterns-data.ts` (as the caller; chunked `.in()`, open jobs
  paged). **Reports → Mistakes** shows a **Patterns** panel at the top, worst
  first (net, then count), each opening its mistakes with job links; the page
  now reads ALL mistakes, not just 12 months (the month table and breakdowns
  still use 12 months), so "same site, ever" sees old callbacks; a pattern
  failure shows a sentence and the rest of the report still loads. **Monday
  email**: "N patterns to look at" with the top 3 under the Mistakes line
  (`lib/mistakes-digest.ts` `loadPatternsForDigest`, service role, labour
  costed without payroll rates as office sees it, never the person flag; a
  failure leaves the patterns out and never stops the email; left out before
  0119). Not checked in a browser.
- **Apply / deploy order:** paste `0119_mistake_tracking.sql` → paste
  `supabase/tests/0119_mistake_tracking_test.sql` (needs an active technician
  and an active admin; office-only checks need an office user), trust only
  `0119 PASSED` → change 0119's STATUS line to applied, add the ledger row,
  regenerate types (`lib/database.types.ts` has the tables/columns by hand) →
  deploy the web → ship the phone build. **No PowerSync redeploy.** Before it
  is applied: the PO tab shows the 0115 card, the crew card hides, Log mistake
  says it isn't switched on, the report and ledgers use 0115's amounts.

**Reports → Time log (27 Nov 2026; no migration, no stream change; web only).**
Office: "Time log – have what time log was for what job type (e.g. Brodie –
Sewer), date, hours on site. Need all details." `app/dashboard/reports/time-log`
(office/admin — technicians get "for the office", as the other office
reports), linked from the Reports header. One row per time entry whose
clock-on falls in the range (Melbourne days): date, staff, job # + title
(link), site street/suburb, cost centre / stage (`po_cost_centers` **id, name
only**), variation name when `variation_id` is set (0120 draft — read with it,
retried without on 42703/PGRST204), work/travel, clock on / off ("still on",
hours live to now), hours, on/off-site flag for clock-on and clock-off
(`lib/clock-location.ts` against the site pin and fence; blank with no fix, no
pin, or travel), auto/manual, edited by, notes. Filters in the query string:
`from`/`to` (default this week Mon–Sun), `staff`, `job` (number), `type`.
Totals per staff member (work/travel split) and per cost centre (travel and
each variation on their own line). **Download CSV** of the filtered rows
(built on the server, saved in the browser). **Hours only** — `time_entries`
is read through its column grants with a named list (never `rate_override`),
as the caller (RLS), paged with `fetchAllRows`, lookups `.in()` in chunks of
100. Rules `lib/time-log-report.ts`, tested in
`tests/unit/time-log-report.test.ts` (incl. no money-named key or CSV column).

**Time against variations (25 Nov 2026; migration `0120` applied 2026-11-27, gate test passed; PowerSync streams redeployed 2026-11-27).**
Justin: a stage's allowed hours (sewer and stormwater, 16 h) blow out when the
crew hit rock. That extra time must go against a VARIATION, so the variation
can be costed and the stage's allowed hours stay a fair measure. His
decisions: (1) charging is mixed and the office decides each one — an hourly
variation (its unit is an hour unit, or the office ticks "Charged by the
hour") takes its quantity from the hours logged to it, others are per m³ or an
agreed price; pricing and approval stay office-only (0028); (2) the crew tag
the time on site, the office checks; (3) variation time does NOT count toward
the stage's allowed hours.
- **Migration `0120_variation_time.sql`:**
  - `time_entries.variation_id uuid` → `job_variations(id) on delete set null`,
    partial index, **granted explicitly** (`grant select (variation_id)` —
    column-level grants, 0045/0092). Not money; in the technicians' stream.
  - `time_entries_variation_guard` (BEFORE INSERT/UPDATE OF variation_id,
    job_id, entry_type; SECURITY DEFINER — the crew can't read
    job_variations): the variation must be on the SAME job; travel can't be
    tagged; tagging onto a REJECTED variation is refused (check_violation with
    sentences mapped by `variationTimeRefusal`). Who may edit which entry is
    the existing RLS: own entries for a technician, anyone's for office/admin
    (0030); billed entries stay office-only (0098).
  - `job_variations.is_hourly boolean` (null = by the unit). A trigger ignores
    anyone but office/admin setting it (null on a technician's insert, kept on
    update). The office stream is `job_variations.*`; `is_hourly` added to
    `mobile/lib/powersync/schema.ts` by hand; the tech stream and
    `job_variations_public` are unchanged.
  - **Link design — `variation_cost_links`** (modelled on 0119's
    `mistake_cost_lines`, links only): `variation_id` (cascade), `source`
    (`job_expense` / `vendor_order` / `equipment_usage`), `source_id`,
    `created_by` (forced), unique `(source, source_id)` (a cost belongs to at
    most one variation), guard: the record is on the variation's job and the
    variation isn't rejected; deleting the record deletes its link. **No
    amount stored** — costed from the source the way the ledger costs it, so
    it can't drift. One FOR ALL office/admin policy (policies dropped by
    enumeration first), granted to authenticated + service_role, revoked from
    anon, not in the powersync publication — all asserted. No money column.
  - **Closes an open time-entries rule (found 26 Nov 2026 by this gate test
    on production).** Production's `time_entries` had an out-of-band policy
    "Authenticated users can manage time entries" (FOR ALL, `auth.role() =
    'authenticated'`) instead of the baseline's own-rows policy — any
    technician could edit, move or delete anyone's time. 0120 drops every
    PERMISSIVE policy on the table by enumeration and creates: read own, or
    any entry on a job you can manage (`user_can_manage_job` — the
    `tech_time_entries` stream's scope), office/admin everything; insert /
    update / delete own only; office/admin all (0030). Asserted (exactly 5
    permissive policies, no open write, no `auth.role()` policy). Technicians
    no longer read time on jobs they aren't on.
  - `job_variations_after_reject`: when the office REJECTS a variation its
    time goes back to the stage (`variation_id` cleared) and its links are
    removed, so the ledger, over-hours and the scoreboards agree.
  - **Checked** on a scratch Postgres 16 (full chain 0000–0119 + CI seed,
    `/var/tmp/pg120`): 0120 applies twice cleanly; the gate test
    `supabase/tests/0120_variation_time_test.sql` passes (23 scenarios) and
    fails naming scenarios with the guard trigger disabled (3), with a
    permissive SELECT policy on the link table (1), and with the reject
    trigger disabled (2); the money sweep stays intact. Not tried against
    PostgREST, in a browser or on a device.
- **Rules** `lib/variation-time.ts` (hours and names only — the phone runs
  them), mirrored byte for byte from the first export at
  `mobile/lib/variationTime.ts` (`tests/unit/variation-time-mirror.test.ts`,
  which also forbids money words): `isHourlyVariation`, `openVariations` (not
  rejected), `hoursByVariation`, `hourlyQuantity`, `planClockSwitch` (same
  instant, never at/before the entry's start), `variationTimeRefusal`,
  `isMissingVariationColumn`. Tests `tests/unit/variation-time.test.ts`.
- **Allowed hours leave variation time out:** `lib/over-hours.ts`
  (`entryUsedHours`, mirrored), its readers (`lib/over-hours-data.ts`,
  `mobile/lib/data/reads/overHours.ts` — read `variation_id`, fall back
  without it), the hours scoreboard (`lib/hours-scoreboard.ts`, the phone's
  `reads/hoursScoreboard.ts` — local SQL `variation_id IS NULL`, remote with a
  fallback), the PO tab's hours per stage and its job total
  (`job-po.tsx`, `job-detail-client.tsx`). **Hours to invoice**
  (`lib/invoice-hours.ts loadJobHours`, approvals and "Apply hourly rate")
  also leave it out — it is billed through its variation, so billing it as
  hours too would charge it twice.
- **Ledger** (`lib/job-ledger.ts`): each variation (not rejected) gets its own
  row (`variationRowKey`, after the cost centres, before travel): budget =
  its price — approved / auto-approved only, `total_amount`, else rate ×
  quantity (`variationRevenue`; pending = cost with "Not priced yet");
  cost = its tagged time (hours × loaded rate, as labour) + its LINKED
  expenses / supplier POs / plant. **Each record is costed once**: tagged
  time and linked costs go to the variation row INSTEAD of their stage line.
  The job's price (`budget`) = builder's POs + approved variations
  (`variationRevenue`); `unsplit` still compares the builder's PO value with
  its split only; `variationCost` is the variation rows' cost. Anything tagged
  to a rejected or unknown variation stays on its stage. `costCentreTotals`
  folds every job's variation rows into one "Variations" row. Mistakes are
  unchanged (still by the mistake's PO line). Tests in
  `tests/unit/job-ledger.test.ts`. Shown in the Costing tab's Job Ledger
  (admin; reads the links itself, `lib/variation-links.ts`) and Reports → Job
  margins (admin; reads time with `variation_id`, the variations and the
  links).
- **Web Time tab** (`components/job/job-time.tsx`): each work entry gets a
  "Stage work / Variation: …" picker (own entries; office/admin any) and an
  amber "Variation time · not counted in the stage's allowed hours" line. The
  job page reads time with `variation_id` (`withVariationFallback`,
  `TIME_ENTRY_SELECT_WITH_STAFF_AND_VARIATION` in `lib/time-entry-columns.ts`,
  mirrored on the phone; the plain list stays the fallback — the optional
  column is pinned by `tests/unit/time-entry-columns.test.ts`). The web's own
  Clock In picks a variation since 27 Nov 2026 (below).
- **Web Variations tab, office** (`components/job/job-variations.tsx`): every
  card shows "6.5 h logged (1 still clocked on)"; "Charged by the hour"
  tick box (`is_hourly`); an hourly pending variation's approval form shows
  **Hours** prefilled from the logged hours (editable) and "Rate ($/h)"; an
  approved hourly one not yet invoiced offers "Set quantity to N h logged"
  (re-prices at its rate); rejecting one with time asks first ("moves that
  time back to the stage"); **Costs linked to this variation**
  (`components/job/variation-costs.tsx`): link the job's plant, expenses and
  supplier POs (each only once), unlink. Before 0120 the hours line, tick box
  and links hide.
- **Phone** (reaches phones with the next build; no native module):
  - **Clock-on picker** (`mobile/components/job/clock-on-stage-picker.tsx`,
    now `useClockOnTarget`, used by the Time tab and the Today card): besides
    the stage rule (`manualClockOnCostCentre`, unchanged) it lists the job's
    open variations (`mobile/lib/data/reads/clockVariations.ts` — the
    money-free technician projection, local-first, so offline too) and
    "+ New variation (e.g. hit rock)": a name, details and a camera photo,
    logged exactly like the Variations tab's custom one (no rate, no amount,
    office prices it). The sheet shows when it must ask for the stage, when
    the job has open variations, or from "Clock on to a variation…".
  - **Switch** while clocked on: "Switch to a variation (e.g. hit rock)" /
    "Switch variation / back to the stage" — `useTimeClock.switchClock` →
    `TimeEntriesRepository.switchClock`: clock-off then clock-on at the same
    instant, the clock-on `dependsOn` the clock-off (0090's one open entry per
    job). A NEW variation is three chained ops: clock-off → the variation's
    insert (waits for it) → clock-on (waits for the insert — its foreign
    key). All outbox, so offline works.
  - **Time tab**: each work entry has a "Stage work · move onto a variation…"
    picker (`TimeEntriesRepository.setVariation`, a one-column update; own
    entries for a technician, anyone's for office/admin). The controls show
    once an online read this session found the column (remembered for the
    session, so they keep working offline).
  - `VariationsRepository.submitVariation` now returns its op id and takes a
    `dependsOn`. Tests `mobile/lib/data/repositories/timeEntriesVariation.test.ts`.
- **Stream change:** `tech_time_entries` lists `variation_id` (an id — no
  money; `sync-streams-contract.test.ts` passes); `office_time_entries` is
  `time_entries.*`. Added to `mobile/lib/powersync/schema.ts` by hand. Not
  validated with `@powersync/service-sync-rules` here.
- **Before 0120 is applied nothing breaks:** every reader that names
  `variation_id` retries without it on 42703 / PGRST204 and treats every
  entry as the stage's (job page, phone Time tab, over-hours, scoreboard,
  hours to invoice, Job margins); the link table reads as "none" (42P01 /
  PGRST205); the variation pickers, tick box, hours and links hide; the
  phone's gateway drops `time_entries.variation_id` from queued writes
  (`mobile/lib/data/optionalColumns.ts`) — a clock-on still lands as stage
  time, a move has nothing left to write and is done.
- **Apply / deploy order:** paste `supabase/migrations/0120_variation_time.sql`
  → paste `supabase/tests/0120_variation_time_test.sql` (needs an active
  technician and an active office/admin), trust only `0120 PASSED` → change
  0120's STATUS line to applied, add the ledger row
  (`('0120','variation_time')`), regenerate types (`lib/database.types.ts`
  has `time_entries.variation_id`, `job_variations.is_hourly` and
  `variation_cost_links` by hand) → **redeploy the PowerSync streams**
  (`docs/powersync-deploy.md` — `tech_time_entries` names `variation_id`,
  so not before 0120) → deploy the web → ship the phone build.
- **Web Clock In picks a variation too (27 Nov 2026; no migration).** The
  Time tab's Clock In has a "Stage work / Variation: …" picker beside it when
  the job has an open (not rejected) variation, and while clocked on a
  **Switch** picker ("Switch to a variation (e.g. hit rock)…" / "Switch
  variation / back to the stage…"): clock-off then clock-on at the same
  instant (`planClockSwitch`; the clock-off first — 0090). The stage is the
  web's old rule (the job's scheduled cost centre — the phone's
  `manualClockOnCostCentre` has no web copy); a switch keeps the open entry's
  cost centre. Browser writes as the user (RLS + 0120's guard decide; its
  refusals shown with `variationTimeRefusal`). Rules `lib/web-clock-on.ts`
  (`clockOnChoices`, `clockOnRow` — `variation_id` only when set,
  `showVariationChoice`), tested in `tests/unit/web-clock-on.test.ts`. A
  database without the column: the picker hides once a read came back
  without it, and a refused clock-on retries as stage time (42703/PGRST204).
  No "+ New variation" on the web clock-on (raise it on the Variations tab,
  then clock on to it). Not checked in a browser.
- **Not done / to know:** the phone's office
  screens don't show variation hours or links (the office uses the web);
  a linked supplier PO / expense is the WHOLE record; a cost can be both
  part of a mistake and linked to a variation (the ledger moves it to the
  variation; the mistake still reports it as linked); "Set quantity to N h
  logged" isn't automatic — the office presses it; rejecting a variation
  moves its time back to the stage for good (re-tag by hand if it is
  reinstated); the over-hours alert and scoreboards drop variation time even
  while the variation waits for approval.

**"Didn't make it" and "Not attended" on bookings (27 Nov 2026; migration `0121` applied 2026-11-27, gate test passed; PowerSync streams redeployed 2026-11-27).**
Justin: technicians sometimes don't make it to a job they're booked on, and the
office can't tell a no-show from a forgotten close-out. His decisions: the
technician flags THEIR OWN booking with a reason; the booking STAYS WHERE IT
IS, flagged (nothing moved or deleted); the office reschedules by dragging it
as usual, and moving it clears the flag. Separately, a booking nobody clocked
on to is shown as "Not attended" — computed, never written.
- **Migration `0121_booking_missed.sql`:** `job_bookings.missed_at`,
  `missed_by` (→ profiles, on delete set null), `missed_reason` (check:
  `out_of_time`, `previous_job_ran_over`, `site_not_ready`, `weather`,
  `unavailable`, `other`), `missed_note` (≤ 500). Checks: reason and time set
  together, a note needs a reason, `other` needs a non-empty note. No new
  grants — job_bookings is granted at table level (0109's header). Two
  narrow doors, SECURITY DEFINER, `authenticated` only (anon/public revoked):
  `flag_booking_missed(booking, reason, note)` and
  `clear_booking_missed(booking)` — caller active, not limited-access (0110),
  the booking's own technician or office/admin; booking has a technician
  (MJ145); job open (MJ001, 0096's words); first booked Melbourne day today or
  earlier (MJ144); idempotent. Other codes: MJ141 missing, MJ142 not yours /
  not allowed, MJ143 not found, MJ146 bad reason, MJ147 Other without a note,
  MJ148 note too long (MJ120–MJ134 are 0119's). Trigger
  `job_bookings_clear_missed` (BEFORE UPDATE OF starts_at, ends_at, staff_id)
  clears the four columns when the booking moves (office drag, calendar poll,
  0079 rebuilds, 0118's clock follow). 0080's `job_bookings_touch` and
  `job_bookings_derive_update` are re-hung with WHEN clauses that also ignore
  the four columns (functions unchanged), so a flag write doesn't bump
  `updated_at` (the calendar poll never sees it as an edit), doesn't re-derive
  the job (no jobs write, window untouched) and 0096 never fires (it watches
  only the window/staff columns). It is still sync-window activity (0068's
  child trigger) — correct. End state asserted (columns, checks, triggers +
  the widened WHEN, functions + grants, job_bookings writes still office/admin
  only, no money-named column). Idempotent; no temp tables.
- **Gate test** `supabase/tests/0121_booking_missed_test.sql` (one
  self-undoing DO block; needs an active technician and office/admin): 28
  scenarios — anon can't run either function; a technician's direct UPDATE of
  the columns is blocked (RLS); Other without a note, an unknown reason, a
  501-character note refused; someone else's booking, a future booking, a
  completed job's booking refused; own booking today flagged (reason, trimmed
  note, flagged by them, booking unmoved, job NOT re-derived — the crew row
  removed beforehand stays removed); an earlier booking flagged; a retry ok;
  undo; office flags and clears anyone's; the job's window unchanged; moving
  the booking a day, or to another technician, clears the flag; a note edit
  keeps it; a limited account refused. **Checked** on a scratch Postgres 16
  (full chain 0000–0120 + CI seed, `/var/tmp/pg121`): 0121 applies three times
  cleanly, `0121 PASSED`; fails naming scenarios with the clear trigger
  dropped (2), with the reason check and the function's own check removed
  (3), and with 0080's old WHEN on `job_bookings_derive_update` (7 — the
  re-derive then hits 0074's crew rule); the 0096, 0109 and 0118 gate tests
  and the money sweep still pass. Not tried against PostgREST, in a browser
  or on a device.
- **Route** `app/api/jobs/[id]/bookings/[bookingId]/missed/route.ts`:
  `POST {reason, note}` flags, `POST {clear: true}` (the phone's outbox only
  POSTs) and `DELETE` clear. `requireRole(admin, office, technician)`, then
  every read and write as the CALLER (`callerClient`) — never the service
  role. The booking must be on the job in the URL (read as the caller, 404
  otherwise). Codes → fixed sentences (`lib/booking-missed.ts`
  `missedRpcError`; 42883/PGRST202 → 409 "isn't switched on yet"). Answers
  the flag's fields only. Tests `tests/unit/booking-missed-route.test.ts`.
- **Rules** `lib/booking-attendance.ts` (pure; reasons/labels, `validateMissed`,
  `canFlagMissed`, `isNotAttended`, `notAttendedBookings`,
  `attendanceCandidateJobIds`, `withQueuedMissed`, `isMissingMissedColumn`),
  mirrored byte for byte below the imports at `mobile/lib/bookingAttendance.ts`
  (`tests/unit/booking-attendance-mirror.test.ts`); tested in
  `tests/unit/booking-attendance.test.ts`. Day rules are 0071/0079's
  (`scheduleDays`) — never `starts_at` alone.
- **"Not attended"** = the booking's LAST booked Melbourne day is before today,
  its job isn't completed/cancelled, it isn't flagged, it has a technician, and
  that technician has no WORK `time_entries` row on that job clocked on on any
  of its booked days. **Office/admin only.** Web board: the page reads the
  candidate jobs' work clock-ons from the board's first day (60 days back) as
  the caller — `lib/booking-attendance-data.ts`, named columns `id, job_id,
  staff_id, clock_in, entry_type` (never `rate_override`), `.in()` in chunks
  of 100, paged; a failed read tags nothing; bookings that start before the
  window are never tagged. Phone office Schedule tab: the same rule and read,
  online, best-effort (`mobile/lib/data/reads/attendance.ts`, tested). Web job
  page Overview: from the job's own time entries (all history).
- **Where it shows:** web board (Week, Day, drag overlay) — `BlockBody` renders
  `components/schedule/booking-attendance-tag.tsx`: red "Didn't make it —
  <reason>" (the note on hover) or amber "Not attended"; above the board
  "N bookings not attended" opens the list (job link, technician, days —
  `components/schedule/not-attended-summary.tsx`); the List tab lists each
  flagged booking under its job row with the technician; the hover card
  (`lib/schedule-hover.ts` `attendance`) gives reason + note. Web job
  Overview's bookings list: the tag and the note. Phone office Schedule:
  `ScheduleGrid` Block title line (red / amber) and the List row prefix. Phone
  job header lines: the red tag.
- **Phone — the technician** (`mobile/components/job/didnt-make-it.tsx`):
  "Didn't make it" on each of their OWN bookings that occupy today or earlier
  on an open job — on the My Jobs booking card, and on the job's Overview in a
  "Couldn't get to it?" card (own bookings from the last 7 days up to today,
  plus any flagged). A `KeyboardSheet`: pick a reason (required), note
  (required for Other, ≤ 500), Confirm. Once flagged: the red line with Undo.
  Through the OUTBOX — a `booking-missed` side effect
  (`ScheduleRepository.flagMissed` / `clearMissed`, coalesced per booking, so
  a flag then an undo offline collapses to the undo; waits for the booking's
  own insert when that hasn't synced) → the route above; works offline. A
  queued change is laid over what the screen reads (`mobile/lib/missedQueue.ts`,
  `useMissedFlags`), marked "not sent yet", until the booking syncs back.
  Tests `repositories/scheduleMissed.test.ts`. No money anywhere.
- **Stream change:** `tech_job_bookings` lists `missed_at, missed_reason,
  missed_note` (not `missed_by`; no money; contract test passes);
  `office_job_bookings` is `job_bookings.*`. The four columns added to
  `mobile/lib/powersync/schema.ts` and `lib/database.types.ts` by hand.
- **Before 0121 is applied nothing breaks:** every reader that names the
  columns retries without them on 42703/PGRST204 (`isMissingMissedColumn` —
  web `loadJobBookings` and the board embed, phone `listJobBookings`,
  `listMyJobBookings` and both office reads); the route answers 409 "isn't
  switched on yet", so a queued phone flag fails and is retried / reported as
  a dead letter rather than lost silently; "Not attended" works (it needs no
  column). Nothing writes the columns directly, so the gateway needs no
  optional-column entry.
- **Web, for the office (27 Nov 2026; no migration).** Office/admin get
  "Didn't make it…" (or "Didn't make it — change or clear…" once flagged) as
  the last item of the board's hold / right-click booking menu
  (`bookingMenuItems` `missed`, rule `missedAction` in
  `components/schedule/board-actions.ts` = `canFlagMissed` + office/admin;
  tested in `tests/unit/web-booking-missed.test.ts`) and under each booking
  in the job Overview's bookings list. Both open
  `components/schedule/booking-missed-dialog.tsx` (a `KeyboardSafeDialogContent`:
  the six reasons, note ≤ 500 — Other needs one — `validateMissed`, Clear on a
  flagged booking) → the existing `POST/DELETE …/bookings/[bookingId]/missed`
  route; its sentence is shown on a refusal; the page refreshes after. Not
  offered to technicians on the web (the phone is their door). Not checked in
  a browser.
- **Not done:** no push to the office; the phone's office booking menu sheet doesn't
  repeat the reason (the block and List row do); the web board clears a moved
  booking's tag on the next refresh (the board refreshes after every write).
- **Apply / deploy order:** paste `supabase/migrations/0121_booking_missed.sql`
  → paste `supabase/tests/0121_booking_missed_test.sql` (needs an active
  technician and an active office/admin), trust only `0121 PASSED` → change
  0121's STATUS line to applied, add the ledger row (`('0121','booking_missed')`),
  regenerate types (`lib/database.types.ts` has the columns by hand) →
  **redeploy the PowerSync streams** (`docs/powersync-deploy.md` —
  `tech_job_bookings` names the new columns, so not before 0121) → deploy the
  web (the route) → ship the phone build (no native module).

**A job sent back by the office tells its crew: push, red banner, "Sent back" tag (27 Nov 2026; migration `0122` applied 2026-11-27, gate test passed; PowerSync streams redeployed 2026-11-27).**
Approvals → **Send back** (web `components/approvals/approvals-client.tsx`
`reject()`, phone `mobile/lib/data/repositories/approvals.ts` `sendBackJob`)
sets `jobs.admin_status = 'rejected'`, `admin_notes` = the note, status
`in_progress`, `ready_to_invoice` false. The toast said "technician will be
notified" — nothing did: no push, the note shown nowhere, and `tech_jobs`
didn't carry the columns, so the job just reappeared in My Jobs.
- **Why a new column for the note.** `jobs.admin_notes` is ALSO the admin's
  approval comment (`lib/approve-job.ts` writes it on approve), which can talk
  money, and a technician's job stays on their phone up to 90 days after it
  closes (0068). So `admin_notes` stays off phones (the stream contract test
  lists it as a money term — not weakened) and 0122 adds
  **`jobs.sent_back_note`** (the note written TO the crew) and
  **`sent_back_at`**, written only by trigger `jobs_sent_back_stamp`
  (`stamp_job_sent_back()`, BEFORE INSERT/UPDATE, sorts after 0074's
  `jobs_office_columns` and 0098's `jobs_requeue_on_complete`): copied from
  `admin_notes` (trimmed) when `admin_status` becomes `rejected` or the note
  changes while rejected; any other write — including a technician writing
  the columns directly — keeps the old values. They keep the LAST send-back
  as history; the banner and tag key off `admin_status`. Jobs already sent
  back are given their note once (backfill before the trigger exists;
  `sent_back_at` = their `updated_at`).
- **Push** (`notify_job_sent_back()`, AFTER UPDATE OF admin_status,
  admin_notes; 0077's mechanism exactly — pg_net + the Vault secrets
  `push_function_url` / `push_internal_secret`, sent after commit, nothing
  without secrets, any failure a WARNING): to the job's crew
  (`job_assignments` ∪ `assigned_to`), once each, **never the sender**
  (`auth.uid()`), only for a signed-in user's write (service-role scripts send
  nothing) on an open job. Title "Job #123 sent back", body = the note
  (whitespace collapsed, ≤150 characters with "…"), data `{ type:
  "job_sent_back", jobId }` — the phone's tap handler opens the job
  (`mobile/lib/push/notificationTaps.ts`, tested). A note edited while still
  sent back pushes again; other edits don't. Both functions SECURITY DEFINER,
  not executable by clients; `grant select (sent_back_note, sent_back_at)`
  explicitly (jobs has no column grants today); end state asserted.
- **Clears on re-sign-off — already true, verified:** completing the job as a
  signed-in user puts `admin_status` back to `pending` (0098's
  `jobs_requeue_on_complete`), so it returns to Approvals and the banner/tag
  go. A stage-only sign-off (other stages open) writes no `jobs` row, so the
  job stays sent back — intended (it is still open).
- **Rule** `lib/sent-back.ts` (`isSentBack` = rejected and not
  completed/cancelled, `sentBackNotice`, `sentBackWhen` "Fri 27 Nov, 2:15 pm"
  Melbourne), mirrored from the first export at `mobile/lib/sentBack.ts`
  (`tests/unit/sent-back.test.ts`).
- **Web:** red **"Sent back by the office"** banner with the note and when,
  above the job's tabs (`components/job/sent-back-banner.tsx` in
  `job-detail-client.tsx`), for the crew and office, not on view-only jobs.
  The job page (`app/dashboard/jobs/[id]/page.tsx`) now gives a technician
  `admin_notes` only while the job is sent back (it is the send-back note
  then; otherwise it may be an approval comment), and a technician not on the
  job none of the send-back columns. Before 0122 the banner reads
  `admin_notes` (web only). **My Jobs** (`app/dashboard/my-jobs/page.tsx`)
  selects `admin_status` (0041 — exists) and shows a red "Sent back" tag.
- **Phone:** the same banner above every tab (`mobile/components/job/sent-back-banner.tsx`
  in `app/job/[id].tsx`, not on view-only jobs) and a "↩ Sent back" tag on My
  Jobs cards (`components/jobs/my-jobs-screen.tsx`). Reads: `getJob` and
  `listMyJobs` (`mobile/lib/data/reads/jobs.ts`) return `admin_status`
  (+ `sent_back_note`, `sent_back_at` on the detail), identical shapes local
  and remote (`jobs.local.test.ts`, `getJob.remote.test.ts`); the remote
  detail read retries without the two new columns on 42703/PGRST204 naming
  them (`isMissingSentBackColumn`). The phone never reads `admin_notes` for
  this. Columns added to `mobile/lib/powersync/schema.ts` by hand.
- **Toasts:** web "Job sent back — the crew see your note on the job"; phone
  office alert "The job was reopened — the crew see your note on the job."
- **Stream change:** `tech_jobs` lists `admin_status, sent_back_note,
  sent_back_at` (not money; `sync-streams-contract.test.ts` passes and now
  also asserts `tech_jobs` never names `admin_notes`). `office_jobs` is
  `jobs.*`. Not validated with `@powersync/service-sync-rules` here.
- **Before 0122 is applied nothing breaks:** no push; the web banner shows
  from `admin_notes` (no time); the phone's remote read falls back and shows
  the banner without a note ("Ask the office what's needed…"); the phone's
  mirror has no `admin_status` until the streams are redeployed, so offline
  no banner/tag shows (the remote reads have `admin_status` already).
- **Checked** on a scratch Postgres 16 (`/var/tmp/pg122`: the full chain
  0000–0120 + CI seed, pg_net shimmed with a request queue, Vault with
  `create_secret`): 0122 applies twice cleanly;
  `supabase/tests/0122_sent_back_notice_test.sql` passes (23 scenarios: one
  push to the technician only with the sender on the crew, title/body/data,
  note trimmed and stamped, other edits silent, a changed note pushes again
  and is cut to 150 characters, the technician reads status and note on their
  job but can't forge the note or change `admin_notes`, re-sign-off → pending
  with no push and the note kept, a service-role send-back stamps but doesn't
  push, a still-completed job doesn't push, no secrets → nothing queued) and
  fails naming scenarios with the notify trigger disabled (8) or the stamp
  trigger disabled (9). Not tried against PostgREST, the real send-push, in a
  browser or on a device.
- **Apply / deploy order:** paste `supabase/migrations/0122_sent_back_notice.sql`
  → paste `supabase/tests/0122_sent_back_notice_test.sql` (needs an active
  technician and an active office/admin), trust only `0122 PASSED` → change
  0122's STATUS line to applied, add the ledger row
  (`('0122','sent_back_notice')`), regenerate types (`lib/database.types.ts`
  has both columns by hand) → **redeploy the PowerSync streams**
  (`docs/powersync-deploy.md` — `tech_jobs` names `sent_back_note` /
  `sent_back_at`, so not before 0122) → deploy the web → ship the phone build
  (no native module).

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

- `tech_jobs` — 24 named columns, none monetary (`schedule_daily`,
  `schedule_all_day` added for the 0071 multi-day schedules; 0071 applied and
  these rules redeployed 2026-10-14; `admin_status`, `sent_back_note`,
  `sent_back_at` added with 0122 (applied and streams redeployed 2026-11-27) —
  the office's send-back note to the crew, copied by trigger; **never
  `admin_notes`**, which also holds approval comments)
- `tech_job_variations` — omits `rate`, `total_amount`, `admin_notes`
- `variation_types` — omits the preset `rate`
- `tech_time_entries` — omits `rate`; lists `variation_id` (0120 applied and streams redeployed 2026-11-27 —
  the variation the time is for, an id, not money; redeploy after applying)
- `profiles`, `sync_horizon`, `tech_customers` / `backflow_customers`,
  `tech_sites` / `backflow_sites`, `backflow_devices`, `backflow_tests`,
  `tech_job_assignments`, `tech_job_photos`, `tech_job_notes`,
  `tech_job_stage_notes` — no monetary column in the selected sets
  (`tech_job_photos` gains `folder` with the drafted 0116 — redeploy after
  applying it)
- `tech_job_bookings` (added for build 16; 0079/0080 applied 2026-10-19,
  deployed as sync config v5 on 2026-11-14) — 10 named columns: who, when, cost-centre **id**;
  plus `note` (the booking's free-text scheduling note, 0109 applied
  2026-11-16; streams redeployed 2026-11-17); plus `missed_at`, `missed_reason`,
  `missed_note` ("Didn't make it", 0121 applied and streams redeployed 2026-11-27;
  not `missed_by`); no money column exists on `job_bookings`

**Backflow streams are gated on the caller's profile (migration 0110,
applied 2026-11-17).** `backflow_customers`, `backflow_sites`,
`backflow_devices`, `backflow_tests` go to every role, so they now
`JOIN profiles ON profiles.id = auth.user_id()` and require
`profiles.limited_access IS NOT true`: a limited-access account (the App Store
review login) receives none of it; everyone else exactly what they did before.
`IS NOT true`, never `= false`, so a database without the column keeps today's
behaviour. A user with no profile row now receives no backflow register (fail
closed). 0110 applied and the YAML redeployed (active) on 2026-11-17.

**Staff leave is in no stream (0112, applied 2026-11-19).** The schedule's leave comes
from `schedule_leave()` online, which withholds the leave type by role; a
stream would bypass that and put leave types and notes in technicians'
SQLite. `tests/unit/sync-streams-contract.test.ts` fails if any stream reads
`staff_leave`, `staff_leave_balances` or `schedule_settings`.

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
  cost-centre amounts, vendor orders). Technicians raise supplier POs only
  through `/api/jobs/[id]/supplier-orders`, which returns no money (§1). Technicians get an hours-only
  `JobHoursScoreboard` on Overview, fed by `purchase_orders_public.total_hours`
  (never the base table) + `time_entries` hours — maths in
  `lib/hours-scoreboard.ts`, mirroring the mobile card.

---

**Today card on the phone (Stage 6, 31 Oct 2026; no migration).** Justin:
"the app should prompt the crew through the next steps… The app leads the
day." `components/job/today-card.tsx` sits above the Overview (not in
view-only): Clock on → Order materials → Confirm deliveries → Record progress
→ Complete the job, each ticked from what is already recorded
(`lib/todaySteps.ts`, tested), the first unfinished one highlighted. Clock on
works on the card (same default cost centre as the Time tab); the other steps
open their tab. Orders are online-only, so offline that step says "Orders need
signal".

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

### Job bookings on the phone (build 16; 0079 + 0080 applied 2026-10-19; streams deployed as v5 2026-11-14)

`job_bookings` (`0079`, applied 2026-10-19) holds each technician's own
window and cost centre on a job; the job-level schedule and crew are derived
from it. The phone side (branch `feat/job-bookings-mobile`):

- **Sync.** `0080` (applied 2026-10-19) adds `job_bookings` to the
  `powersync` publication and gives it `sync_office` with the 0068 child
  triggers, the job cascade and a block in `sync_window_refresh()`. It also
  re-hangs two 0079 triggers with `WHEN` clauses so a flag-only write (the
  nightly refresh) is not activity — without that, every job with a booking
  would have stayed in both windows forever. Streams: `tech_job_bookings`
  (follows the job like every `tech_job_*`), `office_job_bookings` (windowed).
  Deploying the YAML is manual — `docs/powersync-deploy.md`.
- **Reads** (`lib/data/reads/bookings.ts`) tell three states apart: no table
  yet (remote PGRST205/42P01 → `null` → every screen shows the job-level
  schedule, as before); table on the server but not on the device (a scheduled
  job with zero local bookings is impossible under 0079, so the local read
  throws `OutsideSyncWindow` and asks Supabase); everything deployed (local,
  offline). Rules in `lib/bookings.ts`.
- **My Jobs** shows one card per OWN booking (a job booked twice = two cards,
  each with its time and stage name), split Today/Upcoming by the booking's
  day. A job with no booking for them shows the job's window. Past bookings
  hide while a current one exists on the same job.
- **Job screen** header lists every booking (who · when · stage), yours in
  blue as "You".
- **Office:** the Schedule tab lists one row per booking per day; Reschedule
  on a booking row moves only that booking. The crew picker stays. The
  Schedule Job modal is a bookings list editor (add: technician(s) → window →
  stage → note, one booking each, none = unassigned; edit; delete) writing
  `job_bookings` insert/update/delete through the outbox
  (`ScheduleRepository.addBookings/updateBooking/deleteBooking`, aggregate
  `job_booking`) plus a coalesced `sync-calendar`. Plain uuid-keyed rows, so
  the existing replay rules apply unchanged. Edits still queued are kept on
  screen across reloads (`mergePendingBookings`). Before 0079 the modal is the
  old single-schedule form.
- **Clock-in cost centre** (manual and geofence, foreground and background):
  the technician's booking covering the clock-in time, else their nearest
  booking that day, else `jobs.scheduled_cost_center_id` (`clockInCostCentre`).
  Geofence sites carry the bookings (`TrackedSite.bookings`, best-effort; a
  context published by build 15 has none and falls back).
- **Gaps to know:** a technician's stage NAMES come from the server
  (`po_cost_centers` is office-only — it carries money), so offline their
  cards show times without stage names; the IDs, and therefore the clock-in
  default, work offline.

### A role change reaches the phone when the app is reopened (16 Nov 2026)

Justin switched himself to technician and the phone still showed the office
dashboard with overdue invoice amounts: the profile (and so the role) was only
re-read at a cold start or the hourly token refresh. `lib/auth-context.tsx` now
re-reads it quietly every time the app returns to the foreground (at most every
30 s, `shouldRecheckProfile` in `lib/profileCache.ts`, tested; a backward clock
jump rechecks). A changed role re-gates the routes and PowerSyncProvider wipes
the old role's mirror, exactly as at a cold start. RLS and the sync streams were
never at fault — they gate on the server-side role — the phone was showing data
it had already synced while it still believed the user was office. Reaches
devices with the next build.

### The job screen always has a Back button (16 Nov 2026)

Justin found himself on a job with no way back. The native header only draws
its back arrow when a screen sits behind the job; one opened from a push
notification, a deep link, or after the routes re-gate on a role change has
none. `app/job/[id].tsx` now sets its own `headerLeft` "Back": it pops when it
can, otherwise goes home for the role (`/dashboard` office, `/` technician —
`lib/jobBack.ts`, tested). Reaches phones with the next build.

### Every screen and modal has a visible way out (27 Nov 2026; no migration, no native module)

Justin: "Today I did a invoice PDF preview and there was no back button … make
sure every dead end has a back button." iOS has no hardware back and a swipe
isn't obvious, so every place a user can end up now SHOWS a way out.
- **Stack screens:** the job screen's Back is now the root Stack's default
  `headerLeft` (`app/_layout.tsx` → `components/ScreenBackButton.tsx`, rule
  `lib/backTarget.ts` — `backTarget` / `goBackOrHome`; `lib/jobBack.ts` is an
  alias). Every pushed screen (invoices, quotes, customers, fleet, staff,
  settings, backflow, run sheet, job billing/costing …) shows "‹ Back": it pops
  when it can, else goes home for the role (`/dashboard` office/admin, `/`
  technician) — so a screen opened from a notification, a
  `mellerickfield://` deep link or after a role re-gate is never a dead end.
  The job screen's own `setOptions` copy is gone.
- **PDF preview** (`components/finance/pdf-preview.tsx`, invoice/quote PDF and
  the job report preview): the small "Close" text at the top-right became a
  top-left "✕ Close" header (`ModalHeader`, `components/ModalClose.tsx`).
- **Photos:** the timestamp-camera preview gained a top-left ✕ Close (outside
  the stamped image; nothing saved, same as Retake); the photo viewer's ✕ moved
  top-left, 44 pt, below the notch (`insets.top`, was a fixed 50 px).
- **`KeyboardSheet`** (every form sheet, 29 uses) always shows a ✕ (Close) at
  its top-right that calls `onRequestClose`.
- **Picker sheets that only closed on a tap outside** now have a Cancel
  (`SheetCancelButton`): backflow device/test pickers, job Overview's select,
  the Time tab's stage / variation / staff pickers. The office Schedule booking
  menu gained a Close row. The ✕ on the customer picker and line-item editor got
  an accessible label and a bigger hit area.
- **Guard:** `mobile/test/screens/way-out.test.ts` (from the file tree, not a
  list): every route outside the tab groups is registered with
  `headerShown: true` (allow-list: `login`), the root Stack's `headerLeft` is
  `ScreenBackButton`, nothing sets `headerBackVisible: false` /
  `gestureEnabled: false`, the root is the only Stack, and every `<Modal>` in the
  app has `onRequestClose` (Android back) AND a visible Close / Cancel / Done
  (or, for the clock prompt and location disclosure, their named decline
  button); full-screen modals close from the top-left or a bottom Cancel. Unit
  tests `mobile/lib/backTarget.test.ts`, and `KeyboardSheet.test.tsx` checks the ✕.
- **Web, checked only:** dialogs use `components/ui/dialog.tsx` (✕ by default,
  no `showCloseButton={false}` anywhere); the invoice/quote PDF opens in a new
  tab; the mobile-width site/supplier pickers have Close. Minor: the public
  `/privacy` and `/delete-account` pages have no link to sign in, and
  `/update-password`'s form has no "Back to sign in" (only its expired-link
  state links on). Not changed.
- Reaches phones with the next build.

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

### Auto clock-in prerequisites (20 Oct 2026)

Auto clock-in had never fired: 1,441 of 1,443 sites had no coordinates (Simpro
imports were never geocoded), and it only ran for role = technician.
- `scripts/geocode-sites.mjs` filled the backlog (OpenStreetMap Nominatim, 1/s,
  building/address-level matches only — a street or suburb match is treated as
  not found, because a wrong 150 m fence is worse than none). `lib/geocode.ts`
  holds the same rule for `/api/geocode` and the hourly
  `/api/sites/geocode-missing` cron, which fills new sites and retries a failed
  address weekly (`sites.geocode_attempted_at`, 0082).
- `profiles.auto_clock` (0082, admin-only like role): NULL = by role, true/false
  overrides. Staff page shows an "Auto clock on/off" switch; the phone's
  `trackingGate.decideTracking` honours it (needs build 18).
- Web and mobile job pages warn when the site has no map location. New estate
  streets are the usual reason (not yet in OpenStreetMap at house level).

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

**Truck and plant to cost centres (Stage 7, 31 Oct 2026; migration `0091` applied 2026-10-31).**
Justin: quarter-minus cartage belongs to Transport, separate from the drainage
work; a dedicated driver logs it; truck cost counts per hour AND per load.
- 0091: `equipment_usage_log.cost_center_id` (the job's PO line) and `loads`
  (hours may be 0 for loads only; one of them must be > 0), and
  `equipment.cost_per_load` (Fleet → cost profile, "Per load carted").
- Ledger (`lib/job-ledger.ts plantCosts`): hours × cost/hour (skipped for
  equipment assigned to a person — already in their rate) plus loads × cost
  per load (always), on the usage's line.
- Web Equipment tab: loads and a cost centre on each entry.
- Phone: "Truck & plant" under the Time tab (`components/job/plant-usage.tsx`,
  route `/api/jobs/[id]/plant-usage`): pick the truck, the cost centre (a
  vehicle defaults to the job's Transport line), hours and loads with big
  steppers. Equipment names come through the service role with no costs; the
  insert uses the caller's session so 0074's "jobs you can manage" rule holds.
  The office mirror's schema has the new columns (`schema.ts`, added by hand).

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
`…_4_fc97`, active, 0 bytes behind). **Resolved 2026-11-14:** the second
instance (`…73ab…`, labelled "Production" in the dashboard but never used by
the app — 0 clients in 30 days, sample template config) was deleted and its
slot `…_1_db25` went with it; only `…496c5e_4_fc97` remains. Note the app's
instance is the one labelled **"Development"**. The unused role
`powersync_7dc56333…` (reads nothing) is still in the database, harmless. Lesson repeated from August: **read the PowerSync dashboard log
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
| **`APP_URL`** (optional) | Justin | Origin for emailed reset links. Unset = `https://mellerick-app.vercel.app`, which is right for production. Set it only for a different domain, or `http://localhost:3000` in `.env.local` to test resets locally. |
| **Check `EMAIL_FROM` for supplier POs** | Justin | Supplier PO emails go from `EMAIL_FROM` — it must be on a domain verified in Resend, or suppliers never receive them. (0085 itself applied 2026-10-28.) |
| **Xero analytics: reconnect Xero** | Justin | `0105` is applied (2026-11-14). After deploy, click **Connect Xero** once so the new read scopes are granted, then `POST /api/xero/sync-analytics` as admin (or wait for the nightly cron) to start the 24-month backfill. |
| **Unallocated bills: set `WEEKLY_DIGEST_TO`** | Justin | `0106` is applied (2026-11-14). Set `WEEKLY_DIGEST_TO` in Vercel (Production) to the office recipients' addresses. |
| **Day Works / Hire: check rates** | Justin | `0108` is applied (2026-11-16). Set rates for the machines the name match missed — Fleet → **Hire rates** lists them first — and confirm the twin-steer float's 30 km / $5 per km. |
| **Booking notes: record 0109** | Justin | `0109` applied 2026-11-16; sync streams redeployed and active 2026-11-17. Only the ledger row is left if not yet run: `insert into supabase_migrations.schema_migrations (version,name) values ('0109','job_booking_note') on conflict do nothing;` |
| **App Review account: limit it (0110)** | Justin | `0110` applied 2026-11-17 (gate test passed); sync streams redeployed and active the same day. Mark the reviewer in the SQL editor: `select set_config('request.jwt.claims', '{"role":"service_role"}', true); update profiles set limited_access = true where lower(email) = lower('<reviewer email>');` (expect UPDATE 1). Ledger: `insert into supabase_migrations.schema_migrations (version,name) values ('0110','limited_access_accounts') on conflict do nothing;` The phone hides the Backflow tab for it from the next build. |
| **Truck loads: set rates (0111 applied)** | Justin | `0111` applied 2026-11-19 (gate test passed). Ledger row: `insert into supabase_migrations.schema_migrations (version,name) values ('0111','cartage_loads') on conflict do nothing;` Then: Fleet → Hire setup on each truck, add **Cartage per tonne** and/or **per m³** and **per km** rates; Settings → Truck loads, check the margin (15% by default); on jobs where quarry product is NOT in the quote, set the Day Works tab's "Quarry product on this job" to Extra. |
| **Leave on the schedule: record 0112** | Justin | `0112` applied 2026-11-19 (gate test passed). Ledger row: `insert into supabase_migrations.schema_migrations (version,name) values ('0112','schedule_leave') on conflict do nothing;` No PowerSync redeploy. Who sees the leave type defaults to office + admin; change it in Settings → Leave on the schedule. Part days: add From/To times on the Leave Log entry. |
| **Komtrax: sync and link machines** | Justin | `0113` applied 2026-11-20 (gate test passed). Ledger row: `insert into supabase_migrations.schema_migrations (version,name) values ('0113','komtrax') on conflict do nothing;` Admin → Fleet → Komtrax machines → **Sync Komtrax**, then link any Komatsu machine not linked by serial (or put its serial in the fleet item's notes). `KOMTRAX_USERNAME` / `KOMTRAX_PASSWORD` are in Vercel Production. |
| **Technicians start work themselves: record 0118** | Justin | `0118` applied 2026-11-25 (gate test passed). Ledger row if not yet run: `insert into supabase_migrations.schema_migrations (version,name) values ('0118','self_start_bookings') on conflict do nothing;` Deploy the web, then the phone build. No PowerSync redeploy. |
| **Sent back + Didn't make it: ship the phone build** | Justin | `0121` and `0122` applied, ledger rows recorded and PowerSync streams redeployed (2026-11-27). Only the phone build is left (with 0120's). |
| **Supplier invoices from Gmail: reconnect Google** | Justin | `0124` applied 2026-11-27 (gate test passed). Ledger row if not yet run: `insert into supabase_migrations.schema_migrations (version,name) values ('0124','gmail_supplier_invoices') on conflict do nothing;` Then Settings → the **Google (Calendar and Gmail)** card (it was titled "Google Calendar") → **Reconnect** (adds Gmail read; make sure the Gmail API is enabled and the scope is on the OAuth consent screen in Google Cloud), create the **Supplier invoices** label + a filter in the accounts mailbox, then Supplier POs → Check now. No PowerSync redeploy. |
| **Time against variations: ship the phone build** | Justin | `0120` applied, ledger row recorded and PowerSync streams redeployed (2026-11-27). Only the phone build is left. Office: tick "Charged by the hour" on hourly variations. |
| **Cost of mistakes: record 0119** | Justin | `0119` applied 2026-11-25 (gate test passed). Ledger row if not yet run: `insert into supabase_migrations.schema_migrations (version,name) values ('0119','mistake_tracking') on conflict do nothing;` Deploy the web, then the phone build. No PowerSync redeploy. Check Settings → Mistake categories. |
| **Record the 24–25 Nov migrations; redeploy PowerSync** | Justin | The catch-up (0067 + 0070 + 0117, which did 0064–0066's job) and 0114, 0116, 0115 are applied and confirmed by a read-only check (nothing from 0060–0116 missing). Ledger rows: `insert into supabase_migrations.schema_migrations (version,name) values ('0064','restrict_site_writes_to_office_admin'),('0065','office_only_job_documents'),('0066','backflow_certificate_storage_policies'),('0067','job_todo_list'),('0070','page_load_indexes'),('0114','customer_address_doc_folders'),('0115','job_mistakes'),('0116','job_folders'),('0117','catch_up_sites_and_office_only_documents') on conflict do nothing;` Then **redeploy the PowerSync streams** (`tech_job_photos` lists `folder`; docs/powersync-deploy.md), then the phone build. Run `scripts/audit-job-documents.mjs` to mark priced Simpro attachments office-only. Add billing addresses to customers. |
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

**Builds from GitHub (15 Nov 2026).** Actions → **Build phone app**
(`.github/workflows/phone-build.yml`, run by hand; pick both / ios / android)
runs the same `eas build` on Expo's servers, so no Mac is needed. iPhone goes
to TestFlight by itself; Android is built only (the org policy blocks Play
service-account keys) — download the `.aab` from expo.dev and upload it in Play
Console. Needs the repository secret `EXPO_TOKEN`.

**Store assets** — screenshots (4 per platform, demo-safe data) and an Android
feature graphic (1024×500). Listing copy, privacy answers and the privacy policy
are written and live outside the repo at
`OneDrive - BAS & More/DevOps/Mellerick Plumbing/{Android,Apple}/`, as PDFs and
markdown.

**Distribution is private (Justin, 13 Nov 2026).** Staff-only app: Apple
**Unlisted** distribution (request form after review approval) and Google
**Managed Google Play** private app for the Mellerick organisation — no public
listing on either store. iPhone only: `ios.supportsTablet` is `false`, so no
iPad screenshots are needed. Apple refuses dropping iPad support on an app that
has ever been *released* with it; this was turned off before the first release.

**iPhone private release plan (16 Nov 2026): [`mobile/APPLE-PRIVATE-RELEASE.md`](mobile/APPLE-PRIVATE-RELEASE.md).**
Plan A is now a **custom app through Apple Business Manager** (Mellerick's own
Organisation ID, Pricing and Availability → Private — permanent), with
Unlisted as the fallback. Step-by-step for Justin: reviewer account on QA job
#834, review notes and video, App Privacy answers, ABM enrolment and redeem
codes. Never press Release on a *Public* version if custom is still wanted —
a publicly released app can't become custom. Review prep landed with it:
in-app Privacy policy / Delete account links (`mobile/components/LegalLinks.tsx`
→ web `/privacy`, `/delete-account`), clearer camera/photo/speech purpose
strings, no unused Face ID string, and Name/User ID/Other User Content/Crash
Data in the privacy manifest — pinned by `mobile/app-config.test.ts`. Reaches
phones with the next build.

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

**Auto-clock fixes (Stage 5, 31 Oct 2026; migration `0090` applied 2026-10-31).**
Justin chose to keep automatic clocking and fix it. What changed:
- **One engine at a time.** The background task ignores deliveries while the
  app is active (`backgroundClockTask.ts`); the foreground watcher has them.
  0090 adds `time_entries_one_open_work_entry` (unique on staff+job while open
  and `work`), after closing existing duplicates (earliest kept open, later ones
  closed at their own clock-in, 0 h, audited). The gateway and the background
  task treat a clash with that index as "already clocked in".
- **Bad readings ignored, buffer to leave.** `nextGeofenceState` skips fixes
  with accuracy worse than 75 m; arrival stays at 150 m, but leaving needs
  250 m (`GEOFENCE_EXIT_RADIUS_METERS`), unless the reading is properly inside
  a nearer neighbouring site.
- **Today's jobs only** (`todaysJobSites` in `reads/jobs.ts`): jobs whose
  schedule touches today, plus any job the tech is still clocked into (even if
  completed); with nothing scheduled today it falls back to all open jobs.
- **Foreground site-to-site** closes the job left before clocking into the
  next (the background planner already did).
- **Web**: the website geofence was removed in Stage 0; the dashboard now has
  "Needs a look from yesterday" — jobs booked yesterday not signed off, and
  clocks still running from before today.
- Geocoding no longer accepts `class=landuse` (an estate's centroid) as precise.
- **Clock extras (migration `0092` applied 2026-11-01):**
  - Every phone clock-on/off records `clock_in_/clock_out_` lat, lng and
    accuracy (`mobile/lib/clockFix.ts`): manual taps take a recent fix or wait
    ≤3 s, never block and never prompt; the auto-clock (foreground and
    background, including queued background actions) uses the reading that
    fired it. 0092 grants the new columns explicitly — time_entries has
    column-level select grants (0045).
  - Web Time tab shows "In: on site / 320 m from site" per entry, amber with
    ⚠ when outside 150 m even allowing for the fix's accuracy
    (`lib/clock-location.ts`). A flag, never a block.
  - Phone Time tab status line (`components/job/auto-clock-status.tsx`,
    `lib/autoClockMessage.ts`): on / only while the app is open ("Always" off)
    / Approximate location (Android reports it; iOS inferred from fixes over
    1 km) / off and why, with a Settings button where a setting is the fix.
  - Phone Overview "📍 Set site location here" (`/api/jobs/[id]/site-location`,
    service role after checking the caller is on the job or office): needs a
    fix within ±50 m, asks before moving an existing pin, records
    `sites.location_set_by/_at`.

**No auto clock-on to a job already signed off (27 Nov 2026; no migration; phone only).**
Templestowe, #2594: signed off at 12:50 (which clocked Justin off); the phone's
own copy still had the job open, so four minutes later, still inside the
150 m fence, the geofence clocked him straight back on, and the entry ran all
afternoon on a completed job. Now, before an AUTOMATIC clock-on, the phone
reads the job's live `status, actual_end` (rule `skipAutoClockOn`,
`mobile/lib/autoClockClosedJob.ts`, tested): completed / cancelled with no end,
or with the clock-on at or after `actual_end` → no clock-on; a clock-on from
BEFORE the sign-off that only synced later (a background arrival queued in a
dead zone) still lands. Foreground (`location-tracking.tsx`
`isJobClosed` dep of `applyGeofenceTransition`): online only — offline it
clocks on as before; a skipped arrival keeps any pending departure for the
next real arrival. Background (`backgroundClockTask.ts insertWorkClockIn`):
reads the job before inserting; a failed read keeps the action queued
(transient). Manual clock-ons and the clock prompts are unchanged. Reaches
phones with the next build.

**Clock prompts for sites with no map pin (23 Nov 2026; no migration, no stream change).**
Justin: many sites have no pin, so auto clock-on never fires there. He
approved PROMPTS — the phone asks, never clocks on or off by itself. Phone
only; reaches phones with the next build (expo-notifications is already in
the binary for push — no new native module). Rules, all pure and tested, in
`mobile/lib/dwellPrompt.ts` (`dwellPrompt.test.ts`); storage + notifications
`mobile/lib/clockPrompts.ts`; what each answer does
`mobile/lib/clockPromptAnswers.ts`; the day's context
`mobile/lib/clockPromptContext.ts`; the in-app sheet
`mobile/components/ClockPromptSheet.tsx`.
- **"Stopped here" (clock on).** A technician (the gate's own role /
  `auto_clock` rule) with one of their OWN jobs booked TODAY (Melbourne day,
  their bookings by the 0071/0079 day rules, else the job's window — never
  `scheduled_start` alone) whose site has no `site_lat/site_lng`, not clocked
  into any work entry, stays within 100 m (+ up to 50 m of the fix's own
  accuracy; fixes worse than ±75 m ignored, as `nextGeofenceState`) for
  **15 min** → a notification and, with the app open, a sheet: "Stopped here
  for 15 min — are you at #123 12 Smith St? Tap to clock on." Several such
  jobs → pick one. Not asked inside a pinned site's exit fence (the
  auto-clock's job), within **300 m of the depot (21 Quinlan Rd, Epping)**, or
  within 200 m of a spot answered "No" today. A Yes ends prompts for that job
  for the day; a job declined at 2 spots isn't offered again that day (a "No"
  at a servo doesn't stop the real site asking).
- **Yes** = a manual-style clock-on (`auto_clocked` false) through the outbox
  (works offline), **backdated to the stay's first fix**, with that fix as the
  0092 clock-in fix and the cost centre from `clockInCostCentre` at that time
  (bookings, else the job's). Then — online only — the site is pinned through
  `/api/jobs/[id]/site-location` (`postSiteLocation`) from the stay's MOST
  accurate fix, only if ±50 m or better and only if the site still has no pin
  (never moves one). No signal or a poor fix → clocked on, not pinned, and it
  says so. `TimeEntriesRepository.clockIn/clockOut` take an optional `atIso`
  (never after now).
- **"Left the site" (clock off).** An open work entry on a job whose site has
  no pin (or the pin save failed), and the phone definitely more than 250 m
  (after subtracting the fix's accuracy) from where it clocked on for
  **10 min** → "Left #123 at 3:42 pm — clock off at 3:42?" Yes = clock off
  backdated to the first fix outside, with that fix (the existing `clockOut`,
  hours computed; a refused close — over 24 h — says why). "Still working" =
  not asked about that entry for 60 min, and the absence is timed afresh.
  Pinned sites are skipped (the geofence clocks them off). Where it clocked on
  is this phone's own record (`rememberClockAnchor`, fed by the new
  `onClockedIn` event from `TimeEntriesRepository.clockIn`), because the
  technician stream doesn't carry `clock_in_lat/lng`; an entry clocked on
  elsewhere (web, another phone) has no spot and gets only the late prompt.
- **"Still clocked on" (late).** Any work entry open at **17:00 Melbourne**
  (`LATE_PROMPT_HOURS`) → "Still clocked on to #123 — clock off now?" with
  Clock off now / Still working; asked once more at 19:00. Clock off = now,
  with a current fix; never backdated, never automatic. Both hours are
  scheduled as notifications ahead, so a parked phone still gets them.
- **Device clock (§3).** Stays and absences are timed from the fixes' own
  timestamps; "now" only extends one past its last fix when it is later and
  within 4 h. A fix stamped over a minute before the previous one, or a stay
  over 12 h, restarts it. Late prompts need the clock past the hour AND past
  the clock-on.
- **Background.** State (stay, absences, answers, what is scheduled) and the
  day's context live in AsyncStorage; the foreground builds the context on
  every gate pass (`buildPromptContext`, local-first reads incl. the new
  `listMyOpenWorkEntries` in `reads/clock.ts`) and the background task feeds
  each delivery to `processClockPrompts` after the auto-clock batch (jobs the
  batch just clocked off are dropped). Foreground handles fixes only while
  the app is active, the background only while it isn't (as the auto-clock),
  and calls are serialised. Because a parked phone sends no fixes, the
  notification is scheduled AHEAD at the due time (stay start + 15 min, first
  fix outside + 10 min, 17:00/19:00) and cancelled if a later fix breaks the
  stay or the entry closes; one identifier per question, never re-scheduled
  for the same stay. While the app is open the notification is hidden
  (`configureForegroundNotifications` checks `data.type === "clock_prompt"`)
  and the sheet asks instead; tapping a notification opens the app, which
  shows the sheet. No notification permission → no notification, the sheet
  still asks when the app is opened.
- **Tracking gate.** Today's unpinned jobs and open unpinned entries now count
  as "sites" (`promptSiteCount`, foreground and the background stop check),
  so a day of only unpinned jobs tracks in work hours instead of stopping
  with "no sites". Off-hours wake regions are still for pinned sites only.
- **Depot coordinates are NOT in source** — they couldn't be looked up where
  this was written (no network). The phone looks `DEPOT_ADDRESS` up through
  `/api/geocode` (house/building matches only) the first time it can, caches
  it in AsyncStorage, retries a failed lookup daily and a "not found" weekly;
  until then there is no depot exclusion.
- **No money anywhere:** job numbers, titles, addresses and times only.
- **Not verified on a device.** Check: a notification arrives with the phone
  locked after 15 min parked at an unpinned site (iOS delivers the scheduled
  one even with no fixes); driving through doesn't leave a stray one (a stay
  restarts on every moving fix, cancelling and re-scheduling); Yes offline
  clocks on and syncs later.

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
| `scripts/check-query-plans.sql` | Read-only EXPLAIN (ANALYZE, BUFFERS) of the three busiest dashboard reads (recent jobs, a staff member's work time, a job's photos), with the indexes each should use and when to revisit a `(staff_id, clock_in)` index on `time_entries` (not added: not needed at today's size, and it would slow every clock-on/off) |
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

**Site write permissions (migration `0064`; applied 2026-11-24 through the 0117 catch-up — not before):** RLS on
`sites` now lets every signed-in user read and add sites, but only office/admin
update (edit/archive) or delete them. It drops the old policies by enumeration
and asserts the end state. `tests/rls/sites.test.ts`
proves it on the CI stack.

**Office-only job documents (migration `0065`; applied 2026-11-24 through the 0117 catch-up — not before):**
`job_documents.office_only` hides a document — row and file — from technicians;
office/admin toggle it on the web Documents tab (lock icon). The same migration
fixes mobile expense receipts (`<job>/expense-<id>.jpg`), which 0047's path
check missed. Run `scripts/audit-job-documents.mjs` (dry run
first, then `--commit`) to flag the ~3.9k imported Simpro attachments that show
prices; review the CSV it writes to `scripts/data/`.

**Backflow signature storage (migration `0066`; applied 2026-11-24 through the 0117 catch-up — not before):**
0047's note that `backflow-certificates` has no policy is stale — 0048 added
INSERT for `<deviceId>/signatures/…`, which fixed the web upload. But the mobile
outbox uploads with `upsert: true`, which storage needs SELECT + UPDATE for, so a
technician's signed test from the phone is refused and dead-letters. `0066`
re-creates the bucket's policies by enumeration: signatures only, under an
existing device; SELECT/UPDATE only on a signature you uploaded yourself;
office/admin read and delete everything; anon nothing.
`tests/rls/backflow-certificates.test.ts` proves it on the CI stack. Confirm
on a device that a signed test logged from the mobile app settles.

**Job to-do list (migration `0067`; applied 2026-11-24 in the catch-up — the to-do list never worked in production before it):** office can set
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
`office_jobs` syncs `jobs.*`); regenerate it once `0067` is in production.
The phone's office Schedule tab has the list too (19 Nov 2026 — below).

**To-do list beside the board — drag in and out (19 Nov 2026; no migration; web, and the phone's office Schedule tab).**
Justin: "drag and drop jobs that either weren't ready or jobs that can be done
anytime … Should a job fall over at last minute, we can drag and populate the
schedule from the to-do list. So we need to drag in and out of the to-do list,
but also be able to enter a job into the to-do list to try and limit the amount
of unbilled labour hours."
- **Panel** (`components/schedule/todo-board-panel.tsx`): on the Week and Day
  board, **office/admin only** (`viewerRole`; technicians never see it). Desktop:
  a column right of the board, open by default; under 1024 px: a "To-do list"
  toggle that opens it above the board (and folds it away when a job is picked
  to place). Rows show number/title, customer · suburb, priority, hours
  (estimate, else "PO" hours), days on list, status when not pending; the
  "Fits in [__] h" filter is there too. The old **To-do list tab stays** as it
  was (full-width list with its own Fits-in box and "Schedule" buttons).
- **Drag in** (to-do row → a technician's day or Unassigned; or tap the row's
  pointer icon, then tap a cell — the touch path, like cut & paste; Esc
  cancels). One single-day booking (`planTodoDrop`, `lib/todo-board.ts`): no
  estimate or ≥ 8 h → "All day" 7:00–15:30; a shorter estimate → that many
  hours (rounded up to 15 min) from 7:00, or straight after the technician's
  last booking that day if it ends by 15:30. The drop first asks which cost
  centre the booking is for (see "Bookings always ask for a cost centre");
  multi-day = stretch it with the edge handles afterwards.
  Same guards as every board write: read-only board and closed jobs refused,
  "already booked then — Book anyway?" (`newBookingClashes`), the 0112 leave
  confirm, a pending card until the insert returns, rolled back on refusal
  (0096 etc.). Then ONE jobs write (`jobPatchAfterDrop`): `todo_listed_at`
  cleared — 0067's trigger already clears it when 0079 derives the new
  `scheduled_start`, this also covers a job listed while it had a start — and
  `pending` → `scheduled` (the Schedule dialog's rule; on hold stays on hold).
  Calendar pushed, page refreshed.
- **Drag out** (a booking card → the panel; or double-click to cut it, then
  click the panel). Always confirms, and deletes THAT booking only — never the
  rest of the crew's (`planDragOut`):
  - the job's **last** booking, status pending / scheduled / on hold → "Take
    #123 off Dave's Thursday and put it back on the to-do list?" → delete,
    then one jobs update: listed, and `scheduled` → **`pending`** (the reverse
    of the dialog's pending → scheduled; 0067 refuses to list a scheduled job,
    and an unscheduled job reading "Scheduled" is wrong anyway). 0079 has
    already nulled `scheduled_start` with the delete, so the trigger keeps the
    listing;
  - the job **still has other bookings** → "Take #123 off Dave's Thursday?"
    — only that booking goes; the job stays on the schedule and is NOT listed
    (a job can't be both scheduled and on the list — 0067 would clear it);
  - **in progress** → booking removed, not listed (0067 never lists an
    in-progress job, and changing its status here would hide started work);
  - closed jobs / unsaved bookings → refused.
  No trigger change was needed, so **no migration**.
- **Add job…** search in the panel: in the database as you type (≥ 2 chars or a
  job number), at most 20: pending/on-hold, not listed, no `scheduled_start`,
  every word matching the title or the customer's name/company (customer ids
  resolved first, ≤ 50). Picking one asks the optional estimate, as the job
  page's "Add to to-do list" does. "+ New job" links to New Job. The ✕ on a
  row takes it off the list.
- **Unbooked hours** (`unbookedHours`): each technician's free hours per day =
  8 h − booked hours (never negative; an all-day booking's 8.5 h leaves 0);
  leave is **unavailable, not unbooked** — a full day, or a part day of unknown
  hours, shows no gap; a part day with known hours comes off the 8 h. No gap on
  weekends or past days. Shown as a green "3 h free" in each Week cell and
  under each name in Day view (office/admin only); clicking it sets Fits-in to
  that gap and opens the panel.
- One `DndContext` now wraps the board and the panel; collisions use the
  pointer's own target first (`pointerWithin`), falling back to the nearest.
  The board keeps jobs / bookings / to-do list in local state for optimistic
  updates and re-seeds them from the server after each write
  (`router.refresh()`).
- Tests: `tests/unit/todo-board.test.ts` (25). Checked in Chromium with mock
  data at 1600 px and iPhone size: drag in (placed after the existing booking),
  leave confirm, drag out (last booking and with other bookings), cut → panel,
  add by search, gap → Fits-in, tap-to-place on a phone.
- **On the phone too** (19 Nov 2026; office/admin — the `(office)` route
  group, re-checked with `useIsOfficeOrAdmin`; no migration, no stream change).
  Office Schedule tab (`mobile/app/(office)/schedule.tsx`):
  - **"To-do (N)"** under the header opens `components/schedule/TodoSheet.tsx`
    (a `KeyboardSheet`): rows as on the web (number/title, customer · suburb,
    priority, hours — estimate, else "(PO)" — days on list, status), "Fits in
    [__] h", **Place**, ✕ (confirms, then off the list), and **Add job…** (the
    web's server search, online only) with the optional estimate.
  - **Place = tap-to-place** (dragging out of a sheet is awkward on a phone):
    the sheet closes, a banner says "Tap a technician's day to place #123"
    (Cancel), and the next tap on the Day/Week grid (Day view: a technician's
    row or name) picks technician × day; from List view it switches to Day.
    Same rules as the web drop: `planTodoDrop` (the phone's estimate is
    estimate else PO hours, as the web), closed jobs and a database without
    bookings refused, and it ALWAYS confirms (a tap misses more easily than a
    drag) in a sheet that also asks for the booking's cost centre
    (`components/schedule/PlaceTodoSheet.tsx`), adding "already booked then" (`newBookingClashes`) and the 0112
    leave warning → "Book anyway". Writes through the outbox
    (`ScheduleRepository.placeTodo`): the booking insert, then the
    `jobPatchAfterDrop` jobs update **depending on the insert** (a refused
    booking never leaves a job "scheduled" with nothing booked), then the
    calendar sync. The block shows at once, tagged until the server has it.
  - **"Back to to-do list"** in a booking's menu: `planDragOut` +
    `describeDragOut`, the web's words. `ScheduleRepository.backToTodo`
    deletes THAT booking, and for the last booking queues the listing (and
    scheduled → pending) **after the delete** — 0067 only keeps the listing
    once 0079 has cleared `scheduled_start`.
  - **Free hours**: a green "N h free" under each Week cell (rows grow a
    20 px strip so it never covers a booking) and beside the hours under each
    name in Day view (`unbookedHours`, the grid's own booked hours and the
    online leave); a tap sets Fits-in and opens the sheet.
  - Rules mirrored: `mobile/lib/todoBoard.ts` (identical to `lib/todo-board.ts`
    below the imports) and `mobile/lib/todoList.ts` (identical to
    `lib/todo-list.ts` from the first export), pinned by
    `tests/unit/todo-board-mirror.test.ts` — change the web file first.
    Reads: `mobile/lib/data/reads/todo.ts` (remote, like the rest of the tab;
    PO hours from `purchase_orders_public.total_hours` only, best-effort).
    Tests: `todoBoard.test.ts`, `reads/todo.test.ts`, the to-do block of
    `repositories/schedule.test.ts`. Not yet checked on a device.
  - Listing / unlisting from the phone are outbox writes, so offline they
    wait; the 0067 trigger still decides (a job scheduled meanwhile stays
    unlisted). Reaches phones with the next build (no native module).

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

