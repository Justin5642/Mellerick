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
- **Not yet built** (blocked, see §8): RLS integration tests and Playwright E2E
  — both need a local Supabase stack (Docker).

## 6. Database & migrations

`supabase/schema.sql` is the baseline; `supabase/migrations/` holds ordered
changes (0001–0033). Apply with the Supabase CLI. **Known gap**: `xero_tokens`
and `time_entries` were created directly in production and are NOT in the
versioned SQL — so a from-scratch `supabase db reset` currently fails, and the
RLS policy on `xero_tokens` (which stores Xero OAuth tokens) is unverified. This
is the top item in §8.

## 7. Deployment

Vercel auto-deploys every push to `main` to production. **Recommended**: enable
branch protection on `main` and point `main` at a preview/staging environment so
production deploys become deliberate. CI (`.github/workflows/ci.yml`) runs
typecheck, unit tests, and build on every PR. Cron routes are scheduled in
`vercel.json` and authenticated by `CRON_SECRET`.

## 8. Outstanding work (blocked on external input)

1. **Verify & version `xero_tokens` / `time_entries` (HIGH).** Needs a read-only
   production DB connection to introspect and diff. First action: confirm RLS is
   ON for `xero_tokens`; if off, any authenticated user could read the org's
   Xero OAuth tokens — fix in the Supabase dashboard same-day. Then add a
   migration so the versioned SQL can rebuild production.
2. **RLS integration + Playwright E2E tests.** Need Docker + a local Supabase
   stack seeded with per-role users.
3. **Deployment gating** (branch protection, staging) — Justin/owner action.
4. Lower-severity route tightening and open questions: see
   [DECISIONS-FOR-AVI.md](DECISIONS-FOR-AVI.md).

## 9. What changed in the hardening pass

Branch `hardening/production-readiness`. Commits, in order: toolchain pin + Next
security patch + CI; Vitest unit infra; API authorization hardening;
eslint/env/docs hygiene; OAuth connect-route account-takeover fix. Governance,
decisions, and the route-auth audit are under [`.ezra/`](.ezra/). Every commit
was verified (tests + typecheck + build green) before landing.
