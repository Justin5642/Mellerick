# Backend handover — 4 items for the shared `supabase/` owner

Written 2026-07-28 from the `mobile/full-parity` branch. Items 1 and 2 are
already fixed and live; they are here because they affect the **web** app and
you should know what changed. Items 3 and 4 need a decision or work from you.

---

## 1. FIXED — `jobs.ready_to_invoice` never existed (this was breaking the web app)

**What was wrong.** Nine call sites across web and mobile read or write
`jobs.ready_to_invoice`. The column existed in **no migration and no database**:

```
select ready_to_invoice from jobs;
ERROR: 42703: column "ready_to_invoice" does not exist
```

Postgres rejects any statement naming an unknown column, so these were hard
failures in production — not silent no-ops:

| Where | What it does |
|---|---|
| `app/dashboard/invoices/page.tsx:16` | **the Ready-to-Invoice queue itself** |
| `components/job/job-signature.tsx:122` | job sign-off |
| `app/dashboard/approvals/page.tsx:130,173` | approve / send-back |
| `app/dashboard/invoices/new/page.tsx:343` | clearing the flag after invoicing |

Mobile hit the same wall, but its writes dead-lettered into the outbox instead
of erroring visibly.

**Fix:** migration `0040_add_jobs_ready_to_invoice.sql` — applied and verified.
`boolean not null default false`, plus a partial index for the queue filter.

**No backfill, deliberately.** Nothing in the data indicates which historical
jobs were awaiting invoicing, and guessing would have dropped phantom jobs into
the office queue. Existing rows start `false`; the flag is accurate from the next
sign-off onward. **If office staff have been reporting that sign-offs "don't
stick" or the invoice queue looks empty, this was why.**

## 2. FIXED — `admin_status` / `admin_notes` existed in prod but in no migration

Both columns are real in production and drive Approvals, but no migration ever
created them — so a fresh environment built from this repo would lack them and
Approvals would break there.

**Fix:** migration `0041_capture_jobs_admin_columns_drift.sql` — `add column if
not exists`, a no-op against production, correct everywhere else.

This mattered beyond tidiness: because undocumented-but-real columns were known
to exist, a source comment claiming `ready_to_invoice` was "prod drift —
confirmed boolean in prod" sounded plausible, and that is what let item 1 survive
review. With drift captured, *"not in a migration"* again means *"does not
exist"*. A guard now enforces it: `tests/unit/schema-column-contract.test.ts`
checks source column references against the real migration history (430+ existing
tests could not catch this, because they all mock Supabase — and a mock accepts
any column you name).

## 3. NEEDS YOU — mobile can't use Send / PDF / Xero (cookie-only routes)

These API routes authenticate by **cookie only** and reject a mobile `Bearer`
token, so the mobile app cannot use them at all:

- invoice / quote **Send email**
- invoice / quote **PDF** view + download
- **Xero push** (invoice + expense)

The pattern that fixes it already exists in the repo: `lib/api/caller-client.ts`
builds a caller-scoped Supabase client that accepts **either** a Bearer token or
a cookie, so the web path stays byte-identical while mobile starts working. Four
routes were already migrated to it (PRs #5/#6) — these are the remainder.

## 4. NEEDS YOU — a decision, and an optional schema addition

**(a) Backflow test-log offline replay (Q3).** Logging a backflow test triggers a
water-authority **submit**. Until that endpoint is dedupe-guarded server-side, an
offline retry could double-email the authority, so mobile deliberately keeps this
write online-only. Needed: confirmation of the dedupe contract (idempotency key,
or a server-side check on `(device, test_date)`), after which mobile can make it
offline-durable.

**(b) `sites.is_active` (Q17, optional).** `sites` has no soft-delete flag, and
`jobs.site_id` / `quotes.site_id` block hard deletion, so mobile offers
**edit-only** for sites — deliberately, to avoid queueing a delete that can never
succeed. If site removal is wanted on mobile, add `sites.is_active boolean not
null default true`; mobile then mirrors the customers soft-delete pattern.

---

### Reference

- Branch: `mobile/full-parity` · migrations `0040`, `0041` applied to production
- Full rationale: `mobile/DECISIONS-FOR-AVI.md` (D98, D99; questions Q2–Q17)
- Verification: 111 web + 333 mobile tests green, both typechecks clean
