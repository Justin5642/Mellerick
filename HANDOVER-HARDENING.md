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

**Five migrations — `0049` through `0053` — are written, reviewed and merged, and none of
them has been applied to production. Every defect they close is live right now.**

Re-verified 11 Aug 2026 by reading each header:

| Migration | Closes | Live consequence while unapplied |
|---|---|---|
| `0049` | job media delete scoping | any authenticated user can destroy any job's photos, customer signatures and voice recordings |
| `0050` | atomic replace helpers | the invoice/quote line replacement and the OAuth token swap are correct in application code but still not transactional |
| `0051` | `time_entries` duration constraint | nothing in the schema stops a reversed or 200-hour shift reaching payroll |
| `0052` | foreign-key indexes | performance only |
| `0053` | wrap `is_office_or_admin` in `select` | performance only — apply this one **last and alone**, it rewrites live RLS policies |

**Merging a migration does not run it.** This repo has been bitten by that gap repeatedly:
`0034` reported success while achieving nothing, and `0040` shipped after nine call sites had
referenced a column that existed nowhere.

Check before assuming anything — this reads the production ledger and compares it against
what every header claims about itself:

```bash
npm run check:migrations
```

It needs production credentials, so **CI cannot run it and no test result implies anything
about it.** `tests/unit/migration-header-truth.test.ts` pins the claim-detection only.

### What this section said until 11 Aug, and why it was wrong

It said `0047` was unapplied and its storage leak was live — a true statement on 6 August that
became false on the 5th of the month it was next read, because `0047` and `0048` were applied
on **2026-08-05** and their headers say so. It stayed at the top of this document for five
days, in bold, as the first thing anyone read.

That is worth more than an apology, because it is the same defect the document is about. A
stale alarm is not harmless noise: it spends the reader's attention on a closed problem and
teaches them to discount the section that also lists the five real ones. Whoever applies
`0049`–`0053` must update this section in the same change.

---

## 1. Verified state

### Merged and live in production

