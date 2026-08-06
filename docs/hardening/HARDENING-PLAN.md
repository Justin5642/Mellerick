# Mellerick — hardening programme

**Baseline:** `ae5287e`. Source of truth for scope: `TODO-VERIFIED-2026-08-05.md`.
**Started:** 5 Aug 2026.

---

## Consensus round (PAL MCP)

Requested panel: `anthropic/claude-fable-5` and `openai/gpt-5.6-sol-pro`.

**Fable 5 responded in full (confidence 8/10).** The second panellist could not be
reached — PAL timed out twice and then the `onemcp` server went offline. Recorded here
rather than silently dropped. **The plan below therefore rests on one external panellist
plus my own analysis, not two.** Flagged for the cleanup phase as decision **D-01**: re-run
the second opinion when PAL is back, and reconcile.

### Where Fable 5 and I agreed

- **TDD school is hybrid, assigned deliberately.** Detroit/classicist for the offline sync
  engine (outbox, geofence, reads) — the defects are emergent from real interactions
  between queue, clock and network, and London-school mocking is precisely what hid them.
  London at the HTTP route and authorization boundary, where the collaborator contract *is*
  the thing under test.
- **Completion bar.** Every item ends in one of two terminal states:
  - **VERIFIED** — a named test exists, was *observed failing* before the fix, passes after,
    and runs in CI.
  - **BLOCKED-EXTERNAL** — a written reproduction procedure, the specific client credential
    or dashboard required, and a `skip`-with-reason stub in the repo.
- **Negative control is mandatory, not optional.** A test that has never been seen to fail
  is not evidence.

### Where Fable 5 changed my mind

I argued test-infrastructure-first, because this codebase's three worst defects share one
shape: *the check and the thing being checked were not the same thing.*

Fable rejected that as a false dichotomy, and it is right. C1/C2 accrue unpaid wages every
day in production, and they do **not** depend on the full CI chain to be provable — a
targeted fault-injection test at the data-layer seam is sufficient. Delaying a live payroll
defect behind CI rework is not justified by the verifiability concern.

**Adopted order:** C1/C2 + C4 → test infrastructure (N6/N7/0.3/1.14 + vacuous tests) → C5 →
C3 → remainder.

### Where I overrode Fable 5

Two points I raised for stress-testing. The second panellist was unavailable to adjudicate,
so I am recording my reasoning explicitly rather than quietly picking a side.

**(a) The test seam for C1/C2.** Fable prescribed "targeted tests against a real Postgres".
That mis-models the system. C1/C2 are React Native geofence callbacks whose failure mode is
*a network read failing while offline*. Real Postgres is both unnecessary and unavailable in
the mobile Jest environment. The correct seam is the **data layer plus the injected
gateway/connectivity fake**, and the assertion is on **outbox contents and the cursor
value** — never on a database. Adopted my formulation.

**(b) The money invariant.** Fable prescribed enumerating money *columns* via
`information_schema`. Insufficient. This system leaks money through **three** channels, and
a column enumeration can only see one:

| Channel | Enforced by | Why columns alone miss it |
|---|---|---|
| Table columns | RLS + column grants | — |
| Storage objects | bucket policies | a receipt is a file, not a column |
| Sync-stream replication | `sync-streams.yaml` | PowerSync replicates with its **own** credentials and bypasses RLS entirely |

Confirmed against production: a technician could read 2 expense receipts and 1 supplier
invoice — invisible to any column sweep. The gate must cover all three.

Fable's core insight stands and is adopted: **convert the contractual invariant into an
enforced property that also protects against the client's own future commits.**

---

## Phases

| # | Scope | Exit criterion |
|---|---|---|
| **1** | C1, C2, C4 — silent labour loss + startup crash | Fault-injection tests at the data-layer seam, each observed failing at HEAD first |
| **2** | N6, N7, 0.3, 1.14, 0.4, 0.5, S5 + the six vacuous tests | CI applies 47/47 migrations; 0 orphaned test files; three-channel money gate enforced |
| **3** | C5, C3 — money path + travel legs | Negative control per fix |
| **4** | Mobile robustness: 1.10, 1.11, 2.7–2.14, C6, C10, C11, N11, N12 | Full mobile suite + drift analysis clean |
| **5** | Web correctness + security: S3/1.5, 1.1, 1.2, 1.6–1.9, 2.1–2.6, 2.18–2.20 | Full web suite + security re-audit clean |
| **6** | Schema, infra, hygiene: 2.21–2.24, 3.1–3.19, N3, N4, N13–N16 | Lint/typecheck/drift clean |
| **7** | Cleanup: residuals, decisions index, granular e2e, final gap/drift | Every item VERIFIED or BLOCKED-EXTERNAL |

