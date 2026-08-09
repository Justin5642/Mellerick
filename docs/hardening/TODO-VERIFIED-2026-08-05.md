# Mellerick — verified to-do list

**Repo:** `github.com/Justin5642/Mellerick` @ `ae5287e` (main) — **main has since moved 27 commits; see §2 and §3.0 for what was re-verified against current source**
**Database:** production project `ntdohrsujnyuqyeirqva`, queried live 4–5 Aug 2026
**Supersedes:** `TODO-MASTER.md` (30 July, written against `1ef5e43`) and
`TODO-VERIFIED-2026-08-04.md`

Every status below was established by reading source at `ae5287e`, querying production, or
running the suites. Where a status rests on a document rather than evidence, it says so.
Where only a dashboard or a human decision can settle it, it is marked
`NOT-CHECKABLE-IN-REPO` rather than guessed.

---

## 1. Scoreboard

| | Count |
|---|---|
| Items on the old list | 62 |
| — **DONE** | **9** |
| — PARTIAL | 7 |
| — OPEN | 32 |
| — answered-negative | 1 |
| — NOT-CHECKABLE-IN-REPO | 13 |
| **New findings this review** | **36** (S1–S8, C1–C11, N1–N17) |
| — of those, fixed or drafted | 3 (S1 → PR #14 merged; S2 → `0047` **applied**; N17 → `0048` merged, not applied) |
| Doc claims found false or overstated | 13 |

The old list's header claim — *"0 of the 58 code and infrastructure items are done"* — was
wrong in both directions: 9 are done, and 36 items were missing.

### What was independently re-run

| Check | Handover claim | Observed | |
|---|---|---|---|
| Web unit tests | 203 (26 files) | **208 passed, 27 files** (+5 from the new guard) | ✅ |
| Mobile tests | 458 (69 suites) | **458 passed, 69 suites** | ✅ |
| Web `tsc --noEmit` | clean | exit 0 | ✅ |
| Mobile `tsc --noEmit` | clean | exit 0 | ✅ |
| `npm run lint` | — | 0 errors, 295 pre-existing warnings | ✅ |
| `npm run check:drift` | no drift | **no drift** | ✅ |
| `npm run check:sync` | slot active | **active, `wal_status=reserved`, `behind=0`** | ✅ |

The handover is wrong about several security specifics, but its **test reporting is honest** —
the numbers are not inflated.

### Production ground truth

| Question | Answer |
|---|---|
| `0044` trigger `profiles_role_is_privileged` | present — role escalation genuinely closed |
| `0046` helper `reapply_time_entries_grants` | present |
| **`0035` applied?** | **YES** — `equipment`, `equipment_expenses`, `inventory`, `job_expenses` gated |
| **`0038` applied?** | **YES** — `purchase_orders` locked, both `_public` views exist |
| `has_column_privilege(authenticated, time_entries, rate_override)` | **false** — leak closed |
| `has_table_privilege(authenticated, time_entries, SELECT)` | **false** — `select *` refused |
| Storage buckets | 5, all private |
| **Storage policies scoped by role** | ~~**ZERO**~~ -> **8**, since `0047` was applied 2026-08-05 (see §2) |

---

## 2. In flight

> **UPDATE 2026-08-05 (later).** PRs #14 and #15 are both **MERGED**, and `0047` is now
> **APPLIED TO PRODUCTION**. PRs #16, #18, #19 and #20 have merged since as well. The
> ranked list in §3 is superseded — see §3.0 for what is actually next.

### `0047` — APPLIED to production ✅

Applied 2026-08-05. Pre-state matched the migration's own claim exactly (10 storage
policies, 0 role-scoped, helper absent), and its self-assertions passed — including the
negative control that an ordinary job document is not misclassified as money.

Verified afterwards **by impersonation**, with an office control so the zeros cannot be
mistaken for empty buckets:

| | technician | office |
|---|---|---|
| money job documents | **0** | **3** |
| general job documents | 3,906 | — |
| job photos | 9,722 | — |

The office column is the load-bearing half: without it, "technician sees 0" is equally
consistent with "the boundary works" and "the bucket is empty."

### `0048` — merged, NOT applied · [PR #20](https://github.com/Justin5642/Mellerick/pull/20)

