# Mellerick

Job-management platform for Mellerick Plumbing & Drainage: jobs, scheduling,
time tracking, quoting/invoicing (with Xero sync), backflow compliance testing,
fleet/equipment costing, and staff management. A Next.js 15 web dashboard plus a
React Native (Expo) mobile app for field technicians, sharing one Supabase
backend.

## Stack

- **Web:** Next.js 15 (App Router), React 19, Tailwind 4, shadcn/base-ui
- **Backend:** Supabase (Postgres + Auth + Storage), row-level security
- **Mobile:** Expo (SDK 54), Expo Router — see [`mobile/`](mobile/)
- **Integrations:** Xero (invoicing), Google Calendar, Resend (email),
  OpenAI (voice transcription/notes), Anthropic (backflow data-plate scanning)
- **Hosting:** Vercel (auto-deploys `main` to production)

## Prerequisites

- **Node 22** (pinned in [`.node-version`](.node-version) / `engines`).
  Node 25 breaks `@supabase/ssr` server-side — use a version manager (`fnm`,
  `nvm`) to select 22.
- A Supabase project (URL + keys).

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill in the values
npm run dev                    # http://localhost:3000
```

At minimum you need the three Supabase variables in `.env.local`
(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`). Every other variable feature-gates an optional
integration — see [`.env.example`](.env.example) for the full annotated list.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build (lint + typecheck enforced) |
| `npm test` | Run the unit test suite (Vitest) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:coverage` | Unit tests with a coverage report |
| `npm run lint` | ESLint |

## Testing

Unit and route-authorization tests run with Vitest and need no external
services (Supabase seams are mocked):

```bash
npm test
```

Coverage is scoped to the security- and business-critical modules (pricing,
cost, authorization) rather than repo-wide. RLS and end-to-end tests (against a
local Supabase stack) are being added — see the hardening plan in `.ezra/plans/`.

## Database

Schema lives in [`supabase/`](supabase/): `schema.sql` is the baseline and
`migrations/` holds the ordered changes. Apply them with the Supabase CLI
(`supabase db reset` against a local stack, or `supabase db push` to a project).

## Deployment

Vercel builds and deploys every push to `main` to production. Work on a branch
and open a pull request; production updates when the PR is merged. Cron routes
(`/api/xero/poll-invoices`, `/api/google/poll-calendar`) are scheduled in
[`vercel.json`](vercel.json) and authenticated with `CRON_SECRET`.
