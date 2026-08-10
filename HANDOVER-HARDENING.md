# Hardening programme — handover

**Written:** 6 August 2026
**Baseline:** `main` @ `52a5bc2` (merge of PR #18)
**Predecessors:** `HANDOVER.md` (product), `DECISIONS-FOR-AVI.md` (rationale)
**Supporting docs:** [`docs/hardening/`](docs/hardening/) — full verified to-do list, programme plan, open decisions

This document exists so the next session can continue **without re-deriving state and
without repeating work**. Everything below was verified by running it, not recalled. Where a
fact could go stale, the command to re-check it is given.

---

## 0. READ THIS FIRST — the thing most likely to bite you

**Migration `0047` is merged to `main` and is NOT applied to production. The storage leak it
fixes is live right now.**

Verified 6 Aug 2026:

```
supabase_migrations.schema_migrations: 47 rows, last version = 0046
storage policies scoped by role:       0
technician-readable expense receipts:  2
```

Merging a migration does not run it. This repo has been bitten by the same gap twice before
(`0034` reported success while achieving nothing; `0040` shipped after nine call sites had
referenced a column that existed nowhere). **`0047` is the third instance and it is open.**

Re-check before assuming anything:

```bash
npx supabase db query --linked --file supabase/tests/0047_storage_boundary_test.sql
```

`technician reads job expense receipts` returning **2 rows** means still leaking. **0 rows**
means someone applied it.

---

## 1. Verified state

### Merged and live in production

| PR | What | Effect |
|---|---|---|
| [#14](https://github.com/Justin5642/Mellerick/pull/14) | `select("*")` on `time_entries` → explicit columns | **Web clock-in works again.** It had been silently recording nothing since `0045` landed |
| [#16](https://github.com/Justin5642/Mellerick/pull/16) | Hardening phases 1–3 | Offline auto-clock no longer loses shifts; CI can catch a security revert; travel legs record; apprentice labour prices correctly |
| [#18](https://github.com/Justin5642/Mellerick/pull/18) | Hardening phase 4 | Seven offline-engine defects |

### Merged but NOT applied

| PR | What | Status |
|---|---|---|
| [#15](https://github.com/Justin5642/Mellerick/pull/15) | `0047` storage policy scoping | **In `main`, absent from production.** See §0 |

### Test baseline — reproduce these numbers before changing anything

```bash
npm test          # web:    237 tests, 27 files
cd mobile && npm test   # mobile: 490 tests, 71 suites
npx tsc --noEmit  # both projects clean
npm run lint      # 0 errors (295 pre-existing warnings)
```

If your numbers are lower, you are not on `52a5bc2` or later.

### CI now actually gates security

The `rls` job was rebuilt. It applies **all 47 migrations**, seeds one user per role plus
money in the money tables, and runs all five `supabase/tests/*.sql` files, which raise on
failure.

**Proven by negative control**, not asserted: a throwaway branch reverting `0044`'s trigger
to `if false then` produced

```
technician self-promotes | BLOCKED | ALLOWED | *** FAIL ***
ERROR: 1 scenario(s) FAILED — profiles.role is not properly protected
```

while `unit` and `mobile` still passed. Before this work, that revert passed every check.

---

## 2. What was fixed, by defect class

Grouped because the *pattern* matters more than the list — see §5.

### Writes that silently never happened

| ID | Defect |
|---|---|
| C1 | Offline geofence **arrival** discarded: cursor advanced before async work, then bailed on the offline read. Visit's clock-in never existed, never re-derived |
| C2 | Offline **departure** destructured its error away: entry never closed, `hours` later wrote NULL |
| S1 | `select("*")` refused by `0045`'s column grants; four call sites discarded the error, so web clock-in reported success and recorded nothing |
| 2.7 | `updateRow` checked only `error`; PostgREST returns none for a zero-row UPDATE, so RLS-denied edits vanished |
| C5 | `syncJobBilling`'s **second** `Promise.all` still discarded errors — apprentice labour re-priced at the qualified rate on customer invoices |

### Features that could never work

| ID | Defect |
|---|---|
| C3 | Background auto-clock **structurally could not** write a travel leg — two independent causes |
| N18 | Foreground and background disagreed on `auto_clocked` for the same event |

### Infrastructure that could not detect a regression

| ID | Defect |
|---|---|
| N6 / 0.3 | CI seeded from a fixture that **recreated** the role-escalation hole `0044` closes |
| 1.14 | CI applied 3 of 47 migrations |
| N7 | Five SQL security tests run by **nothing** — and four of them were **non-functional** (two `profiles_pkey` collisions, one missing semicolon, one operator-precedence bug making a WHERE clause non-boolean) |
| 0.5 | RLS tests asserted `toHaveLength(0)` against tables never seeded — green with the policies deleted |
| S5 | Money-column detector used `\b` anchors, so it missed `rate_override` — the exact column `0045` hides |

### Robustness

| ID | Defect |
|---|---|
| C4 | Static native import reintroduced a documented full-app red-screen crash |
| C6 | `retryDead()` could strand a write forever once its dependency was pruned |
| C10 | Per-row FIFO defeated by two writes sharing a millisecond |
| C11 | A drain requested mid-pass was dropped |
| 2.9 | No timeout: one hung request stalled the entire queue |
| 2.8 | `Processor` had **no `stop()`** — which `HANDOVER.md:182-186` claims was fixed |
| 1.10 / 1.11 | Local-reads seam could be lost **permanently** for an app session, triggered by an hourly token refresh |

---

## 3. What remains

**Re-verified:** 10 August 2026 against `main` @ `381ba5b` (merge of PR #25), reading every file with `git show 381ba5b:<path>` rather than from the working tree. Supersedes the 2026-08-05 list in [`docs/hardening/TODO-VERIFIED-2026-08-05.md`](docs/hardening/TODO-VERIFIED-2026-08-05.md), which is stale in both directions.

**Two corrections to this document's own framing before the list:**

- **§0 is stale.** `0047`'s header on `main` now reads `-- STATUS: APPLIED AND VERIFIED IN PRODUCTION (2026-08-05).`, as does `0048`'s. The unapplied migration today is **`0049`** (`-- STATUS: DRAFT — NOT APPLIED.`). Headers are now guarded — `tests/unit/migration-header-truth.test.ts` pins the claim-detection and `npm run check:migrations` queries the ledger — but that test says outright it *cannot* ask production. Confirm with the §7 command before trusting either header.
- **The working tree is not `main`.** `git branch --show-current` returns `fix/oauth-token-swap`, HEAD `9f0bf9f`, one commit ahead of `381ba5b` and pushed but unmerged. That commit is a complete, tested fix for **1.2**. Anyone assessing item 1.2 by reading files on disk will see it as done; it is not on `main`. See 1.2 below.

---

### 3.1 ALREADY DONE — do not redo

Every wrong entry here costs someone a day of rediscovery. Each verified against `381ba5b` this session.

| ID | What closed it | Guard |
|---|---|---|
| **S3 / 1.5** | `transcribe-voice-report/route.ts:25` `getCallerId`, `:68` `canManageJobBilling`, `:41` comment *"`recordedBy` is deliberately NOT read from the body"*, `:106` `voice_report_recorded_by: callerId` | `tests/unit/transcribe-voice-report-auth.test.ts` |
| **1.1** | `lib/oauth-state.ts` exists **and is wired into all four routes** — `{google,xero}/auth` mint + set the HttpOnly cookie (`:17-19`, `:17-22`), `{google,xero}/callback` refuse on mismatch before any token exchange (`:20-21`, `:21-22`) | `tests/unit/oauth-state.test.ts` |
| **1.6** | `lib/approval-invoice-guard.ts` → `resolveExistingInvoice`, and `approvals/page.tsx:79-86` actually **gates on it** (`if (!guard.proceed) { toast.error(...); return; }`), not merely imports it | `tests/unit/approval-invoice-guard.test.ts` |
| **1.7** | `escapeHtml` imported and applied in both send routes — `invoices/[id]/send:9,62,74,75` and `quotes/[id]/send:8,59,71,72` | `tests/unit/send-route-escaping.test.ts` (a source scanner, so it survives refactors) |
| **1.16** | `0035`/`0036`/`0038` headers now read `✅ APPLIED AND VERIFIED IN PRODUCTION`. Was ranked #2 in the old list's "actually next" | `tests/unit/migration-header-truth.test.ts` + `npm run check:migrations` |
| **2.6** *(partial)* | Beyond `job-time.tsx`: `time-entry-edit-dialog.tsx:158-199` (insert/update/delete all checked, incl. the 2.7 zero-row case), `job-photos.tsx:62-106` (row-first delete with `count: "exact"`), `push-invoice/route.ts:116-140` (3-attempt link retry + `requiresManualReconciliation`), `labour-billing-sync.ts:58` `requireRead()` | `xero-invoice-link.test.ts`, `labour-billing-sync-errors.test.ts`, `time-entry-columns.test.ts` — site-specific, no class-level guard |
| **3.13** | `sync-streams.yaml:59-80` explicit columns | `sync-streams-contract.test.ts` (carried forward from the 05-08 list; not re-run this session) |
| **N15** | **Stale, strike it.** "New migrations keep reproducing the unwrapped-helper pattern" stopped being true after `0042`: `0044`, `0047`, `0048`, `0049` all use `(select is_office_or_admin(...))` | **None.** This rests entirely on author discipline and can regress silently |

---

### 3.2 STILL OPEN, ranked by what it costs if left

| # | ID | Defect | Severity | Fix size |
|---|---|---|---|---|
| 1 | **2.3** | `invoices/[id]/edit/page.tsx:94-115` updates totals, **deletes every line item** (`:103`), re-inserts (`:106`) — no error bound on any of the three, no transaction — then `toast.success("Invoice updated")` at `:115` and navigates away. A refused insert destroys a customer invoice's lines permanently while reporting success. `quotes/[id]/edit/page.tsx:93-113` is byte-for-byte the same. | **HIGH** — destroys data that already exists and may already have been sent | 0.5–1 day (one server-side transactional route; error checks alone still leave the delete-committed window) |
| 2 | **2.6 (push-expense)** | `app/api/xero/push-expense/route.ts:70-73` discarded the `xero_bill_id` link write that its own dedupe guard at `:32` depends on. This is verbatim the defect `push-invoice/route.ts:100-110` documents as *having already shipped a duplicate customer invoice*; here it duplicates an **AUTHORISED creditor bill**. Sibling route was hardened, this one was not. | **HIGH** — money leaves the business | **FIXED, awaiting merge.** `fix/oauth-token-swap` @ `f1f04ab` — the sibling's retry-and-refuse block plus `tests/unit/xero-bill-link.test.ts`. Observed failing first (`expected 200 to be >= 400`, body `{"success":true,…}`) and negative-controlled. Like 1.2, this needs a merge decision, not an implementation |
| 3 | **1.9** | `reports/page.tsx` fires nine unranged `.select()`s (`:23,:24,:25,:26,:44,:69,:70,:71,:123`). `supabase/config.toml:18` `max_rows = 1000`; PostgREST truncates at the cap with **no error**. `:25` already pulls all 827 jobs; `:71` pulls 12 months of work `time_entries`. Revenue by month, outstanding, top customers and staff utilisation may be computing from truncated data **today** and presenting it as authoritative. `invoices/page.tsx:15,16,21` and `quotes/page.tsx:11` are payload problems for now. | **HIGH** for reports, MEDIUM for the two list pages | Small for lists (copy `.range()` from `customers/page.tsx:37`); moderate for reports — aggregates must move into SQL, pagination is the wrong tool for a sum |
| 4 | **1.2** | `xero/callback:40-50` and `google/callback:44-53` delete-then-insert with neither result destructured; supabase-js resolves `{data,error}` and does not throw, so the `try/catch` never fires and the route redirects `?xero=connected` over an empty table. Xero then dies loudly (`lib/xero.ts:79 throw`), Google dies **silently** (`lib/google.ts:41` returns null; callers are documented to treat null as "skip calendar sync"). | **HIGH** for business continuity (not confidentiality — `requireAdmin` + 1.1's state check hold) | **ZERO developer time. The fix is written.** `fix/oauth-token-swap` @ `9f0bf9f` adds insert-first `lib/oauth-token-store.ts` + 6 tests, wired into both callbacks, negative-controlled. It needs a **merge decision**, not an implementation. Do not write a third version |
| 5 | **2.2** | `invoices/new/page.tsx` checks the parent insert at `:322` then leaves three children unchecked — `:326` `invoice_items`, `:339` `job_variations.invoice_id`, `:343` `jobs.ready_to_invoice = false` — and reports `"Invoice created"` at `:346`. The `:343` write has already removed the job from the Ready-to-Invoice queue, so nothing ever prompts a fix. If `:339` alone fails the variations reappear as unbilled and invite a **genuine double-invoice**. Same shape at `approvals/page.tsx:116`, `quotes/new/page.tsx:105`. | **MEDIUM** — both outbound boundaries refuse a line-item-less invoice (`send:37-39`, `push-invoice:27-29`), so the harm is unbilled revenue plus a false success, not a bad document reaching a customer | Folds into #1 — the same server route |
| 6 | **2.6 (job-signature)** | `components/job/job-signature.tsx:107-127` — the one checked call is the PNG upload; the two writes that make the sign-off real are not: `:110` `job_photos.insert({photo_type:"signature"})` and `:118` `jobs.update({status:"completed", ready_to_invoice:true})`. Then `:127` "Job complete — flagged for office review". | MEDIUM-HIGH | ~2 h |
| 7 | **2.6 (delete ordering)** | Four paths remove the storage object *before* the row — `job-expenses.tsx:121-127`, `equipment-documents.tsx:94-99`, `job-documents.tsx:91-96`, `equipment-expenses.tsx:119-121` — the exact ordering `job-photos.tsx:72-75` was rewritten to condemn. | MEDIUM | ~1 h each, pattern already exists |
| 8 | **2.1** | Unrounded client float math stored raw at **four** sites, not the three documented: `invoices/new:302-304→318`, `invoices/[id]/edit:82-84→99`, `quotes/new:76-78→96`, and **`approvals/page.tsx:95-97→107-109`, whose invoice is auto-pushed to Xero at `:147` with no human in between**. Bounded to one cent by `decimal(10,2)` (`0000_baseline.sql:223-226`), so the harm is a **tax invoice that does not add up**: `invoice_items.total` is a Postgres generated column computing in exact numeric while `invoices.subtotal` carries the JS artifact (3.35 × 29.90 → 100.17 vs 100.16), and the three totals round independently so subtotal + GST ≠ total on the printed PDF. | MEDIUM — low magnitude, high visibility, GST compliance | Small: round to 2 dp (or integer cents) at all four sites and derive `total` from the rounded parts. Durable fix: make the three columns DB-derived |
| 9 | **1.8** | `team-schedule-view.tsx:415-426` and `:479-493` write to `jobs` and toast; no `sync-calendar` call in the file (the four web call sites are `job-overview:109`, `job-signature:125`, `jobs/new:93`, `approvals:184`). **Refinement:** a pure reassign is a no-op for the calendar — `assigned_to` is not in the event body (`sync-calendar/route.ts:63-71`). The **week-grid re-date** is the real gap, and it is worse than staleness: `lib/google.ts:142-155` copies calendar times back onto the job on any sync-token re-seed, so the stale event can **silently revert the drag in the database**. Mobile already does this correctly and is tested (`repositories/schedule.ts:46-58`) — this is a web-only parity gap. | MEDIUM | 30 min for the missing fetch. The self-reverting poll is a **separate item** worth raising — a last-writer check in `lib/google.ts`, ~½ day |
| 10 | **2.20** | `app/dashboard/layout.tsx:7-16` fetches `profile.role` and spends it on a text label (`app-sidebar.tsx:210`); `navItems:33-49` is an unfiltered const. A signed-in technician is **shown clickable links to every office screen**. **The money question, answered:** no dollars leak — every dashboard page reads through the anon-key cookie client and RLS refuses (`0027/0028/0034/0035/0038/0042/0045`), so `/dashboard/invoices` renders "No invoices yet" and `/dashboard/reports` renders zeros. What does leak is confidentiality, on tables still carrying the baseline `auth.role() = 'authenticated'` policy: the full staff roster with colleague emails and phones (`0000_baseline.sql:38` + `staff/page.tsx:41` `.select("*")`), the whole customer book, and every job and colleague's schedule (`baseline:131`). | MEDIUM | Small: filter `navItems` by role + a technician allowlist redirect in the layout after `:16`. **Do not let this become the money boundary — RLS is and must stay that** |
| 11 | **2.6 (side effects)** | `invoices/[id]/send:92` and `quotes/[id]/send:89` advance status **after** the email is irreversibly out — a refused write leaves "draft" and the user re-sends. `staff/page.tsx:120` reports a deactivation that may not have happened, on the table `0044` hardened. `sync-calendar/route.ts:88` discards `google_event_id` → duplicate events; `:51` → a ghost the app can no longer delete. Plus ~45 unchecked mutation sites and ~25 unchecked reads overall. | MEDIUM | Mechanical sweep ~½ day. **Add a ratchet:** scope a source-scanner to mutations under `app/`+`components/` (~45 offenders, syntactically checkable), commit the offender list as an allowlist, fail only on additions — ~2 h, and the web suite already runs four such scanners so the harness exists. A verbatim port of mobile's `noSwallowedErrors.test.ts` will not work: it needs a shared read seam, and `requireRead` is private inside `lib/labour-billing-sync.ts:58` |
| 12 | **2.19** | No `middleware.ts` tracked anywhere; no `src/`. **Narrower than it sounds:** all 29 API handlers self-guard (audited: 4× `requireAdmin`, 7× `requireOfficeOrAdmin`, 5× `requireUser`, 2× `requireCronSecret`, 1× `getCallerId`, 3 hand-rolled, 2 Bearer resolvers — zero unguarded), and `dashboard/layout.tsx:7-9` covers unauthenticated access. The uncompensated half is **session-cookie refresh**: `lib/supabase/server.ts:15-21`'s bare `catch {}` is safe only because a middleware is supposed to persist refreshed cookies. Nothing does. | MEDIUM — rank below 2.20 | ~40 lines. *Reasoned from the `@supabase/ssr` contract, not observed — confirming needs an expired-session navigation against a real instance* |
| 13 | **2.4** | No `check (clock_out > clock_in)` in any migration — confirmed: grepping `clock_out >` across `supabase/` returns nothing, and `schema.sql:350-358` / `0000_baseline.sql:362-371` carry none. **The two assessments disagreed on the label; see §3.5.** My reading: OPEN. The negative-duration payroll harm *is* closed in application code on every path, but `components/job/time-entry-edit-dialog.tsx:128,137-138` inlines its own subtraction with a `<= 0` guard and **no `MAX_PLAUSIBLE_WORK_HOURS` cap** (mobile's `hoursBetween` likewise), so an office edit or a mobile manual entry can still write a 200-hour shift. And the guards null the derived value while still persisting the reversed pair, which `reports/page.tsx:71` `.not("hours","is",null)` then silently drops — the opposite of the visible gap `lib/time-entry-hours.ts:20-22` says the office should see. | LOW-MEDIUM | One migration, **preceded by a read-only audit for violating rows** (the constraint fails to validate if any exist) + a surfacing change in reports |
| 14 | **2.18** | Four inline `createClient(url, SUPABASE_SERVICE_ROLE_KEY)` bypassing `lib/supabase/admin.ts`: `transcribe-voice-report:14-18`, `staff/invite:29-33`, `staff/resend-invite:27-31`, `staff/update:28-32`. **The doc's count of four is correct** — see §3.5. Not a live hole (all four authorize first), but it defeats the property `lib/supabase/admin.ts:3-7` claims for itself: 4 of 11 service-role sites are invisible to the seam. | LOW-MEDIUM | ~4 lines per file, zero behaviour change. Pair with a CI grep guard — nothing currently prevents a fifth |
| 15 | **2.24** | `mobile/lib/data/reads/sqlLint.test.ts` (50 tests, green, in CI) closes one axis of three — and **not the one the item is named for**. It validates local SQL against `AppSchema`, a **generated** file (`schema.ts:1-5`, derived from the live database). Nothing compares that file to `supabase/migrations` and CI never re-runs the generator, so a missed regeneration leaves `schema.ts` and the local SQL stale *together* with every guard green — the exact `jobs.ready_to_invoice` shape `sqlLint`'s own header cites. Also open: 27 of 48 SQL constants are single-table with zero qualified references, so none of their columns is checked (`inventory.ts:23-29` names 11 bare columns), and the blind-spot guard at `:129` only flags multi-table queries. | MEDIUM | ½ day. A web test that **reads `mobile/lib/powersync/schema.ts` as text** — it must not import it, §6 trap 8 — asserting every declared table/column exists in the migration history |
| 16 | **2.21** | `supabase/schema.sql` has 15 `create table`; the migrations create 33. It still carries the **infinitely recursive** profiles policy `0010` replaced (`:28-30`). **Nothing automated reads it** — `check-schema-drift.mjs:51`, `schema-column-contract.test.ts:27` and `schema-outside-migrations.test.ts:27` all read `supabase/migrations/`. The harm path is human: `README.md:64` and `schema.sql:3` tell a person to build from it. Decisive: it has drifted from its own promoted copy — `0000_baseline.sql:368` has `time_entries.notes` and four tables `schema.sql` lacks, while `0000:15` instructs "Keep this in sync with `supabase/schema.sql`". Subsumes **N16**. | LOW live / MEDIUM onboarding | ~30 min: **delete it** and repoint `README.md:64`, `HANDOVER.md:222`, `.ezra/governance.yaml:16` at `0000_baseline.sql`. Cheaper than regenerating and removes the second source of truth |
| 17 | **N3** | `mobile/` has no lint tooling at all — verified four ways (no `lint` script `package.json:63-71`, no eslint/biome dep `:53-62`, no config file, nothing in `node_modules/.bin`), and `eslint.config.mjs:15` ignores `mobile/**` by name. Its justification at `:11-13` — mobile "gets expo-doctor + tsc instead" — is **false**: expo-doctor runs nowhere in the repo. Two dead `eslint-disable-next-line` directives already sit in `mobile/` for a linter that will never run. Pointed, because this repo's worst defect class is the discarded async result and `@typescript-eslint/no-floating-promises` is the rule written for it — the repo already hand-rolls a substitute in `noSwallowedErrors.test.ts`. Blocks **3.15**. | MEDIUM (process) | 1–2 days incl. triage. Web baseline is 0 errors / 295 warnings; decide the warning-vs-error policy *before* enabling |
| 18 | **2.22** | **The doc is wrong twice.** Count: not 24 — **19 policies survive into the end state** across 18 tables and 33 expression occurrences (`0027:40,46,52,58,64,70,77`; `0028:31,47,49,51`; `0030:25`; `0035:79,85,91,97`; `0038:86,92`; `0042:49`). Severity: this is **performance, not correctness** — `is_office_or_admin` is `stable` (`0027:29-32`), so unwrapped it re-evaluates per row instead of once as an InitPlan; the boolean is identical and no row changes hands. Supabase's `rls_initplan` lint, nothing more. | LOW-MEDIUM, worst on wide tables (`job_items`, `invoice_items`, `time_entries`) | ½ day, one drop+create migration. **Trap:** you cannot fix it by editing `0042` in place — `0042:65,:149` compare rendered `pg_get_expr` text exactly and would raise during `db reset` and the CI `rls` job |
| 19 | **2.23** | "Six missing FK indexes" **understates it and could not be sourced** — the figure appears nowhere in the repo and the advisor API refused. Derived from the migration history: **31 of 67 FK columns** have no leading index. But only nine are on columns anything filters (`backflow_tests.job_id`, `invoices.quote_id`, `quotes.site_id`, `job_items.staff_id`, the three `pricing_item_id`s, `job_variations.variation_type_id`, `time_entries.travel_from_job_id`); the other 22 are audit columns with **zero `.eq()` hits in source**. None is `on delete cascade`. | **LOW** | ~1 h, one additive `create index if not exists` migration shaped like `0029` |
| 20 | Band 3 residuals | Re-verified open this session: **3.3** (no `database.types.ts`, no `gen:types`), **3.4** (`guards.ts:90` `!==` and `send-push/index.ts:28` `===` on shared secrets — narrowed: `timingSafeEqual` now exists in the tree at `lib/oauth-state.ts:50`, just not at these two sites), **3.5** (no security headers in `next.config.ts` or `vercel.json`), **3.7** (`loadLogo` duplicated in `lib/pdf/render.ts:8` and `render-backflow.ts:8`), **3.17** (`dashboard/page.tsx:61` `user!.id`), **3.18** (`smoke.spec.ts` still 18 lines), **3.19** (`npm run build` twice — `ci.yml:69` and `:274`), **N13/N14** (drift guard comment says ~600 chars, `schema-column-contract.test.ts:135` uses 400; payload regex still truncates at the first `}`), **N4 / 4.5b** (`mobile/eas.json:45,46,50` all still placeholders). | LOW | Individually 15 min – 2 h |

**Guard coverage across the open items:** the money boundary is genuinely well guarded — `tests/rls/financial-tables.test.ts` (rewritten with a paired positive control per table, after the previous version was vacuously green against unseeded tables) and `supabase/tests/money_boundary_sweep.sql` (sweeps every money-shaped column against an impersonated technician, raises `MONEY BOUNDARY BREACHED` at `:181`), both gating CI at `.github/workflows/ci.yml:206-231`. **Nothing else on this list is guarded by anything.** Not the role gating, not the OAuth token write, not the inline-client rule, not the invoice/quote edit pages, not `team-schedule-view`, not index coverage, not the helper *wiring* behind 2.4 — deleting the import at `job-time.tsx:6` and inlining the old subtraction would keep the whole suite green, which is the `escapeHtml` trap exactly.

---

### 3.3 THE ONE TO DO NEXT

**Rewrite the invoice write path as one server-side transactional route, closing 2.3 + 2.2 and the 2.1 rounding at three of its four sites.**

Why this and not something else: 2.3 is the only open item that **destroys data that already exists** — an unchecked `delete` at `invoices/[id]/edit/page.tsx:103` followed by an unchecked `insert` at `:106`, no transaction, `toast.success("Invoice updated")` at `:115`, then navigate away with no local copy — on a document a customer is charged from and may already have received. Everything above it in harm is either cheaper elsewhere or already written: 1.2's fix exists on `fix/oauth-token-swap` and needs a merge decision rather than a developer, and push-expense is a one-hour copy of its own sibling. Error-checking the three calls in sequence is *not* the fix; it leaves a window where the delete has committed and the insert has not. One route doing create-and-replace atomically is the smallest change that is correct, and the same route retires 2.2's four unchecked children and lets the totals be computed once, server-side, in rounded cents. Add the first test that exercises any of these pages while you are there — today there are none.

Do it on a branch. Standing rule 5.

---

### 3.4 NEEDS A HUMAN

No amount of code closes these.

- **Merge `fix/oauth-token-swap`** (item 1.2, commit `9f0bf9f`, pushed). Owner's call — `main` auto-deploys. Until then 1.2 is open on `main` while a finished fix sits unmerged.
- **Apply `0049`** — merged, header says `DRAFT — NOT APPLIED`. Standing rule 6: dry-run in `BEGIN … ROLLBACK`, hand over. And **confirm `0047`/`0048` really are applied** — their headers claim 2026-08-05 but §0 of this document claimed otherwise on 6 Aug and no test can settle it; run the §7 command.
- **D-04 / N19** — whether to add a migration making the `anon`/`authenticated` table grants explicit. Changes production semantics on a client database.
- **6.1** (`sites.is_active`), **6.3** (the `on delete cascade` blocking 1.4), **6.4** (`hours` generated-vs-stored, blocking 2.5) — decisions, not code.
- **4.8** — background location "always" is fully enabled in `app.json:78-80,97,120-121`, which is the opposite of the recommendation. Needs sign-off before store submission.
- **5.1 Vercel Preview env vars** — 70+ consecutive failures, proven not-code. **5.2** branch protection. **5.3** staging.
- **Accounts and credentials:** D-U-N-S, Apple paid enrolment, App Store Connect record, Google Play Console, APNs `.p8`, FCM JSON, store assets, and the `eas.json` placeholders (`:45,:46,:50`).

---

### 3.5 Where the two passes disagreed — my reading

- **2.18 — the pre-verified claim in the brief ("only `transcribe-voice-report` still has one") is wrong; the doc's count of four is right.** I verified independently: `git grep -l SUPABASE_SERVICE_ROLE_KEY` over `app/` and `lib/` returns exactly `transcribe-voice-report`, `staff/invite`, `staff/resend-invite`, `staff/update`, plus `lib/env.ts` and `lib/supabase/admin.ts`. The likely cause of the miscount is grepping for `createAdminClient`, which the three staff routes genuinely lack. Note the existing tests **cannot** catch this drift by design: `staff-routes-auth.test.ts:43-44` counts both construction forms into one spy so "the assertion holds whichever a route happens to use".
- **2.4 — one pass said PARTLY, the other OPEN. I read it as OPEN, with the substance of the PARTLY assessment preserved.** The item's canonical text is exactly and only "no `check (clock_out > clock_in)`"; the application-level mitigation is tracked separately as **2.5**, which the same doc calls "a mitigation, not the decision". Zero work exists on 2.4 itself, and labelling it PARTLY invites a reader to deprioritise an item nobody has started. The challenge also found something the first pass missed and I confirmed: `time-entry-edit-dialog.tsx:128,137-138` does *not* call `plausibleClockedHours` — the negative case is covered on every path, the 16-hour implausibility cap is not.
- **2.22 count and severity** — the doc's "24 sites" and its implied correctness framing are both wrong; 19 end-state policies, and the consequence is per-row re-evaluation of a `stable` function, not a row that changes hands.
- **2.23** — I could not reproduce or source "six". 31 derived, 9 that matter, none cascading. Recorded as derived, not measured.

**Not established from the code, stated rather than guessed:** production row counts and the *hosted* `max_rows` (the Supabase MCP refused with a permission error), so 1.9's "already live for reports" is reasoned from the 827 jobs on record and `config.toml:18` — confirm before sizing. Whether the session-refresh consequence in 2.19 actually bites needs an expired-session navigation against a real instance. Band 3 items **3.1, 3.2, 3.6, 3.8–3.12, 3.14, 3.16** were **not** re-verified this session and are carried forward on the 05-08 list's authority alone.

## 4. Standing rules — these are what prevent drift

1. **Observe every test failing before writing the fix.** No exceptions. Six tests in this
   repo were green and vacuous; four SQL security tests had never run at all. The process,
   not just the code, produced false confidence.
2. **Negative-control every fix.** Revert it, watch the test fail, restore. A guard that has
   never failed proves nothing.
3. **Assert on persisted outcomes, never on "method was called"** — in the sync engine.
4. **No mocked test may be the sole evidence for a defect the database can refuse.** ~430
   mocked tests were green while production could not execute the query they simulated.
5. **Never merge to `main` without the owner's say-so.** It auto-deploys to production and
   the repo is the client's.
6. **Never apply a migration to production.** Dry-run inside `BEGIN … ROLLBACK`, hand over.
7. **Never force-push without asking**, even on your own branch. *(This was breached once in
   this programme, to fix a mangled commit message. Recorded rather than hidden.)*
8. **TDD school is assigned, not preferred.** Detroit/classicist for the offline sync engine
   — the seam is the data layer with injected fakes, never a database. London at the HTTP
   route and authorization boundary.

---

## 5. The pattern behind almost every defect

Three of the worst — the `0034` no-op, the `ready_to_invoice` drift, the `0045` clock-in
outage — share one shape:

> **The check and the thing being checked were not the same thing.**

A migration that reported success without running. A mocked test that returned rows for a
query the database refuses. A CI database rebuilt from the same migrations it was meant to
validate. A money-column regex that could not match a money column. A fixture that could not
reach the code it was testing.

When you find something suspicious here, ask *what would this look like if it were broken?*
— usually the answer is "exactly like this", and that is the tell.

`money_boundary_sweep.sql:37-40` already said it: **"an empty table proves nothing here."**

---

## 6. Known traps

1. **`0047` is merged and unapplied.** §0.
2. **N19 — the migration history does not reproduce production.** Production grants `anon`
   and `authenticated` INSERT/UPDATE/DELETE on the public tables; **no migration creates
   those grants** (they come from Supabase's hosted default privileges). `supabase db reset`
   therefore produces a database where a technician **cannot clock in at all**, and `0045`
   fails its own assertion. CI works around it explicitly in the `rls` job. Needs a real
   migration — that is a decision, see `DECISIONS-PENDING.md` D-04.
3. **`0045` is not role-aware.** Admins cannot read `rate_override` either, so the edit
   dialog's override picker opens on "Auto" even when one is set, and saving clears it. Do
   **not** fix by re-granting the column — that reopens the leak. Commented at the call site.
4. **Vercel Preview fails on every PR** — 70+ consecutive, zero successes since 18 July.
   Configuration, not code: proven by comparison, since GitHub's `build` job runs the
   identical `next build` on the same commit and passes. If a var shows a **Sensitive**
   badge, untick it — sensitive vars are runtime-only and undefined at build time.
5. **`mobile/` has no lint tooling at all** — no config, no script. Item 3.15 has nothing to
   attach to.
6. **Metro dies periodically on every Node version** (`ws` "Too many message fragments").
   Not your setup, does not affect release builds. Run it supervised.
7. **RN `console.log` goes to Metro, not logcat.** A production-only warning written with
   `console.warn` is effectively invisible.
8. **Two npm projects, two lockfiles.** Install in the right directory. CI's `unit` job runs
   `npm ci` at the root only — so a web test that *imports* a `mobile/` module dies with
   `TSConfckParseError`. Read the file as text instead.

---

## 7. Re-verification commands

```bash
# Is 0047 applied yet? (the single most important question)
npx supabase db query --linked --file supabase/tests/0047_storage_boundary_test.sql

# Full security sweep against production — read-only, rolls back
npx supabase db query --linked --file supabase/tests/money_boundary_sweep.sql

# Schema drift, both directions
npm run check:drift

# PowerSync replication health (a dead slot reports healthy to every client signal)
npm run check:sync

# The suites
npm test && cd mobile && npm test
```

The Supabase CLI must be logged in (`npx supabase login`) and linked to project
`ntdohrsujnyuqyeirqva`.

---

## 8. Open decisions

[`docs/hardening/DECISIONS-PENDING.md`](docs/hardening/DECISIONS-PENDING.md). Summary:

| ID | Needs |
|---|---|
| D-01 | Re-run the second consensus panellist — PAL was unreachable, so the plan rests on one external opinion plus mine |
| D-02 | Confirm branch-and-PR throughout, or nominate someone with merge rights |
| D-03 | `0047` and any further migration need applying by the owner |
| D-04 | **N19** — whether to add a migration making the role grants explicit. Changes production semantics on a client database |
| D-05 | Informational: four of five SQL security tests were non-functional. Worth knowing when judging how much prior "verified" evidence to trust |