Closes **N17**, and it is the *opposite* of `0047`: not a leak, a **live denial**. No policy
names `backflow-certificates`, so signature upload is refused for every signed-in user —
office included. The web form catches the error, shows "continuing without it", and submits
the compliance test **without the signature the water authority receives**.

Dry-run against production inside `BEGIN … ROLLBACK`, with a negative control:

| Scenario | Result |
|---|---|
| technician uploads a **signature** | ALLOWED ✅ |
| technician forges a **certificate PDF** | DENIED ✅ (path-scoped to `signatures/`) |
| technician reads the bucket | 0 ✅ |
| office reads the bucket | 2 ✅ |

**A bug in its own assertion was caught by that dry run.** The first draft checked `0047`
had survived by counting `qual like '%is_office_or_admin%' >= 8`. Wrong twice: an INSERT
policy stores its expression in `with_check`, not `qual`, so `0047`'s real 8 read as 6 —
and it still went green only because the two policies `0048` itself adds are qual-matching,
pushing 6 back to 8 inside the transaction. It would have passed while measuring the wrong
thing. Now counts both columns and excludes its own policies by name.

### Superseded record — [PR #15](https://github.com/Justin5642/Mellerick/pull/15) as drafted

Drafted **S2** as `0047`. Executed against production inside `BEGIN … ROLLBACK`; all
assertions passed and production verified untouched afterwards.

| Scenario | Before | After |
|---|---|---|
| technician reads expense receipts | 2 | **0** |
| technician reads variation attachments | 1 | **0** |
| technician reads general job documents | 3,906 | 3,906 |
| technician reads job-photos | 9,722 | 9,722 |
| office reads expense receipts | 2 | 2 |

> PR #15's `rls` job passing is **not** evidence for `0047` — that job hand-picks
> `0027`/`0033`/`0034` and never applies it (item 1.14). The dry-run is the evidence.

Both PRs show Vercel red. That is item 5.1 and unrelated — see §7.

---

## 3.0 Do next — RE-VERIFIED 2026-08-05 (later)

The §3 list below was written at `ae5287e`. `main` has since moved 27 commits
(hardening phases 1–4). Each of its top three was re-checked **against current source**,
not assumed:

| Was | Now | Evidence |
|---|---|---|
| 1 — offline geofence arrival discarded | **FIXED** | `mobile/lib/geofenceTransition.ts` exists and routes through the outbox (`deps.clockIn`); its header documents the exact bug |
| 2 — offline departure discards its error | **FIXED** | same module, `geofenceTransition.test.ts` |
| 3 — CI would pass a revert of the role-escalation fix | **FIXED** | `supabase/ci/rls-baseline.sql` deleted, replaced by `seed-roles.sql`; `ci.yml:137` applies the **full** migration history |
| 4 — backflow upload denied | **DRAFTED** as `0048` (PR #20, merged) — needs applying |
| 5 — `0035/0036/0038` say "PROPOSED" | **still open**, all three still carry the marker |

### Actually next

| # | What | Why it ranks here |
|---|---|---|
| 1 | **Apply `0048`** | Backflow signatures are being dropped *today*. Compliance certificates are going to the water authority unsigned, and the only symptom is a toast the technician can dismiss |
| 2 | **Correct the `0035`/`0036`/`0038` headers** | They claim "PROPOSED (not applied)" while production has them. A `db push` applies three "unreviewed" migrations as a side effect (**1.16**) |
| 3 | **`transcribe-voice-report` trusts `recordedBy` from the request body** under service-role (`route.ts:43,50`) — re-confirmed present (**S3**, 1.5) |
| 4 | **Approvals duplicate-invoice guard fails open** — `approvals/page.tsx:77` `.maybeSingle()` — re-confirmed present (1.6) |
| 5 | **No OAuth `state` parameter** in either flow, and `escapeHtml` is still unused in both send routes (1.1, 1.7) |

Suites on current `main`: web **237 passed / 27 files**, mobile **490 / 71 suites**, both
typechecks clean. (The §1 scoreboard's 208/458 predates the hardening phases.)

---

## 3. Do next — ranked *(superseded by §3.0)*

| # | What | Where | Why it ranks here |
|---|---|---|---|
| 1 | **Offline geofence arrival is discarded** — the visit's clock-in never exists | `mobile/lib/location-tracking.tsx:195, 226-229` | Unpaid labour. No error, no badge, never re-derived. The file's own comment at `:182-185` argues against exactly this |
| 2 | **Offline departure discards its error** — entry never closes, `hours` writes NULL | `mobile/lib/location-tracking.tsx:266` | Unpaid stint, same cursor trap |
| 3 | **CI would pass a revert of the role-escalation fix** | `supabase/ci/rls-baseline.sql:19` + `ci.yml:127-130` | CI holds the *vulnerable* policy and none of `0044`/`0045`/`0046`. The 5 SQL security tests run in no runner |
| 4 | **Backflow signature upload is denied by RLS today** | no policy for `backflow-certificates` | Live silent failure (**N17**) |
| 5 | **`0035`/`0036`/`0038` still say "PROPOSED (not applied)"** though production has them | migration headers | Any `db push`/`db reset` now applies three "unreviewed" migrations as a side effect (**1.16**) |

---

## 4. Band 0 — contractual risk

**3 DONE · 1 PARTIAL · 2 OPEN**

| ID | Status | Evidence |
|---|---|---|
| 0.1 | **DONE** | Production queried 5 Aug: `0035` and `0038` are both live. The question this item existed to settle is answered |
| 0.2 | **DONE** | `0044:102` `if coalesce(auth.role(),'') <> 'service_role' and not is_admin(auth.uid())`; `:113` trigger; `:125` `with check`. Trigger confirmed present in production |
| 0.3 | OPEN | `supabase/ci/rls-baseline.sql:19` still creates `for update using (auth.uid() = id)` with no `WITH CHECK`; same at `supabase/schema.sql:27` |
| 0.4 | PARTIAL | `supabase/tests/0044_role_escalation_test.sql:44` exists but **no runner executes it**. `tests/unit/staff-routes-auth.test.ts:142` covers the API route, mocked — not the PostgREST/RLS path |
| 0.5 | OPEN | `tests/rls/financial-tables.test.ts:28` `expect(data ?? []).toHaveLength(0)` with no seeding — passes whether or not the policy exists |
| 0.6 | **DONE** | Nothing to apply — both migrations confirmed live |

## 5. Band 1 — high

**2 DONE · 14 OPEN**

| ID | Status | Evidence |
|---|---|---|
| 1.1 | OPEN | No `state` in either OAuth flow. `lib/xero.ts` grep for `state`: no matches; `lib/google.ts:19-23` `generateAuthUrl({access_type,prompt,scope})`. Both rely solely on `requireAdmin` at the callback |
| 1.2 | OPEN | `xero/callback` and `google/callback` both `.delete().neq(...)` then `.insert(...)`. Neither result is checked — a failed **insert** also leaves no connection, and the route still redirects `?xero=connected` |
| 1.3 | OPEN | `0000_baseline.sql:131` `for all using (auth.role() = 'authenticated')` on `jobs`; same at `:63`, `:83`, `:165`, `:425`, `:436`, `0021:47,92`, `0016:71`, `0017:35` |
| 1.4 | OPEN | `0000_baseline.sql:364` `job_id ... on delete cascade`. No `drop constraint` anywhere. Blocked on 6.3 |
| **1.5** | OPEN | `transcribe-voice-report/route.ts:92-100` writes any `jobs` row under service-role with no membership check; `:50` trusts `recordedBy` from the body. See **S3** |
| 1.6 | OPEN | `app/dashboard/approvals/page.tsx:73` `.maybeSingle()` fail-open duplicate-invoice guard |
| 1.7 | OPEN | `escapeHtml` exists in `lib/html.ts`, used in neither send route |
| 1.8 | OPEN | `team-schedule-view.tsx:415-426` and `:479-493` — success branch is `toast.success` only; no `sync-calendar` call |
| 1.9 | OPEN | `invoices/page.tsx:15` and `reports/page.tsx:23-26,:44,:69` unranged `.select()` |
| **1.10** | OPEN | `PowerSyncProvider.tsx:84` sets `connectedRole.current = role` **before** `:88 waitForFirstSync()`; guard at `:89` gates only `setLocalReads`. A `TOKEN_REFRESHED` mid-sync leaves the local-reads seam unregistered **permanently** for that app session |
| 1.11 | OPEN | `auth-context.tsx:35-37` discards `_event`; `:51` `setLoading(true)`; `_layout.tsx:57-63` replaces the whole `<Stack>`. Makes 1.10 routine |
| 1.12 | **DONE** | `outbox.ts:188` `// PER-ROW FIFO`, `:217` `oldestOutstandingByRow`. Solved in `nextReady()`, not by the prescribed mechanism. Documented trade-off `:201-203`: ordering is **not** preserved across a dead-letter |
| 1.13 | **DONE** | `ci.yml:44-58` `mobile:` job runs `npm ci`, `tsc --noEmit`, `npm test` |
| 1.14 | OPEN | `ci.yml:127-130` applies 3 of 47 migrations |
| 1.15 | OPEN | `tests/rls/financial-tables.test.ts:22` covers only `invoices, quotes, pricing_items` |
| 1.16 | OPEN | `0035:5`, `0036:1`, `0038:4` all still declare PROPOSED — now **factually false** |

## 6. Band 2 — medium

**0 DONE · 17 OPEN · 4 PARTIAL · 1 answered**

| ID | Status | Evidence |
|---|---|---|
| 2.1 | OPEN | `invoices/new/page.tsx:302-304` client float math stored unrounded; same `invoices/[id]/edit:82-84,99`, `quotes/new:76-78,96`. Only server-side rounding in the tree is `0028:77` |
| 2.2 | OPEN | `invoices/new/page.tsx:326,:339,:343` unchecked writes after a checked parent insert |
| 2.3 | OPEN | `invoices/[id]/edit/page.tsx:103` delete → `:106` insert → `:115` success toast, no error check |
| 2.4 | OPEN | No `check (clock_out > clock_in)` in any migration; no non-negative checks |
| 2.5 | PARTIAL | `hours` still client-computed (`job-time.tsx:193,:235`). New `lib/time-entry-hours.ts` writes `null` for implausible durations — a mitigation, not the decision. Blocks on 6.4 |
| 2.6 | PARTIAL | **Fixed in PR #14** for `job-time.tsx` (all four sites). Other swallowed-error sites remain — see C2, C5 |
| 2.7 | OPEN | `gateway.supabase.ts:31-37` checks only `error`; a 0-row RLS-denied write is marked done. See **N11** for a second path in the same file |
| **2.8** | OPEN | `processor.ts:36-44` has no liveness check in the drain loop, and `Processor` has **no `stop()` at all** (`:13`). `HANDOVER.md:182-186` claims otherwise — both `syncEngine.ts` checks sit outside `processor.drain()`. `DataProvider.tsx:23` returns the cached store, so a remount gives a second Processor over it |
| 2.9 | OPEN | Zero `AbortController`/`timeout` in all of `mobile/lib` and `mobile/app` |
| 2.10 | OPEN | `outbox.ts:112` charges an attempt per reclaimed-inflight op; `processor.ts:29` checks connectivity once per drain |
| 2.11 | PARTIAL | Pruning done (`outbox.ts:271`, called `processor.ts:54`). Indexed queries not: `:185` `store.all()` inside `nextReady()` → `SELECT *` + per-row `JSON.parse`, once per operation |
| 2.12 | OPEN | Narrower than stated — the `status IN (...)` filter already existed at `1ef5e43`. Residual race: `processor.ts:36-37` captures `op` then awaits `markInflight`; an `enqueue` in that window is retired undispatched |
| 2.13 | OPEN | `reads/source.ts:103-106` gates on `hasSynced` only. `lastSyncedAt` captured in `powersyncStatus.ts:10,17,30,36`, never consumed. The `"stale-db"` reason added guards the *teardown* race, not clock staleness |
| 2.14 | PARTIAL | Orphan reclamation added; but `outbox.ts:298-306` keeps dead ops' files **by design** (`processor.test.ts:297`). Re-scoped, not fixed. See **N12** |
| 2.15 | OPEN | `mobile/lib/supabase.ts:18` `storage: AsyncStorage`. File was touched (+8) only to add `assertMobileEnv` |
| 2.16 | OPEN | `mobile/powersync/db.ts:9-12` no `encryptionKey` |
| 2.17 | **PARTIAL — PR #15** | `0047` closes the money half (`equipment-documents` wholesale, `job-documents` by path). Per-job DELETE on `job-photos`/`job-audio` deliberately deferred; proposal in the migration footer |
| 2.18 | OPEN | Four inline service-role clients: `transcribe-voice-report:13`, `staff/invite:29`, `staff/resend-invite:27`, `staff/update:28` |
| 2.19 | OPEN | No `middleware.ts` anywhere |
| 2.20 | OPEN | `app/dashboard/layout.tsx:9` checks only for a user; `role` fetched but used only for the sidebar |
| 2.21 | OPEN | `supabase/schema.sql:28-30` still carries the recursive policy `0010` fixed; missing 4 tables, `time_entries.notes` **and `hours`**. See **N16** |
| 2.22 | OPEN | 24 unwrapped `is_office_or_admin(auth.uid())` call sites; the new `0042:50` reproduces it |
| 2.23 | OPEN | All six FK indexes still missing |
| 2.24 | PARTIAL | Covers 33 tables, catches shorthand properties. Still no `.select()` lists, no `.rpc()`, no views, no `drop column`; 400-char window. **The mobile SQLite read path is entirely outside the net** — local reads are raw SQL constants (`reads/jobs.ts:126`), never parsed |
| 2.25 | **ANSWERED — negative** | `rate_override` is written in exactly one place (`time-entry-edit-dialog.tsx:139`), from the browser session client where `is_admin()` resolves. No such bug. Nothing records this |

## 7. Band 3 — low

**1 DONE · 18 OPEN**

| ID | Status | Evidence |
|---|---|---|
| 3.1 | OPEN | `key={index}` at `invoices/new:501`, `invoices/[id]/edit:175`, `quotes/new:180`, `quotes/[id]/edit:163`, `backflow/[id]/test/new:307`, `job-po.tsx:439` |
| 3.2 | OPEN | `expired` quote status coloured and counted, set by nothing |
| 3.3 | OPEN | 173 `: any`; no `database.types.ts`; no `gen:types` script |
| 3.4 | OPEN | `guards.ts:90` and `send-push/index.ts:28` use `===`. `timingSafeEqual`: zero hits |
| 3.5 | OPEN | No security headers from `next.config.ts`, `vercel.json` or middleware |
| 3.6 | OPEN | 775 / 541 / 503 / 438 LOC — unchanged |
| 3.7 | OPEN | `loadLogo()` duplicated in `lib/pdf/render.ts:8` and `render-backflow.ts:8` |
| 3.8 | OPEN | `reports/page.tsx:36,:44,:123` sequential awaits with no data dependency |
| 3.9 | OPEN | `xero/callback/route.ts:20` raw `fetch`, no signal |
| 3.10 | OPEN | `geocode/route.ts:11` per-instance `Map`. See also **C8** |
| 3.11 | OPEN | `send-push/index.ts:20` no top-level try/catch |
| **3.12** | OPEN | Four security-definer views unscoped (`0028:110`, `0038:44,:48`). Money columns excluded; **row enumeration open** |
| 3.13 | **DONE** | `sync-streams.yaml:59-67,:69-80` explicit columns, enforced by `sync-streams-contract.test.ts` |
| 3.14 | OPEN | `03-technician-money-gating.yaml:56,80,82,84` regex misses `1,240.00 AUD` and `$ 12` |
| 3.15 | OPEN | See **N3** — `mobile/` has no lint tooling at all to attach a rule to |
| 3.16 | OPEN (decision) | `backflow/tests/[id]/certificate/route.ts:17-18` `requireUser` only. See **S8-adjacent** |
| 3.17 | OPEN | `dashboard/page.tsx:61` `user!.id` |
| 3.18 | OPEN | `tests/e2e/smoke.spec.ts` — 18 lines, 2 tests |
| 3.19 | OPEN | Actions pinned by tag; `npm run build` runs twice (`ci.yml:69` and `:179`) |

## 8. Band 4 — ship the apps

| ID | Status | Note |
|---|---|---|
| 4.1 | NOT-CHECKABLE | D-U-N-S. A Team ID in `eas.json` is not proof of enrolment |
| 4.2 | NOT-CHECKABLE | Paid vs free Apple account — developer.apple.com only |
| 4.3 | NOT-CHECKABLE | Google Play Console |
| 4.4 | NOT-CHECKABLE | expo.dev EAS build dashboard |
| 4.5a | **DONE** | `mobile/eas.json:41` `"appleTeamId": "864FRPRM47"` |
| 4.5b | OPEN | `:39` `"appleId": "APPLE_ID_EMAIL_HERE"`, `:40` `"ascAppId": "APP_STORE_CONNECT_APP_ID_HERE"` |
| 4.6 | OPEN (repo) / NOT-CHECKABLE (creds) | Code present; credential files absent. See **N4** |
| 4.7 | NOT-CHECKABLE | `mobile/assets/` has icons only; store assets live in OneDrive |
| **4.8** | OPEN — **config is the opposite of the recommendation** | `app.json:78-80,:97,:120-121` — background "always" fully enabled. Needs your sign-off before submission. See also **C3** |
| 4.9 | DONE (repo) / NOT-CHECKABLE (EAS) | No keystore in tree; `.gitignore:47` covers it |

## 9. Band 5 — infrastructure

| ID | Status | Note |
|---|---|---|
| **5.1** | NOT-CHECKABLE-IN-REPO | Vercel Preview env vars. 73 consecutive Preview failures vs 26/26 Production successes. Proven not-code: GitHub's `build` job runs the identical `next build` on the same commit and passes. **Untick "Sensitive" if badged** — sensitive vars are runtime-only and undefined at build. Diff the whole Preview list against Production, or fixing the two public ones turns the build green and 500s at runtime |
| 5.2 | NOT-CHECKABLE | Branch protection on `main` — it auto-deploys to production |
| 5.3 | NOT-CHECKABLE | Staging environment |
| 5.4 | premise VERIFIED | `0040:31-34` deliberately no backfill; `:36` `default false`. Office staff need telling |

## 10. Band 6 — open decisions

| ID | Status | Note |
|---|---|---|
| 6.1 | OPEN | `sites` has no `is_active` in any of the 47 migrations. Needs a decision about jobs at a deactivated site |
| 6.2 | **DONE / SUPERSEDED** | Premise now factually wrong: `submit/route.ts:55-56` short-circuits on `submitted_to_water_authority_at`, `:66` gates re-send to office/admin, and `repositories/backflow.ts:110` `logTest` is already outbox-durable |
| 6.3 | OPEN | `0000_baseline.sql:364` cascade intact. Blocks 1.4 |
| 6.4 | OPEN | `0043:42` `hours numeric(6,2)` — not dropped, **not** generated. Blocks 2.5 |

---

## 11. New findings — security (S)

| | Severity | Finding |
|---|---|---|
| **S1** | **FIXED — PR #14** | `select *` on `time_entries` refused by production under `0045`'s column grants; four call sites discarded the error, so web clock-in silently recorded nothing |
| **S2** | **APPLIED to production 2026-08-05** | Zero storage policies scoped by role. Technicians could read/delete expense receipts and supplier invoices. Confirmed with data: 2 + 1 rows. `0047` applied; re-verified by impersonation — technician money documents **2 -> 0**, office control still **3**, general documents 3,906 and photos 9,722 unchanged |
| **S3** | MEDIUM-HIGH | IDOR on `transcribe-voice-report` (`:34-37,:61-65,:92-100`). Any authenticated user can overwrite any job's voice report and attribute it to anyone. `job-authz.ts` already exports `canManageJobBilling`; the sibling `sync-calendar` route uses it. `storage-routes-auth.test.ts:117` comments `// THE IDOR` but tests the *path* check, not job ownership |
| **S4** | MEDIUM | `0037:38-45` — any authenticated user can permanently delete any job's photos and audio. Deferred by `0047` |
| **S5** | MEDIUM | `sync-streams-contract.test.ts:39` `MONEY_COLUMN` uses `\b` anchors, so `\brate\b` misses `rate_override`, `\bprice\b` misses `unit_price`. **Adding `rate_override` to `tech_time_entries` would pass this test green** |
| **S6** | MEDIUM | All 18 `office_*` streams use `SELECT <table>.*` and the contract test exempts them by construction. Bounded — `0044` blocks self-promotion — but any new column replicates unreviewed to office devices in plaintext SQLite (PowerSync bypasses RLS *and* `0045`'s grants) |
| **S7** | LOW | `0046:34-39` `reapply_time_entries_grants()` is PUBLIC-executable SECURITY DEFINER DDL. Cannot escalate (inputs are catalog-derived and `quote_ident`-escaped); impact is catalog churn |
| **S8** | LOW | `job-documents` and `backflow-certificates` have no bucket definition in the repo. Resolved by live query — see N17. Both buckets confirmed private; `backflow-certificates` holds 1 object |

## 12. New findings — correctness (C)

| | Severity | Finding |
|---|---|---|
| **C1** | **CRITICAL** | Offline geofence **arrival** discarded. `location-tracking.tsx:195` advances the cursor, `:226-229` returns on `openError` without enqueueing. Never re-derived. Contradicts the file's own `:182-185` |
| **C2** | **CRITICAL** | Offline **departure** discards its error (`:266`). Entry never closes; `hours` later writes NULL. `reads/noSwallowedErrors.test.ts:26` scopes itself to `reads/` only, so it cannot see this |
| **C3** | HIGH | Background auto-clock **can never record a travel leg** — two independent structural reasons (`backgroundClockTask.ts:111` + `geofenceState.ts:82-93`; and `:69-70` computing `hours` from identical timestamps). Contradicts `backgroundClockTask.ts:18-22` |
| **C4** | HIGH | `backgroundSync.ts:1-2` static-imports `expo-background-fetch`/`expo-task-manager`, reintroducing the red-screen crash `backgroundClockTask.ts:152-158` documents and `backgroundClockTask.guard.test.ts` pins |
| **C5** | HIGH | `labour-billing-sync.ts:123` still discards errors 50 lines below the fix. An apprentice re-prices at the qualified rate. The new test's fixture structurally cannot reach it |
| **C6** | MEDIUM | `retryDead()` can strand a write whose completed dependency was pruned (`outbox.ts:275,:148,:215`) |
| **C7** | MEDIUM | `push-invoice/route.ts:119` reports success with no link if Xero returns no invoice → next push duplicates. Unguarded assumption, not a proven live defect |
| **C8** | MEDIUM | `geocode/route.ts:14-16` — the last remaining device-clock stall site. All other candidates fail safe |
| **C9** | MEDIUM, unverified | `mobile/lib/supabase.ts:11` passes the `process.env` object; Expo's inliner only rewrites static `EXPO_PUBLIC_*` member expressions. **Settle with `cd mobile && npx expo start`** |
| **C10** | LOW | Per-row FIFO keyed on `createdAt` *value* (`outbox.ts:217`) — same-millisecond ops defeat it |
| **C11** | LOW | `flush()` no-ops when a drain is in flight, then fires `onSettled` anyway |

## 13. New findings — process and hygiene (N)

| | Finding |
|---|---|
| **N1/S6** | 18 `office_*` streams use `SELECT *`; contract test exempts them |
| **N2** | The old list's header was materially false |
| **N3** | `mobile/` has **no lint tooling at all** — no config, no script. Item 3.15 has nothing to attach to, and mobile gets zero lint coverage in CI |
| **N4** | `mobile/eas.json:44` `serviceAccountKeyPath` points at a file that does not exist — `eas submit --platform android` fails on it |
| **N5** | Money-boundary effort went to columns, not rows — the four `0028`/`0038` views were never revisited |
| **N6** | **CI reproduces the hole `0044` closes.** A commit reverting `0044` would pass every check |
| **N7** | The five `supabase/tests/*.sql` files are executed by **no runner** — not `ci.yml`, no npm script, and `vitest.config.ts:44,53` are TS-only globs |
| **N8** | `0046` depends on a manual `select reapply_time_entries_grants();` with nothing enforcing it |
| **N9** | `0035`/`0036`/`0038` are buried mid-chain, so 1.16 is now a precondition for running the migration tool safely |
| **N10** | 1.2 understates the token-swap defect — a failed *insert* also leaves no connection, and the route still says connected |
| **N11** | `gateway.supabase.ts:112-115` — an unattributable `23505` is marked done and the row discarded. A second silent-loss path |
| **N12** | `dead` outbox rows and their attachment files have **no upper bound** |
| **N13** | Drift guard says "~600 chars" (`:128`), uses 400 (`:135`) |
| **N14** | Drift guard's payload regex truncates at the first `}` |
| **N15** | New migrations reproduce the 2.22 unwrapped-helper pattern |
| **N16** | `schema.sql` also omits `time_entries.hours` — reading it as canonical makes 2.5 look resolved |
| **N17** | **`backflow-certificates` has no storage policy while RLS is enabled** — the browser signature upload is denied today. The one object came from the service-role route |

---

## 14. Doc claims found false or overstated

| Claim | Verdict |
|---|---|
| `0045:36` "no query does `select *` on time_entries" | **FALSE** — six call sites |
| `0045:34` "NO application code reads rate_override" | **FALSE** — four sites |
| `0045:37` "`return=minimal`, so no post-write representation selects it" | **FALSE** for clock-in/out and the edit dialog |
| `HANDOVER.md:182-186` "`stop()` bumps a generation counter" fixes the drain | **FALSE** — `Processor` has no `stop()`; both checks sit outside `drain()` |
| `HANDOVER.md:151-154` "no screen writes to Supabase directly" | **FALSE** for the payroll path — `backgroundClockTask.ts:39,72,100` |
| `HANDOVER.md:570-582` background tracking "implemented" | **OVERSTATED** — travel legs structurally cannot be written (C3) |
| `HANDOVER.md:189` device-clock "both now fixed" | **INCOMPLETE** — C8 |
| `0035:58` "equipment_documents carry no money columns" | **Technically true, materially false** — the *files* are receipts |
| `service-role-routes-auth.test.ts:5-6` "all four correctly guarded" | **OVERSTATED** — covers 3, excludes `transcribe-voice-report` |
| commit `617f1b4` "stop discarding errors across every read module" | **True as scoped** — but scans only `reads/`; C2 and C5 sit outside |
| commit `a59081a` "two silent failures" | **INCOMPLETE** — a third remains in the same function |
| commit `f88402a` offline-arrival loss fixed | **NOT CLOSED** — the write is durable, the read gate is not (C1) |
| `TODO-MASTER.md` header "0 of 58 done" | **FALSE** — 9 done |

**Confirmed TRUE** (checked independently, recorded so it is not re-litigated): all 11
technician sync streams are money-free; `hoursBetween()` returns null when the end is not
after the start; the handover's test counts.

---

## 15. Test quality

**Sound:** `time-entry-hours`, `xero-invoice-link`, `sync-health-verdict`,
`sync-streams-contract`, `backgroundClockTask.guard`, the `outbox` per-row-ordering block,
and the new `time-entry-columns` guard.

**Weak — do not read green as safe:**

| Test | Why |
|---|---|
| `tests/rls/financial-tables.test.ts` | Unseeded; trivially true (0.5) |
| `backgroundClockPlan.test.ts:63` | Asserts the only travel case that can never produce hours |
| `env.test.ts` | Never touches the real call site (C9) |
| `labour-billing-sync-errors.test.ts` | Fixture structurally cannot reach the remaining bug (C5) |
| `storage-routes-auth.test.ts:117` | Comments `// THE IDOR`, tests the wrong half (S3) |
| `sync-streams-contract.test.ts:39` | Word-boundary regex misses every snake_case money column (S5) |

---

## 16. Standing rule this codebase keeps re-learning

Three of the worst defects here — the `0034` no-op, the `ready_to_invoice` schema drift, and
the `0045` clock-in outage — share one shape: **the check and the thing being checked were
not the same thing.** A migration that reported success without running. A mocked test that
returned rows for a query the database refuses. A CI database rebuilt from the same
migrations it was meant to validate.

`money_boundary_sweep.sql:37-40` already says it: *"an empty table proves nothing here."*
The knowledge is written down. The automation is not — see **N7**.
