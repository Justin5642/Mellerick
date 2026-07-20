# ADR 0002 — Phase 2 API authorization hardening & validator review

**Date:** 2026-07-20
**Status:** Accepted

## What changed
Introduced two shared seams — `lib/api/guards.ts` (requireUser/requireRole/
requireAdmin/requireOfficeOrAdmin/requireCronSecret) and `lib/supabase/admin.ts`
(the single service-role client factory) — plus `lib/api/job-authz.ts` for
per-record checks. Applied them to the eight previously unguarded or
authenticated-but-unauthorized routes; escaped outbound email HTML
(`lib/html.ts`); added an in-memory rate limit to the geocode proxy.

## Authorization model
- Config routes (xero expense/sales account codes) → office/admin.
- google/disconnect → admin.
- sync-calendar, geocode → any authenticated user.
- sync-billing (job + time-entry) → office/admin OR the technician assigned to
  the job (preserves the mobile self-heal; blocks cross-job tampering).
- backflow submit → office/admin OR the tester (`tested_by`); certificate (read)
  → any authenticated staff.
- Cron routes → CRON_SECRET, fail-closed.

## Validator review (PAL, Phase-2 gate)
Nominated `openai/gpt-5.6-sol-pro` was transiently failing on OpenRouter
(timeout, then upstream NoneType error) and `x-ai/grok-4.1-fast` is deprecated
(404 → Grok 4.3). Fell back to `google/gemini-2.5-pro`. Outcome: **no
code-changing security defects.** Confirmed: (a) Supabase `auth.getUser(token)`
validates JWT signature + expiry, so forged/expired Bearer tokens cannot pass;
(b) `job.assigned_to === userId` correctly blocks technician cross-job access;
(c) treating a role-read error as null → 403 is the correct fail-closed direction.
Sole caveat: risk of *inconsistent* application across routes — mitigated by the
full route-auth audit scheduled in Phase 6 (every `app/api/**` route gets an
explicit auth assertion).

## Follow-ups logged
- Model availability drift in PAL registry (sol-pro flaky, grok-4.1 deprecated) →
  DECISIONS-FOR-AVI D-model.