| PR | What | Effect |
|---|---|---|
| [#14](https://github.com/Justin5642/Mellerick/pull/14) | `select("*")` on `time_entries` → explicit columns | **Web clock-in works again.** It had been silently recording nothing since `0045` landed |
| [#16](https://github.com/Justin5642/Mellerick/pull/16) | Hardening phases 1–3 | Offline auto-clock no longer loses shifts; CI can catch a security revert; travel legs record; apprentice labour prices correctly |
| [#18](https://github.com/Justin5642/Mellerick/pull/18) | Hardening phase 4 | Seven offline-engine defects |

### Merged but NOT applied

| Migrations | What | Status |
|---|---|---|
| `0049`–`0053` | media delete scoping, atomic replace helpers, time-entry duration constraint, FK indexes, RLS InitPlan | **In `main`, absent from production.** See §0 |

`0047` (PR [#15](https://github.com/Justin5642/Mellerick/pull/15), storage policy scoping) sat
in this table until 11 Aug. It and `0048` were applied on **2026-08-05** and their headers say
so; the row was five days stale.

### Test baseline — reproduce these numbers before changing anything

Measured 11 August 2026 on `fix/cleanup-residuals` @ `e963b4a`:

```bash
npm test                # web:    49 files, 423 tests
cd mobile && npm test   # mobile: 78 suites, 589 tests
npx tsc --noEmit        # both projects clean
npm run lint            # web:    0 errors
cd mobile && npm run lint   # mobile: 0 errors, 7 warnings (ceiling pinned at 7)
```

These counts move every session — that is the point of running them rather than reading them.
Treat a **lower** number as the signal: it means either an older commit or a suite that has
stopped collecting files, and this repo has shipped both.

### CI now actually gates security

The `rls` job was rebuilt. It applies **every migration** — 54 files today — seeds one user
per role plus money in the money tables, and runs the `supabase/tests/*.sql` files, which
raise on failure.

`scripts/ci-apply-migrations.sh:71-88` applies the five `STATUS: DRAFT` files in a **second
pass**, after the applied ones, and `PROD_ONLY=1` skips them entirely. So a green `rls` job
proves the drafts are *correct SQL against production's schema*; it proves nothing about
whether production has run them, and the pass that mirrors production deliberately does not
include them.

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

**Re-verified:** 11 August 2026 on `fix/cleanup-residuals` @ `e963b4a`, reading each file and running each command. The previous pass was 10 August against `main` @ `381ba5b` (merge of PR #25); **sixteen of that pass's twenty open items closed in the day between**, so §3.2 below is now a record of what was closed and §3.2b is what is left. Supersedes the 2026-08-05 list in [`docs/hardening/TODO-VERIFIED-2026-08-05.md`](docs/hardening/TODO-VERIFIED-2026-08-05.md), which is stale in both directions.

**A note on how fast this file goes stale.** Three of its sections — §0, §3.2 and §6 trap 1 — have each been confidently wrong within a week of being written, always in the same direction: work got done and the document kept describing the world before it. If you are reading this more than a few days after the date above, assume the same has happened again and check §3.2b against the code before believing any of it.

**Two notes on this document's own framing before the list:**

- **What §0 rests on.** §0's list was rewritten on 11 August 2026 and now matches the ledger: 49 rows, last version `0048`, with `0049`–`0053` unapplied. That was confirmed by running the check below against production, not by reading headers — the two agreed, which is the point.

  Headers are guarded in two halves, and the split matters. `tests/unit/migration-header-truth.test.ts` runs in CI and pins the claim-*detection*: that every header on disk states one status, that the detector still recognises the phrasing in front of it, and that the marker `scripts/ci-apply-migrations.sh` holds drafts back on appears on exactly the files that claim to be drafts. It cannot ask production what is applied, and says so. `npm run check:migrations` is the half that asks — it reads `supabase_migrations.schema_migrations` on the linked project and fails when a header contradicts it. **Until 11 August 2026 that script did not exist**, while this document, the test, and all five draft headers cited it as live; the drafts' claim about themselves was enforced by nothing. It exists now and exits `2` — not `0` — when it cannot reach the database, so an unrunnable check can never read as a passing one.
- **`fix/oauth-token-swap` is merged. This bullet used to say it was not.** It said the working tree was that branch at HEAD `9f0bf9f`, "pushed but unmerged", and told the reader that item 1.2 looked done on disk but was absent from `main`. Verified 11 Aug 2026: `git merge-base --is-ancestor 9f0bf9f main` succeeds, and `main` is at `81b1143`, the merge of **PR #29** — the fourth of four PRs (#26, #27, #28, #29) merged off that branch. **1.2 is closed on `main`.**

  Left in place rather than deleted because the failure it warns about is real and recurs: a working tree that is ahead of `main` makes finished work and unmerged work look identical to anyone reading files on disk. The check is one command, and it is worth running before trusting any "DONE" in this document:

  ```bash
  git branch --show-current && git log --oneline -1 main
  ```

---

### 3.1 ALREADY DONE — do not redo

Every wrong entry here costs someone a day of rediscovery. Verified against `381ba5b` on
10 August; **§3.2 below carries the same list for the items that closed on 11 August**, and
between them they are the complete "do not redo" set.

| ID | What closed it | Guard |
|---|---|---|
| **S3 / 1.5** | `transcribe-voice-report/route.ts:25` `getCallerId`, `:68` `canManageJobBilling`, `:41` comment *"`recordedBy` is deliberately NOT read from the body"*, `:106` `voice_report_recorded_by: callerId` | `tests/unit/transcribe-voice-report-auth.test.ts` |
| **1.1** | `lib/oauth-state.ts` exists **and is wired into all four routes** — `{google,xero}/auth` mint + set the HttpOnly cookie (`:17-19`, `:17-22`), `{google,xero}/callback` refuse on mismatch before any token exchange (`:20-21`, `:21-22`) | `tests/unit/oauth-state.test.ts` |
| **1.6** | `lib/approval-invoice-guard.ts` → `resolveExistingInvoice`, and `approvals/page.tsx:79-86` actually **gates on it** (`if (!guard.proceed) { toast.error(...); return; }`), not merely imports it | `tests/unit/approval-invoice-guard.test.ts` |
| **1.7** | `escapeHtml` imported and applied in both send routes — `invoices/[id]/send:9,62,74,75` and `quotes/[id]/send:8,59,71,72` | `tests/unit/send-route-escaping.test.ts` (a source scanner, so it survives refactors) |
| **1.16** | `0035`/`0036`/`0038` headers now read `✅ APPLIED AND VERIFIED IN PRODUCTION`. Was ranked #2 in the old list's "actually next" | `tests/unit/migration-header-truth.test.ts` (every header on disk, derived from the directory — not a hardcoded list of four) + `npm run check:migrations` (the ledger; written 2026-08-11, having been cited as live since 08-05) |
| **2.6** *(partial)* | Beyond `job-time.tsx`: `time-entry-edit-dialog.tsx:158-199` (insert/update/delete all checked, incl. the 2.7 zero-row case), `job-photos.tsx:62-106` (row-first delete with `count: "exact"`), `push-invoice/route.ts:116-140` (3-attempt link retry + `requiresManualReconciliation`), `labour-billing-sync.ts:58` `requireRead()` | `xero-invoice-link.test.ts`, `labour-billing-sync-errors.test.ts`, `time-entry-columns.test.ts` — site-specific, no class-level guard |
| **3.13** | `sync-streams.yaml:59-80` explicit columns | `sync-streams-contract.test.ts` (carried forward from the 05-08 list; not re-run this session) |
| **N15** | **Stale, strike it.** "New migrations keep reproducing the unwrapped-helper pattern" stopped being true after `0042`: `0044`, `0047`, `0048`, `0049` all use `(select is_office_or_admin(...))` | **None.** This rests entirely on author discipline and can regress silently |

---

### 3.2 CLOSED SINCE 10 AUGUST — do not redo

**Re-verified 11 August 2026** by reading each file on `fix/cleanup-residuals` @ `e963b4a`.
Of the twenty rows this table carried on 10 August, **sixteen are closed**. They are listed
here rather than deleted, because a reader who remembers the old list needs to see the
specific row struck, and because the guard column is the part worth keeping: an item with no
guard can come back.

The four that remain are in §3.2b, and every one of them is now **waiting on a human**, not
on a developer.

| ID | What closed it | Guard |
|---|---|---|
| **2.3 + 2.2 + 2.1** | `lib/replace-line-items.ts`. `replaceLineItems` is used by `invoices/[id]/edit` and `quotes/[id]/edit` in place of the unchecked delete-then-insert; `moneyTotals` rounds at all four float sites — `invoices/new`, `quotes/new`, both edit pages and `approvals/page.tsx`. The child writes at `invoices/new` (`invoice_items`, `job_variations.invoice_id`, `jobs.ready_to_invoice`) each check their error and say which one failed. | `replace-line-items.test.ts`, `unchecked-mutations.test.ts`. **Still not transactional** — application code cannot be. `0050` is the durable fix and is unapplied; see §0 |
| **2.6 (push-expense)** | Merged in **PR #29**. `push-expense/route.ts` now retries the `xero_bill_id` link write 3× and, on exhaustion, returns an error carrying `requiresManualReconciliation: true` instead of `{"success":true}` | `xero-bill-link.test.ts` |
| **1.2** | Merged in **PR #29**. `lib/oauth-token-store.ts` writes insert-first so a refused insert cannot destroy a working connection, wired into both callbacks | `oauth-token-store.test.ts` |
| **1.9 (reports)** | `lib/fetch-all-rows.ts` pages past `max_rows`; `reports/page.tsx` routes every one of its reads through it. **The two list pages are still unranged** — see §3.2b | `fetch-all-rows.test.ts`, `reports-equipment-reads.test.ts` |
| **2.6 (job-signature)** | `job-signature.tsx` checks the `job_photos` insert and the `jobs` status update, and each failure produces a message naming what did not happen — *"The signature image was uploaded but not recorded… Please sign again"* rather than "Job complete" | `unchecked-mutations.test.ts` |
| **2.6 (delete ordering)** | All four paths — `job-expenses`, `job-documents`, `fleet/equipment-documents`, `fleet/equipment-expenses` — now delete the **row first**, check it, and only then remove the storage object | `unchecked-mutations.test.ts` |
| **1.8** | `team-schedule-view.tsx` surfaces the calendar result per write (`toast.warning("… — Google Calendar not updated")`). The self-reverting poll — the worse half — is closed too: `lib/google.ts` has `calendarEventIsNewer`, comparing `event.updated` against `jobs.updated_at`, so the poll only writes when the event is demonstrably the newer writer | `google-calendar-poll.test.ts`, `sync-calendar-auth.test.ts` |
| **2.20** | `lib/nav-items.ts` holds the route list with a `tech` flag; `components/app-sidebar.tsx` filters the sidebar through `navItemsFor(role)` and `middleware.ts` refuses the routes outright via `mayOpen` — **the same list**, so the two cannot drift. Hiding a link was never enough: a typed `/dashboard/staff` still rendered the roster | `nav-items.test.ts`. Both files carry the warning in capitals that this **is not the money boundary and must never become it** — RLS is |
| **2.6 (side effects)** | The send routes report `statusUpdated: false` with *"The invoice WAS emailed… do NOT send it again"* rather than silently leaving it draft; `staff/page.tsx` uses `{ count: "exact" }` and treats `count === 0` as a refusal; `jobs/[id]/sync-calendar` checks both `google_event_id` writes | **`unchecked-mutations.test.ts`, and this is the important part: it began as the ratchet this row asked for and now has an EMPTY allowlist.** All eighteen original offenders are checked, and it scans `app`, `components` and `lib`. Adding a file back to the allowlist is a decision to ship the defect, not maintenance. **Its stated limit:** it flags a statement that STARTS with `await` and reaches a mutation before the first `;`. A result assigned to a variable counts as checked even if the caller then ignores it — catching that needs real flow analysis. It has twice been described here as more complete than it was (first scanning two roots of three, then reading one line instead of one statement, which hid five multi-line writes in `lib/`); state what it does, not what it aspires to |
| **2.19** | `middleware.ts` exists and does both halves: it persists refreshed session cookies (the `@supabase/ssr` contract that `lib/supabase/server.ts`'s bare `catch {}` depends on) and refuses office routes to technicians | `nav-items.test.ts` covers the route list; the cookie-refresh half is still *reasoned from the contract*, not observed against an expired session |
| **2.18** | Zero inline service-role clients remain. `SUPABASE_SERVICE_ROLE_KEY` appears in exactly two files repo-wide — `lib/env.ts` (declaring it required) and `lib/supabase/admin.ts` (the seam) | `service-role-seam.test.ts`, `service-role-routes-auth.test.ts` |
| **2.24** | `tests/unit/device-schema-vs-migrations.test.ts` — the axis nothing was checking. It reads `mobile/lib/powersync/schema.ts` **as text** (§6 trap 8) and compares every declared table and column against the migration history, so a missed regeneration no longer leaves the schema and the local SQL stale *together* with every guard green | `device-schema-vs-migrations.test.ts` + `sqlLint.test.ts` (the other axis). `sync-streams.yaml`'s comment now names both — it used to name a `readColumns` test that has never existed anywhere in this repo, which is why `cited-tests-exist.test.ts` was added |
| **2.21** | `supabase/schema.sql` is **deleted**. `HANDOVER.md` and `.ezra/governance.yaml` point at `0000_baseline.sql` as the single source of truth | `schema-outside-migrations.test.ts`, `schema-column-contract.test.ts` |
| **N3** | `mobile/eslint.config.js` + `"lint": "eslint . --max-warnings 7"` + a CI step that runs it. Measured 11 Aug: **0 errors, 7 warnings** — at the pin, down from 136 | The pin itself, plus `cited-tests-exist.test.ts`, which fails the build if the ceiling quoted in `ci.yml` and the one enforced in `mobile/package.json` disagree (they had, 136 vs 7) |
| **Band 3** | **3.3** `lib/database.types.ts` + `gen:types`; **3.4** `timingSafeEquals` at both sites (`lib/api/guards.ts`, `send-push/index.ts`); **3.5** security headers in `next.config.ts`; **3.7** `loadLogo` extracted to `lib/pdf/logo.ts` and imported by both renderers; **3.17** `dashboard/page.tsx` guards instead of asserting `user!.id`; **N13/N14** drift-guard window reconciled with its comment | `database-types-freshness.test.ts`, `constant-time.test.ts`, `push-sender.test.ts`, `schema-column-contract.test.ts` |

---

### 3.2b STILL OPEN — and all of it is now waiting on a person

The code work on this list is done. What is left needs credentials, a production window, or a
decision. **This is the section to read.** It was four rows deep in a list of twenty on
10 August, which is the failure this document keeps producing: a real blocker buried under
false ones.

| # | ID | What is open | Who can close it |
|---|---|---|---|
| 1 | **2.4, 2.22, 2.23, atomicity, media delete** | **The five drafted migrations, `0049`–`0053`.** Every one is written, reviewed, and applied in CI's draft pass; none is in production. `2.4`'s `check (clock_out > clock_in)` is `0051` — the application-level cap exists (`lib/time-entry-hours.ts` `MAX_PLAUSIBLE_WORK_HOURS = 16`, and `time-entry-edit-dialog.tsx` now calls `checkManualClockedHours` rather than inlining a subtraction), but the schema still permits a 200-hour shift written by anything that is not this app. `2.22` is `0053`, `2.23` is `0052`, the invoice/OAuth atomicity is `0050`. | **The owner.** §0 has the table and the order. `0053` last and alone. Standing rule 6: dry-run in `BEGIN … ROLLBACK`, hand over |
| 2 | **1.9 (list pages only)** | `app/dashboard/invoices/page.tsx` and `app/dashboard/quotes/page.tsx` still `.select()` unranged. Reports — the part that computed *wrong numbers* — is closed. What remains is payload: every invoice and quote row shipped to the browser on every visit, and silent truncation at `max_rows` once either table passes 1000. | A developer, ~1 h. `lib/fetch-all-rows.ts` already exists; this is applying it twice |
| 3 | **N4 / 4.5b** | `mobile/eas.json:45,46` — `appleId` and `ascAppId` are still `…_HERE` placeholders. `appleTeamId` is filled | Needs the Apple accounts below |
| 4 | **3.19** | `npm run build` runs twice in CI (`.github/workflows/ci.yml:75` and `:237`) | A developer, 15 min |
| 5 | **3.18** | E2E coverage is thin — `tests/e2e/smoke.spec.ts` is 18 lines | A developer |
| 6 | **N15** | Not a defect: a **regression risk with no guard**. Every migration since `0042` wraps the helper correctly, and nothing enforces it. It rests on author discipline | Worth a guard if anyone is in `supabase/` anyway |

**Not re-verified this session and carried forward on the 05-08 list's authority alone:**
Band 3 items **3.1, 3.2, 3.6, 3.8–3.12, 3.14, 3.16**. Treat them as unknown, not as open.

**Guard coverage — this paragraph used to end "nothing else on this list is guarded by
anything", and that is no longer true.** The money boundary remains the best-guarded thing
here: `tests/rls/financial-tables.test.ts` (a paired positive control per table, after the
previous version was vacuously green against unseeded tables) and
`supabase/tests/money_boundary_sweep.sql` (sweeps every money-shaped column against an
impersonated technician and raises `MONEY BOUNDARY BREACHED`), both gating CI. Around it there
is now a class-level guard for the defect that produced most of this document —
`tests/unit/unchecked-mutations.test.ts`, empty allowlist across `app`/`components`/`lib`, with the limit stated in §3.2 — plus
`service-role-seam.test.ts`, `nav-items.test.ts`, `device-schema-vs-migrations.test.ts` and
`cited-tests-exist.test.ts`.

What is still guarded by **nothing**: the five migrations actually reaching production
(`npm run check:migrations` can tell you, but only a person can run it), and N15.

---

### 3.3 THE ONE TO DO NEXT

**Apply `0049`–`0053` to production, in the order §0 gives, `0053` last and alone.**

This section used to say *"rewrite the invoice write path as one server-side transactional
route, closing 2.3 + 2.2 and the 2.1 rounding at three of its four sites"*. **That is done** —
`lib/replace-line-items.ts` with `replace-line-items.test.ts`, and `moneyTotals` at all four
float sites. The reasoning is kept because it was right about the shape of the problem and it
explains why `0050` exists: error-checking the delete and the insert in sequence was never the
fix, since it leaves a window where the delete has committed and the insert has not. The
application code closes the reporting lie; only the migration closes the window.

Which is why the next action is not a code change. Five migrations are the difference between
"fixed in the repo" and "fixed for the business", and this programme has now twice let that
gap sit long enough for a document to go stale describing it. The one before it —
`0047` — was announced at the top of this file as urgent for five days *after* it had been
applied, which is the same failure wearing the opposite sign.

If you are a developer and cannot apply migrations, take **1.9's two list pages** (§3.2b row
2). It is an hour, and `lib/fetch-all-rows.ts` already exists.

Do it on a branch. Standing rule 5.

---

### 3.4 NEEDS A HUMAN — the whole remaining programme is in here

No amount of code closes these. As of 11 August 2026 this section is not a footnote to the
work; it **is** the work.

- **Apply `0049`, `0050`, `0051`, `0052`, `0053`** — all five merged, all five headers say `DRAFT — NOT APPLIED`, all five verified still drafts on 11 Aug. Standing rule 6: dry-run in `BEGIN … ROLLBACK`, hand over. `0053` last and on its own — it rewrites live RLS policies. Confirm against the ledger with `npm run check:migrations`, which exists as of 11 Aug and exits non-zero rather than `0` when it cannot reach the database.
- ~~**Merge `fix/oauth-token-swap`**~~ — **done.** Merged as PR #29; `main` is at `81b1143`. Item 1.2 is closed on `main`. This bullet is struck rather than deleted because it was the example of a finished fix sitting unmerged while the document called it open, and the next one will look identical.
- ~~**Confirm `0047`/`0048` really are applied**~~ — their headers claim 2026-08-05 and nothing has contradicted that since. `0047`'s storage test (`supabase/tests/0047_storage_boundary_test.sql`) is the read-only way to settle it in a minute if you want certainty.
- **D-04 / N19** — whether to add a migration making the `anon`/`authenticated` table grants explicit. Changes production semantics on a client database.
- **6.1** (`sites.is_active`), **6.3** (the `on delete cascade` blocking 1.4), **6.4** (`hours` generated-vs-stored, blocking 2.5) — decisions, not code.
- **4.8** — background location "always" is fully enabled in `app.json:78-80,97,120-121`, which is the opposite of the recommendation. Needs sign-off before store submission.
- **5.1 Vercel Preview env vars** — 70+ consecutive failures, proven not-code (§6 trap 4 has the fix). **5.2** branch protection. **5.3** staging.
- **Accounts and credentials** — still the largest single blocker, and nothing in the repo can move it: D-U-N-S, Apple paid enrolment, App Store Connect record, Google Play Console, APNs `.p8`, FCM JSON, store assets, the PowerSync database password, and the two remaining `eas.json` placeholders (`:45` `appleId`, `:46` `ascAppId` — `appleTeamId` is filled).

---

### 3.5 Where the two passes disagreed — my reading

**Kept as a record of how the disagreements were settled, not as a live to-do.** All four items
below are now closed in code (2.18, 2.22, 2.23 — the last two by `0053` and `0052`, which are
written and awaiting application) except 2.4's schema constraint, which is `0051`. Read it for
the method: in each case the tie was broken by measuring rather than by preferring an
assessment, and twice the measurement contradicted the brief that had been handed over as
"pre-verified".

- **2.18 — the pre-verified claim in the brief ("only `transcribe-voice-report` still has one") is wrong; the doc's count of four is right.** I verified independently: `git grep -l SUPABASE_SERVICE_ROLE_KEY` over `app/` and `lib/` returns exactly `transcribe-voice-report`, `staff/invite`, `staff/resend-invite`, `staff/update`, plus `lib/env.ts` and `lib/supabase/admin.ts`. The likely cause of the miscount is grepping for `createAdminClient`, which the three staff routes genuinely lack. Note the existing tests **cannot** catch this drift by design: `staff-routes-auth.test.ts:43-44` counts both construction forms into one spy so "the assertion holds whichever a route happens to use".
- **2.4 — one pass said PARTLY, the other OPEN. I read it as OPEN, with the substance of the PARTLY assessment preserved.** The item's canonical text is exactly and only "no `check (clock_out > clock_in)`"; the application-level mitigation is tracked separately as **2.5**, which the same doc calls "a mitigation, not the decision". Zero work exists on 2.4 itself, and labelling it PARTLY invites a reader to deprioritise an item nobody has started. The challenge also found something the first pass missed and I confirmed: `time-entry-edit-dialog.tsx:128,137-138` does *not* call `plausibleClockedHours` — the negative case is covered on every path, the 16-hour implausibility cap is not.
- **2.22 count and severity** — the doc's "24 sites" and its implied correctness framing are both wrong; 19 end-state policies, and the consequence is per-row re-evaluation of a `stable` function, not a row that changes hands.
- **2.23** — I could not reproduce or source "six". 31 derived, 9 that matter, none cascading. Recorded as derived, not measured.

**Not established from the code, stated rather than guessed:** production row counts and the *hosted* `max_rows` (the Supabase MCP refused with a permission error), so 1.9's "already live for reports" was reasoned from the 827 jobs on record and `config.toml:18`. That reasoning is now moot for reports — `lib/fetch-all-rows.ts` pages regardless of the cap — but it still applies to the two list pages in §3.2b. Whether the session-refresh consequence in 2.19 actually bites needs an expired-session navigation against a real instance; `middleware.ts` was written from the `@supabase/ssr` contract, and that is still the weakest evidence in this document. Band 3 items **3.1, 3.2, 3.6, 3.8–3.12, 3.14, 3.16** were **not** re-verified and are carried forward on the 05-08 list's authority alone.

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

1. **Five migrations — `0049`–`0053` — are merged and unapplied.** §0. This trap read
   "`0047` is merged and unapplied" until 11 Aug, five days after `0047` was applied. The
   trap is real and the number changes; the migration number in it is the part to distrust.
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
5. ~~**`mobile/` has no lint tooling at all**~~ — **closed (item N3).** `mobile/eslint.config.js`,
   `npm run lint` in `mobile/`, gated in CI, ceiling pinned at **7** warnings (measured
   11 Aug: 0 errors, 7 warnings). The trap now runs the other way: the ceiling can only be
   lowered, and `cited-tests-exist.test.ts` fails the build if the number quoted in
   `ci.yml`'s comment stops matching the number `mobile/package.json` enforces.
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
# Are 0049-0053 applied yet? (the single most important question)
# Exit 0 = every header agrees with the ledger, 1 = one contradicts it,
#          2 = could not ask, which is NOT a pass
npm run check:migrations

# Storage boundary, if you want 0047/0048 confirmed independently of their headers
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
| D-03 | Migrations need applying by the owner. **Currently five: `0049`–`0053`.** (`0047`, named here until 11 Aug, was applied 2026-08-05) |
| D-04 | **N19** — whether to add a migration making the role grants explicit. Changes production semantics on a client database |
| D-05 | Informational: four of five SQL security tests were non-functional. Worth knowing when judging how much prior "verified" evidence to trust |
