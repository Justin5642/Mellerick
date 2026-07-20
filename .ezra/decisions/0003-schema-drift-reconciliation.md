# ADR 0003 — Schema-drift reconciliation & RLS/E2E test scaffolding

**Date:** 2026-07-20
**Status:** Accepted (pending prod verification for the SQL)

## Problem
`xero_tokens` and `time_entries` existed only in production — never in the
versioned SQL — so the repo could not rebuild the database, and `xero_tokens`
(Xero OAuth tokens) had no RLS policy anywhere in the migrations, meaning its
production RLS state is unverified and possibly OFF.

## Decision
- **Restore both tables to `supabase/schema.sql`** (the documented baseline),
  mirroring the existing `google_tokens` definition: base columns + an
  authenticated RLS policy. Columns reconstructed from code usage + the
  migrations that `add column if not exists` on them (so those migrations remain
  correct no-ops on a fresh build). Placed at the end of the baseline; both
  reference `jobs`/`profiles` which are defined earlier.
- **New migration `0034_restrict_xero_tokens_to_office_admin.sql`** enables RLS
  and adds an office/admin-only policy via `is_office_or_admin()` (migration
  0027), exactly mirroring how `google_tokens` was locked in the 0027/0028 pass.
  Idempotent — safe on prod (turns RLS on if off; drop-if-exists/create policy).
- **RLS test suite** (`tests/rls/`, Vitest `rls` project): seeds admin/office/
  technician users against a local stack and asserts technician cannot read
  `xero_tokens` or the financial tables while office/admin can. Regression cover
  for 0027/0028/0034.
- **Playwright E2E** (`tests/e2e/`): smoke tier grounded in verified selectors
  (auth redirect + login form). CI `rls` and `e2e` jobs boot a local Supabase
  stack to run both.

## Honesty note (verification status)
The SQL and both test suites **typecheck and are committed, but have NOT been
executed** — running them needs Docker + a local Supabase stack, which isn't
reachable in this session. They are therefore scaffolding that will be validated
when the stack is available (locally or via the CI jobs on the next push). The
reconstructed column set/types must be diffed against a production dump before
`0034` is applied to prod. This is called out in HANDOVER §6 and §8.

## Why not a trailing-only migration
A migration numbered after 0033 can't create the tables *before* 0018/0033 try
to `alter` them, so a fresh migrations-only build would still fail. `schema.sql`
is the baseline applied first, so the tables belong there; `0034` carries only
the behavioral RLS change.
