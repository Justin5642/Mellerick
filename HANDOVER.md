# Mellerick — Handover & Operations Guide

Production-readiness handover for the Mellerick job-management platform. Pairs
with [README.md](README.md) (setup) and the hardening plan in
[`.ezra/plans/`](.ezra/plans/).

## 1. What this is

A Next.js 15 web dashboard + Expo mobile app on a shared Supabase backend, for
Mellerick Plumbing & Drainage. Feature-complete: jobs, scheduling, time
tracking, quotes/invoices (Xero sync), backflow compliance testing, fleet
costing, staff management. See the feature inventory in
[`.ezra/knowledge.yaml`](.ezra/knowledge.yaml).

## 2. Architecture

- **Web** (`app/`, `components/`, `lib/`): App Router. Server components fetch
  under the user's session (RLS-enforced); API routes in `app/api/**` handle
  mutations and integrations.
- **Auth model**: three roles — `admin`, `office`, `technician`. Row-level
  security in Postgres is the primary boundary (migrations 0027/0028 restrict
  financial tables to office/admin). API routes add an in-code authorization
  layer via [`lib/api/guards.ts`](lib/api/guards.ts) —
  `requireUser`/`requireAdmin`/`requireOfficeOrAdmin`/`requireCronSecret` — used
  before any service-role write. Per-record checks live in
  [`lib/api/job-authz.ts`](lib/api/job-authz.ts).
- **Service-role key**: constructed only in [`lib/supabase/admin.ts`](lib/supabase/admin.ts).
  It bypasses RLS, so any route using it MUST authorize the caller first.
- **Mobile** (`mobile/`): separate Expo project, deploys via EAS under Justin's
  account. Talks to the same Supabase + the web app's API routes (Bearer token).

## 3. Environment variables

See [.env.example](.env.example) for the annotated list. Required: the three
Supabase vars. `CRON_SECRET` is required in production (authenticates the Vercel
cron routes). Everything else feature-gates an optional integration. Typed,
fail-fast accessors are in [`lib/env.ts`](lib/env.ts).

## 4. Local development

```bash
nvm use 22   # or fnm; Node 25 breaks @supabase/ssr server-side
npm install
cp .env.example .env.local   # fill in Supabase vars
npm run dev
```

## 5. Testing

- `npm test` — unit + route-authorization suite (Vitest, 68 tests, all mocked,
  no external services). Covers the pricing/cost logic, the auth guards, the
  per-record authorization, and the 401/403 matrix for hardened routes.
- Coverage is scoped to security- and business-critical modules
  (`vitest.config.ts`), not repo-wide.
- `npm run test:rls` — RLS policy tests (`tests/rls/`) proving the role access
  matrix on `xero_tokens` and the financial tables. **Authored but not yet
  executed** — needs a local Supabase stack (Docker); the CI `rls` job boots one.
- `npm run test:e2e` — Playwright smoke tier (`tests/e2e/`). Currently the auth
  boundary + login form; deeper authenticated flows land once the seeded local
  stack is wired in. Needs Docker + `npx playwright install chromium`; the CI
  `e2e` job runs it.

## 6. Database & migrations

`supabase/schema.sql` is the baseline; `supabase/migrations/` holds ordered
changes. Apply with the Supabase CLI.

**Schema-drift reconciliation (needs prod verification before applying).**
`xero_tokens` and `time_entries` were created directly in production and were
missing from the versioned SQL. They have been **restored to `schema.sql`**
(reconstructed from code + the migrations that alter them), and migration
**`0034_restrict_xero_tokens_to_office_admin.sql`** adds the missing RLS policy
that locks `xero_tokens` (Xero OAuth tokens) to office/admin — idempotent and
safe to apply to prod (turns RLS on if it was off). Before applying to
production: (1) dump the real prod schema and diff it against `schema.sql` to
confirm the reconstructed column set/types match, (2) take a backup/PITR point,
(3) apply `0034` and run `supabase migration repair` so the CLI history is
coherent. The RLS test suite (`npm run test:rls`) proves the policy locally.

## 7. Deployment

Vercel auto-deploys every push to `main` to production. **Recommended**: enable
branch protection on `main` and point `main` at a preview/staging environment so
production deploys become deliberate. CI (`.github/workflows/ci.yml`) runs
typecheck, unit tests, and build on every PR. Cron routes are scheduled in
`vercel.json` and authenticated by `CRON_SECRET`.

## 8. Outstanding work (blocked on external input)

1. **Verify the schema reconciliation against prod (HIGH).** `schema.sql` +
   `0034` are written but need a read-only prod DB connection to (a) confirm the
   reconstructed `xero_tokens`/`time_entries` columns match production and (b)
   check whether `xero_tokens` RLS is currently OFF (if so, apply `0034`
   same-day — until then any authenticated user may be able to read the Xero
   tokens). Then apply `0034` to prod with a backup + `migration repair`.
2. **Run the RLS + E2E suites.** Both are authored (`tests/rls/`, `tests/e2e/`)
   and typecheck; they need Docker + a local Supabase stack to execute. The CI
   `rls` and `e2e` jobs boot one automatically — they'll go green on the next
   push once GitHub Actions runs them (or locally once Docker is reachable).
3. **Deployment gating** (branch protection, staging) — Justin/owner action.
4. Lower-severity route tightening and open questions: see
   [DECISIONS-FOR-AVI.md](DECISIONS-FOR-AVI.md).

## 9. What changed in the hardening pass

Branch `hardening/production-readiness`. Commits, in order: toolchain pin + Next
security patch + CI; Vitest unit infra; API authorization hardening;
eslint/env/docs hygiene; OAuth connect-route account-takeover fix. Governance,
decisions, and the route-auth audit are under [`.ezra/`](.ezra/). Every commit
was verified (tests + typecheck + build green) before landing.
