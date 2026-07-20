# Decision Log — Production Hardening Branch

Non-blocking questions and decisions made during the hardening build, indexed for
review in the cleanup phase (Phase 6). Items marked **CRUCIAL** were (or must be)
raised with Avi immediately; everything else awaits batch review.

## Open questions for Avi (answer in Phase 6 or earlier)

| # | Question | Default applied meanwhile |
|---|---|---|
| Q1 | `sync-billing` routes: should assigned technicians be able to trigger a billing re-sync on their own jobs (self-heal), or office/admin only? | Office/admin **or** the technician assigned to the job |
| Q2 | Backflow submit/certificate: same question — assigned tech + office/admin, or office only? | Assigned tech + office/admin |
| Q3 | `gpt-oss-120b` (free, Groq) is OpenAI-lineage. Excluded from worker pool per "no OpenAI models" rule. Re-admit? | Excluded |
| Q4 | Repo is public. Recommend Justin makes it private (commercial app). Should Avi raise this with him? | Raised in handover notes |

## Requests to Justin (Avi to relay)

| # | Request | Status |
|---|---|---|
| R1 | Enable branch protection on `main` + point Vercel `main` at a preview/staging env so production deploy becomes a deliberate action (consensus: handover blocker) | Pending |
| R2a | Provide a **read-only** Postgres connection string — unblocks Phase 4a introspection + RLS verification (lighter than the service key) | Pending |
| R2b | Provide `SUPABASE_SERVICE_ROLE_KEY` — needed only for the Phase 4b prod migration *apply* step | Pending |
| R3 | Consider making repo private (commercial app) | Pending |
| R4 | Confirm RLS status on `xero_tokens` in Supabase dashboard (we also verify in Phase 4a; if OFF it's a same-day fix) | Pending |

## Decisions made (with rationale)

| # | Decision | Why |
|---|---|---|
| D1 | Validator model = `openai/gpt-5.6-sol-pro` (nominated "Sol Ultra"; no ultra SKU exists — sol-pro is top Sol tier). Verified live via PAL. | Closest real model to nomination |
| D2 | Found PAL config aliases masquerading `gpt-5.6`→`gpt-5.2-pro` and `claude-fable-5-ultracode`→`claude-opus-4.5`. Repointed the 5.6 aliases at the real `openai/gpt-5.6-sol-pro`. The fable alias masquerade left in place (unused by this build — orchestrator runs natively). | Honesty: Avi forbade gpt-5.2-pro; the alias would have silently used it |
| D3 | PAL calls use full model IDs (`openai/gpt-5.6-sol-pro`, `z-ai/glm-5.2`) — registry aliases only load at PAL restart | Verified pass-through works now |
| D4 | `.claude/` added to `.gitignore` (local dev launcher config, not project code) | Machine-specific |
| D5 | Node pinned to 22 (`.node-version` + `engines`) — Node 25's experimental `localStorage` global breaks supabase-js auth on the server | Reproduced locally this session |
| D6 | Next.js security patch taken day 1, before test infra (dep bumps exempt from red-green; verified by build + smoke) | Known advisories live in prod |
| D7 | Mobile app: `expo-doctor` + tsc check only; full device E2E out of scope this branch | Separate deploy pipeline (EAS), no shared infra |
| D8 | Docker daemon not running at Phase 0 check — Docker Desktop present (v29.1.3). Will start when Phase 3/4 needs the local Supabase stack | Not needed earlier |
