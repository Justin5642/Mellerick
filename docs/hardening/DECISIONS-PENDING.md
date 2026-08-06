# Decisions and questions for Avi — indexed for the cleanup phase

Anything needing a human call, logged as encountered so the build does not stop.
**Nothing here is blocking unless marked CRITICAL.**

| ID | Raised | Status | Decision needed |
|---|---|---|---|
| D-01 | Phase 0 | open | **Re-run the second consensus panellist.** `openai/gpt-5.6-sol-pro` was unreachable (PAL timed out twice, then `onemcp` went offline). The plan rests on one external panellist plus my analysis. Two of its points I overrode unilaterally — the C1/C2 test seam and the money-invariant formulation — and both are recorded with reasoning in `HARDENING-PLAN.md`. Worth a second opinion when PAL is back. |
| D-02 | Phase 0 | open | **`main` auto-deploys to production.** Every fix in this programme lands on a branch. Someone has to decide merge order and timing, and 13 items cannot be closed without client account access at all. Confirm you want branch-and-PR throughout, or nominate someone with merge rights. |
| D-03 | Phase 0 | open | **Migrations are not applied.** `0047` (storage policy scoping) is drafted and dry-run but needs Justin. Any further migration this programme produces will be handled the same way. |
| D-04 | Phase 2 | **open — needs a decision** | **N19: the migration history does not reproduce production.** Production grants `anon`/`authenticated` INSERT/UPDATE/DELETE on the public tables; no migration creates them (they come from Supabase's hosted default privileges). So `supabase db reset` yields a database where a technician **cannot clock in at all**, and `0045` fails its own assertion. CI now works around it explicitly. The proper fix is a migration making the grants explicit — but that changes production semantics on a client database, so it is yours and Justin's call, not mine. |
| D-05 | Phase 2 | informational | Four of the five hand-run SQL security tests were **non-functional**, not merely unautomated (two `profiles_pkey` collisions, one missing semicolon, one operator-precedence bug making a WHERE clause non-boolean). All fixed. Worth knowing when judging how much prior "verified" evidence to trust. |
