# ADR 0001 — Phase-0 consensus review of the hardening plan

**Date:** 2026-07-20
**Status:** Accepted
**Models:** `openai/gpt-5.6-sol-pro` (for, 9/10) + `google/gemini-2.5-pro` (against, 6/10).
*(Nominated `gemini-3-pro-preview` returned 404 on OpenRouter — no live endpoint; substituted `gemini-2.5-pro` for the against seat. Logged as decision, not silently swapped.)*

## Points of agreement (both seats) → ADOPTED
1. **Schema/RLS discovery moves earlier** and the canonical local schema is established
   **before** the Playwright E2E rig — E2E must validate the real schema, not a guess.
2. **Protected main→prod deployment is a handover blocker** and needs an actual task, not
   just a note. Added as an explicit deliverable + Justin request R1.
3. **Test object/tenant authorization (IDOR), not only roles.** Matrix extended:
   unauthenticated / wrong-role / correct-role-wrong-record / correct / malformed input /
   expired session.
4. **Coverage thresholds focused on security- and business-critical modules**, not a
   repo-wide percentage.

## Accepted from FOR seat
- Split P4 → P4a (read-only prod introspection + RLS verify; needs only a least-privilege
  read-only DB connection, NOT the service key — lighter ask to Justin) then P4b (canonical
  local schema) before E2E.
- Secret-exposure audit widened to Vercel env + Expo config (git history already grep-clean).
- Observability + operational runbooks (backup restore, migration rollback, key rotation,
  incident response) added to HANDOVER.md scope.

## Accepted from AGAINST seat (partial)
- **xero_tokens RLS verification is elevated to the FIRST action of Phase 4** and carries a
  same-day crucial-flag if RLS is off. (NOT a standalone "P-Urgent" ahead of everything —
  see rejections; verification needs DB access we don't yet have, and P2 route guards land
  first precisely to provide interim defense-in-depth.)
- Mobile client security added as an explicit audit item in P5 (local token storage, no
  hardcoded secrets, API surface) — was previously only tsc/expo-doctor.

## REJECTED (with reason — honesty over deference)
- **"Reorder P4 schema BEFORE P2 route guards."** Rejected. Route guards are pure app code,
  deployable immediately, and give defense-in-depth *even if RLS is off* — that is exactly
  why they go first. The against-seat's "tests built on unstable schema" concern doesn't
  apply: P2 route tests mock the Supabase seam (London) and assert status-code contracts,
  which are independent of physical table DDL. P1 lib tests are pure functions (no data layer).
- **"Eradicate the service_role key from all API routes / it's god-mode exposed in the
  backend."** Rejected as overstated. The service key is a server-only env var (never
  NEXT_PUBLIC_, verified not committed). Its use in `staff/*`, `push-invoice`, and the
  sync routes is legitimate server-side admin work behind auth. The real, narrower defect
  — already in P2 — is that two sync routes authenticate but don't authorize before the
  service-role write. Wholesale removal + "rely entirely on RLS" would break admin
  operations that intentionally act across users. We centralize the key in one seam
  (`lib/supabase/admin.ts`) and gate every caller instead.
- **"xero_tokens is an active breach → hotfix before any other work."** Tempered: it's a
  *potential* exposure (RLS unverified, not confirmed-off). We cannot verify or hotfix
  without DB access from Justin (requested). Meanwhile P2 route guards reduce the blast
  radius. If Phase 4 finds RLS actually off, THEN it becomes a same-day interrupt.

## Net plan changes
- P4 split into P4a (introspect/verify, needs read-only DB URL) + P4b (canonical schema),
  sequenced **before** P3 (E2E). New phase order: P1 → P2 → P4a → P4b → P3 → P5 → P6.
- Ask Justin for a **read-only DB connection string** for P4a (separate, lighter than the
  service key which is only needed for the P4b prod *apply* step).
- Mobile security audit promoted to a real P5 item.
- HANDOVER.md scope expands to runbooks + observability recommendations.
