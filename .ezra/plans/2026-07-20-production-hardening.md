# Mellerick — Production Hardening & Handover Remediation Plan

## Context

The Mellerick app (Next.js 15 + Supabase web dashboard, plus Expo mobile app) is a
feature-complete job-management platform for Mellerick Plumbing & Drainage (Justin
Mellerick's business). Deep review this session found the product functionally finished
— all ~16 dashboard areas and the mobile app are real implementations, zero stubs — but
**not production-hardened**:

- **Zero tests, zero CI, zero git hooks** (verified: no test script, no framework, no `.github/`)
- **Security gaps** (verified by direct file reads): 4 unguarded API routes, 4
  authenticated-but-unauthorized service-role routes, unauthenticated geocode proxy
- **Schema drift**: `xero_tokens` (holds Xero OAuth tokens) and `time_entries` exist only
  in production — never created in versioned SQL; RLS on `xero_tokens` unverifiable from repo
- **Dependency risk**: `next@15.3.9` has high-severity advisories (within-minor fix
  available); `eslint-config-next@16.2.9` mismatches Next 15; lint skipped during builds
- **Process risk**: public repo; push to `main` auto-deploys to production on Justin's
  Vercel; machine default Node 25 breaks supabase-js (dev must pin Node 22)

Goal (user-confirmed): **harden what exists** to production quality — TDD for every fix,
full test coverage, security hardening, CI gates — delivered on a branch + PR to Justin.
No new features.

## User-confirmed decisions

| Decision | Answer |
|---|---|
| Scope | Harden existing features only (no stubs exist to finish) |
| Live DB access | Avi obtains `SUPABASE_SERVICE_ROLE_KEY` / DB URL from Justin — **hard prerequisite for Phase 4** (schema work); earlier phases proceed without it |
| Delivery | Branch `hardening/production-readiness`; PR to Justin; he merges → deploy |
| Consensus models | Fable 5 (this session, native) = orchestrator. GPT validator: **`openai/gpt-5.6-sol-pro`** via OpenRouter — confirmed live in OpenRouter's catalog (closest match to nominated "GPT 5.6 Sol Ultra"; no literal "ultra" SKU exists — sol-pro is the top Sol tier). Not yet in PAL's registry → **Phase 0 step 1 sets it up**: add to PAL's custom-model config, reconnect, verify with a test call. If the OpenRouter account can't access it (credits/permissions), crucial-flag Avi before proceeding |
| Worker pool | Non-Anthropic/non-OpenAI only: `z-ai/glm-5.2` (confirmed live on OpenRouter; added to PAL registry in Phase 0), `gemini-3-pro-preview`, `x-ai/grok-4.1-fast`, `deepseek-r1-0528`, `mistral-large-2411`, `qwen3-32b`, `llama-3.3-70b` (Groq). `gpt-oss-120b` excluded (OpenAI lineage) — logged for cleanup review |

## Orchestration & governance

- **Orchestrator**: Fable 5 (this session). **Validator/tester**: `openai/gpt-5.6-sol-pro`
  (set up in PAL at Phase 0) — via PAL `codereview`/`precommit` at every phase gate.
- **Phase-0 consensus**: PAL `consensus` (`openai/gpt-5.6-sol-pro` for,
  `gemini-3-pro-preview` neutral/against) stress-tests this plan; accepted amendments
  folded in before build.
- **Cheap workers** (PAL): mechanical review sweeps `z-ai/glm-5.2`; second-opinion
  debugging `deepseek-r1`; docs drafting `llama-3.3-70b`.
- **EZRA**: `/ezra:init` at build start; ADR per phase decision; drift checks at gates.
- **Non-blocking questions** → `DECISIONS-FOR-AVI.md` (indexed, resolved in cleanup).
  Only production-risk items interrupt Avi (defined below).

## Test stack (designed this session)

Single runner **Vitest** for everything except E2E; Windows-friendly; minimal deps:
`vitest@^3.2` + `@vitest/coverage-v8`, `@playwright/test@^1.54` (chromium only),
`supabase@^2` CLI as devDependency (local stack via Docker Desktop), `cross-env`, `dotenv-cli`.
Vitest **projects**: `unit` (lib + route tests, fully mocked, runs anywhere) and `rls`
(needs `supabase start`).

- **API route tests**: invoke exported handlers in-process (`await POST(new NextRequest(...))`,
  params as `Promise.resolve({id})`). Mock at the existing seam `@/lib/supabase/server`
  plus a **new 10-line seam** `lib/supabase/admin.ts` (`createAdminClient()`) extracted from
  the inline service-role constructions — 2-line diff per route, and makes the service key
  grep-able in exactly one file. Shared thenable-Proxy mock builder in
  `tests/helpers/supabase-mock.ts`. Never mock `next/headers` or `@supabase/ssr` directly.
- **RLS tests**: real local Supabase stack; global setup seeds admin/office/technician
  users, signs in each with supabase-js; suites assert the role access matrix on
  `xero_tokens`, `time_entries`, financial tables (finally regression-covers 0027/0028/0030).
  pgTAP rejected (second toolchain, doesn't test through PostgREST).
- **E2E**: Playwright vs `next build && next start` + local Supabase; real UI login once
  per role in globalSetup → saved `storageState` per role; ~8–12 smoke specs.
- **TDD schools**: lib/ = Detroit (real collaborators, assert outcomes);
  `labour-billing-sync` = hybrid (client already DI'd — fake only that boundary);
  API routes = London (contract: status per role, `expect(admin.from).not.toHaveBeenCalled()`
  on 401/403); RLS & E2E = Detroit/classicist by nature.

## Phases

Gate first → cheapest safety net → highest live risk → changes needing the net.
Every fix: failing test (verify red) → implement → verify green. Dep bumps exempt from
red-green (no behavior to specify) — verified by build + smoke instead.

### Phase 0 — Gate & toolchain pin (day 1, no app behavior change)
0. **Set up nominated models in PAL**: add `openai/gpt-5.6-sol-pro` (validator) and
   `z-ai/glm-5.2` (mechanical-sweep worker) to PAL's custom OpenRouter model registry
   (locate PAL install's model config, add entries, reconnect MCP); verify each with a
   one-line test call. Failure to resolve/bill → crucial-flag Avi before build starts.
1. Branch `hardening/production-readiness`; create `DECISIONS-FOR-AVI.md`.
2. `/ezra:init`; register this plan; PAL consensus run on the plan; fold amendments.
3. Pin Node: `.node-version` (22) + `package.json` `engines` — machine default is 25 and
   would break CI identically to the local dev failure already hit.
4. **Next.js security patch now**: `next` 15.3.9 → latest 15.x (within-minor advisory fix);
   verify `tsc --noEmit` + `next build` + manual smoke of dev server.
5. CI skeleton `.github/workflows/ci.yml`: lint/typecheck/build only (jobs grow per phase).
6. Request (logged, non-blocking): Justin enables branch protection + considers private repo.
7. Verify Docker Desktop present (needed Phase 4; fallback: Supabase branch database).

### Phase 1 — Unit test infra + lib/ suite (Detroit)
1. Vitest config (projects: unit/rls), setup file with dummy env, `tests/helpers/supabase-mock.ts`.
2. Characterization suites: `labour-billing-sync.ts` (highest value — hours banding, call-out
   fee, rate override), `equipment-cost.ts`, `staff-cost.ts`, `xero.ts` (`describeXeroError`),
   `business-info.ts`, `pdf/render.ts` (smoke render).
3. CI `unit` job added. Gate: suite green, coverage report generated.

### Phase 2 — API authorization hardening (London; the core security work)
Deliberately **before** DB work: guards are pure app code, deployable immediately,
defense-in-depth even if live RLS is off.
1. Extract `lib/api/guards.ts` (`requireUser`, `requireAdmin`, `requireOfficeOrAdmin`,
   `requireCronSecret`) — reuse pattern from `app/api/staff/invite/route.ts:11-21`;
   extract `lib/supabase/admin.ts`.
2. Red-green per route, one commit each:
   - `xero/expense-account-code`, `xero/sales-account-code` → `requireOfficeOrAdmin`
   - `google/disconnect` → `requireAdmin`
   - `jobs/[id]/sync-calendar` → `requireUser` + role check
   - `jobs/[id]/sync-billing`, `time-entries/[id]/sync-billing` → authorization after
     existing authentication (office/admin, or assigned-tech self-heal — product question
     logged for Avi; default: office/admin + assigned tech)
   - backflow `submit`/`certificate` → assigned-tech-or-office check; sanitize
     customer-name/address HTML interpolation in outbound email
   - `geocode` → `requireUser` (+ trivial in-memory rate limit)
3. Retrofit regression tests over already-guarded route classes (staff/*, push-invoice, crons).
4. Gate: full 401/403/200 matrix green across `app/api/**`.

### Phase 3 — E2E smoke rig (needs only local stack + seeded users)
1. Playwright infra, storageState per role, smoke tier: login, job list, clock in/out,
   invoice builder opens, backflow form renders, admin page 403s for tech.
2. CI `e2e` job (needs: build).
*(Ordered before schema work so the E2E rig exists to validate Phase 4's DB changes.)*

### Phase 4 — Schema versioning & RLS ⛔ *blocked on service key/DB URL*
1. `supabase init` (commit `config.toml`); `supabase start`; `db reset` applies
   schema.sql + 0001–0033 locally.
2. **Read-only** prod introspection: `supabase db dump --db-url … -f supabase/prod_schema_<date>.sql`;
   query `pg_class.relrowsecurity` + `pg_policies` for `xero_tokens`/`time_entries`.
   **If RLS is OFF on `xero_tokens` in prod → CRUCIAL FLAG: interrupt Avi immediately**
   (live exposure of Xero OAuth tokens; fix in dashboard same-day, ahead of the PR).
3. Diff local vs prod dump → `0034_reconcile_schema_drift.sql` (idempotent:
   `create table if not exists`, `enable row level security`, `drop policy if exists`/`create policy`)
   — near-no-op on prod, creates-from-scratch locally. Intended *policy changes* go in
   separate `0035` (drift capture vs behavior change reviewable independently).
4. RLS Vitest suite red-then-green locally; re-diff until only intended 0035 delta remains.
5. Prod apply: PITR/backup point → `supabase db push --dry-run` → `db push` →
   `supabase migration repair` (records 0001–0034 in prod history). CI `db-rls` job added.

### Phase 5 — Toolchain & hygiene
1. `eslint-config-next` → 15.x-matching; fix surfaced lint debt; flip
   `ignoreDuringBuilds` → false.
2. Remaining `npm audit` items to 0 high/critical.
3. `lib/env.ts` startup env validation; replace `process.env.X!` in touched files.
4. `.env.example` (names + comments only); README rewrite (real setup/runbook, replacing
   create-next-app boilerplate).
5. Coverage thresholds on lib/. Mobile: `expo-doctor` + tsc check only (shares no infra;
   full mobile E2E logged as out of scope).

### Phase 6 — Cleanup, gap/drift analysis, handover
1. Full suite (unit + rls + e2e) + coverage; fresh-clone verification
   (`git clone → npm ci → npm test → npm run build` on Node 22).
2. `/ezra:reconcile` gap-check vs this plan; remediation loop until zero drift.
3. PAL `precommit` (gpt-5.2-pro) over full branch diff; triage findings to zero.
4. Resolve every `DECISIONS-FOR-AVI.md` entry with Avi.
5. `HANDOVER.md`: architecture, env-var table, deploy runbook, test guide, security
   model, known limitations. 
6. Open PR to `main` with full description + green CI. **No merge without Justin** —
   his production deploys on merge.

### Every phase gate
Suite green (all layers so far) → `tsc --noEmit` + `next build` → PAL codereview on phase
diff (triaged) → EZRA drift check → tagged checkpoint commit.

## Verification (definition of done)

1. Fresh clone → `npm ci` → `npm test` → `npm run build`: all green on Node 22.
2. `supabase db reset` from versioned SQL alone succeeds (schema drift eliminated).
3. RLS matrix proven by tests: technician ✗ / office ✓ / admin ✓ on `xero_tokens` et al.
4. Every `app/api/**` route has explicit unauthenticated / wrong-role / correct-role tests.
5. Playwright smoke green against seeded local stack.
6. `npm audit`: 0 high/critical. Lint enforced in build.
7. PR open with all five CI checks green; HANDOVER.md complete; decision log resolved.

## Blockers & crucial-flag protocol

| Item | Status |
|---|---|
| Service key / DB URL from Justin | **Blocks Phase 4 only** — Phases 0–3 proceed now |
| Live `xero_tokens` RLS state | Checked first thing in Phase 4; OFF → interrupt Avi same-day |
| Docker Desktop | Verified in Phase 0; fallback Supabase branch DB |
| Branch protection / private repo | Justin action — requested day 1, non-blocking |

## Key files

New: `lib/api/guards.ts`, `lib/supabase/admin.ts`, `lib/env.ts`, `vitest.config.ts`,
`tests/**` (helpers, unit, rls, e2e), `.github/workflows/ci.yml`, `.node-version`,
`supabase/config.toml`, `supabase/migrations/0034+0035`, `.env.example`, `HANDOVER.md`,
`DECISIONS-FOR-AVI.md`.
Modified: the 9 API routes listed in Phase 2, `package.json`, `next.config.ts`,
`eslint.config.mjs`, `supabase/schema.sql`, `README.md`.
Reused: auth pattern from `app/api/staff/invite/route.ts:11-21`; DI seam already present in
`lib/labour-billing-sync.ts:52`; mock seam `lib/supabase/server.ts`.