After every phase: full suite, gap and drift analysis, remediation loop until clean.

---

## Standing rules for this programme

1. **Observe the test failing at HEAD before writing the fix.** No exceptions. The six
   vacuous tests in this repo prove that the process, not just the code, produced false
   confidence.
2. **Assert on persisted outcomes, never on "method was called"** — in the sync engine.
3. **No mocked test may be the sole evidence for a defect the database can refuse.**
4. **Nothing merges to `main`** — it auto-deploys to production and the repo is the
   client's. Work lands on branches and PRs.
5. **No migration is applied to the client's production database.** Drafts are dry-run
   inside `BEGIN … ROLLBACK` and handed over.

---

---

## Progress

### Phase 1 — labour integrity · COMPLETE · [PR #16](https://github.com/Justin5642/Mellerick/pull/16)

| Item | Result |
|---|---|
| **C1** offline arrival discarded | CLOSED — `geofenceTransition.ts` models the `unknown` lookup state; the cursor advances only on a durable conclusion |
| **C2** offline departure discarded | CLOSED — same contract |
| **C4** red-screen crash from static native import | CLOSED — guarded require + `backgroundSync.guard.test.ts` |
| **N18** *(new)* foreground/background disagreed on `auto_clocked` | CLOSED |
| 2.6 (mobile half) | CLOSED |

Mobile 473 tests / 71 suites (was 458/69), tsc clean. Negative controls: reverting the
unknown-handling fails exactly the two regression tests; the four guard tests fail against
the static imports.

### Phase 2 — test infrastructure · COMPLETE · same PR

| Item | Result |
|---|---|
| **N6/0.3** CI seeded from the hole itself | CLOSED — fixture deleted |
| **1.14** CI applied 3 of 47 migrations | CLOSED — full chain, and it applies cleanly end to end for the first time |
| **N7** five SQL tests run by nothing | CLOSED — they gate the build |
| **0.5** vacuous RLS assertions | CLOSED — seeded, with a positive control per assertion |
| **S5** money detector missed every snake_case column | CLOSED — per-column classification, 20 tests of its own |
| **N19** *(new)* | see below |

Web 229 tests (was 203), tsc clean, lint 0 errors. **All GitHub checks pass**, including
`rls` and `e2e`.

#### The negative control that matters

A throwaway branch reverted `0044`'s role-escalation trigger to `if false then`. Result:

```
technician self-promotes     | BLOCKED  | ALLOWED | *** FAIL ***
ERROR: 1 scenario(s) FAILED — profiles.role is not properly protected
```

`unit` and `mobile` still passed — so only the rebuilt gate catches it, and before this work
**nothing in CI would have**. Throwaway PR and branch deleted.

#### What running the tests for the first time revealed

**N19 — the migration history does not reproduce production.** Production grants `anon` and
`authenticated` INSERT/UPDATE/DELETE on the public tables; **not one migration creates those
grants** (`grep -i "grant .*insert"` over `supabase/migrations` returns nothing). They come
from Supabase's default privileges on the hosted project. Without them `0045` fails its own
assertion. **Consequence beyond CI: `supabase db reset` produces a database where a
technician cannot clock in at all.** Worked around in CI; still needs a migration.

**Four of the five "security tests" were non-functional** — not merely unautomated:

| File | Defect |
|---|---|
| `0035_rls_role_impersonation_test.sql` | collided on `profiles_pkey` — its own `auth.users` insert fires `on_auth_user_created`, which already creates the profile |
| `0038_rls_po_money_test.sql` | same collision |
| `0045_rate_override_test.sql` | missing semicolon — never parsed |
| `money_boundary_sweep.sql` | `~*` and `||` share precedence, so the WHERE clause evaluated to text, not boolean |

All four fixed. N7 understated the problem: these could not have run at all.

---

## Decisions index (for the cleanup phase)

Populated as the build proceeds. See `DECISIONS-PENDING.md`.
