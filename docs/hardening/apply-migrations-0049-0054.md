# Applying migrations 0049–0054

Six drafted migrations, in the order to run them, with the gate that decides
whether to continue after each.

Everything in the "Verified" column below was measured against **production**
(`ntdohrsujnyuqyeirqva`) on 2026-08-11, read-only, immediately before this was
written. Re-run the precondition query if more than a few days have passed.

---

## Where production actually is

```
supabase_migrations.schema_migrations  →  0000 … 0048
```

0049–0054 are absent, which matches every draft's `STATUS:` header.

## Preconditions, measured

| | What was checked | Verified |
|---|---|---|
| **0049** | `user_can_manage_job` already exists? | no — clean create |
| | the three buckets it creates | **all 3 already exist**, so its bucket block is a no-op |
| **0050** | additive RPC helpers only | nothing to conflict with |
| **0051** | rows that would REJECT the CHECK constraint | **0** (of 4 rows with a `clock_out`) |
| **0052** | its five indexes already present | **0** — all five are new |
| **0053** | policies in scope (excluding the token tables) | **27**, of which **10** are already wrapped |
| **0054** | the four functions it revokes, used in a policy | **0** — none are policy-bearing |

Two notes before you start:

- **0053's own header cites different numbers** ("52 unwrapped occurrences, 66
  total, 14 already wrapped"). Those were measured before 0047 and 0048 landed.
  The counts above are current. Nothing about the migration changes; its
  commentary is just older than the database.
- **0051 will validate.** A `CHECK` constraint is verified against every
  existing row at `ALTER TABLE` time and refuses the whole statement if one
  fails. Zero rows fail today. If someone logs a bad time entry between now and
  when you run it, it will refuse — that is the constraint doing its job, not a
  broken migration.

---

## Setup

```bash
export SUPABASE_DB_URL='postgresql://postgres:<password>@db.ntdohrsujnyuqyeirqva.supabase.co:5432/postgres'
```

Take a snapshot first. Supabase's dashboard has point-in-time restore on paid
plans; if you are not on one, run a `pg_dump` before step 4.

```bash
psql "$SUPABASE_DB_URL" -c "select count(*) from supabase_migrations.schema_migrations;"
```

Expect 49.

---

## The order, and why

Additive first, RLS last, and the policy rewrite entirely alone.

### 1 — 0050, atomic replace helpers · *additive, no policy change*

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0050_atomic_replace_helpers.sql
```

Creates three functions. Deliberately **not** `SECURITY DEFINER` — the migration
asserts that itself.

**Gate:** the statement succeeded. Nothing in the app calls these yet; they make
the two insert-then-compensate workarounds unnecessary later.

### 2 — 0051, time-entry duration constraint · *validates against existing rows*

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0051_time_entry_duration_constraint.sql
```

**Gate:** it either applies or names the row that blocked it. If it refuses,
stop and look at that row — it is a real bad time entry, and
`labour-billing-sync` has been pricing it onto a customer's bill.

### 3 — 0052, five foreign-key indexes · *additive*

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0052_foreign_key_indexes.sql
```

`CREATE INDEX` takes a lock that blocks writes to that table for its duration.
These tables are small (827 jobs), so it is seconds — but run it outside a busy
period regardless.

**Gate:**

```bash
psql "$SUPABASE_DB_URL" -c "select indexname from pg_indexes where schemaname='public' and indexname like 'idx_%' order by 1;"
```

### 4 — 0049, scope job-media deletes · *first real RLS change*

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0049_scope_job_media_delete_to_the_job.sql
```

Four surfaces: 8 storage.objects policies, a restrictive `job_photos` DELETE
policy, a `jobs.assigned_to` trigger, and a restrictive `jobs` DELETE policy.
The migration asserts each.

**Gate — run both, and read them:**

```bash
psql "$SUPABASE_DB_URL" -f supabase/tests/0049_storage_delete_scoping_test.sql
psql "$SUPABASE_DB_URL" -f supabase/tests/money_boundary_sweep.sql
```

Then, in the app: sign in as a **technician**, open a job **not** assigned to
them, and try to delete a photo. It must refuse. Then delete one on their own
job — it must work. The assertions prove the policies exist; only this proves
they discriminate.

**After it is applied**, two things in the repo become stale by design:

- `supabase/migrations/0049_*.sql` — change its `STATUS:` line. A test fails the
  build until you do.
- `components/job/job-photos.tsx` and `mobile/lib/data/gateway.supabase.ts`
  describe 0049 in the conditional ("would scope…"). Once applied they can be
  stated as fact, and `tests/unit/draft-migration-claims.test.ts` stops
  requiring the caveat automatically — it derives the draft set from the
  `STATUS:` headers.

### 5 — 0054, take four functions off the public API · *grants only*

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0054_revoke_rpc_on_internal_functions.sql
```

Revokes `EXECUTE` from `anon` and `authenticated` on four functions that no
policy uses. It asserts, in the same statement, that `authenticated` **still**
has EXECUTE on `is_admin` and `is_office_or_admin` — the two that 37 policies
call and that must never be revoked.

**Gate:** sign in and load a job list. If the assertion passed this cannot have
broken the app; check regardless.

### 6 — 0053, wrap the role check · *LAST, ALONE, DIFFERENT DAY*

Do not run this in the same window as the steps above.

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0053_wrap_is_office_or_admin_in_select.sql
```

It rebuilds ~17 live RLS policies from `pg_policy`. **It is a performance change,
not a correctness one** — `is_office_or_admin` is STABLE, so wrapping it in a
scalar subquery makes it an InitPlan evaluated once per query instead of once per
row. Nobody gains or loses access. There is no urgency whatsoever, and this is
the operation that produced both previous outages.

**Gate — this is the one that matters:**

```bash
psql "$SUPABASE_DB_URL" -f supabase/tests/money_boundary_sweep.sql
psql "$SUPABASE_DB_URL" -f supabase/tests/0035_rls_role_impersonation_test.sql
```

`money_boundary_sweep.sql` raises `MONEY BOUNDARY BREACHED` if a technician can
read a money column. If 0053 rebuilt a policy wrongly, that is where it shows —
not in a slow query.

Then sign in as a technician **and** as an office user and load: a job, the
invoice list, and the schedule. The migration's own assertions prove the policy
TEXT changed correctly. Only a real session proves the boundary still holds.

**Rollback:** re-run 0027, 0028, 0030, 0035, 0038 and 0042 in order. They
recreate the same policies in the bare form, which is functionally identical.

---

## After all six

```bash
npm run check:drift
npm run check:migrations
psql "$SUPABASE_DB_URL" -c "select count(*) from supabase_migrations.schema_migrations;"
```

Expect 55.

Update each applied file's `STATUS:` header. `migration-header-truth.test.ts`
fails the build while a file claims DRAFT after being applied, and
`draft-migration-claims.test.ts` releases the code comments that currently hedge
about 0049.

**Progress (2026-08-22):** 0050, 0051, 0052, 0049 and 0054 applied to
production and gate-tested, in that order, via `supabase db query --linked`
(no `SUPABASE_DB_URL` on this machine, so the Management-API path was used
instead of raw `psql`; each migration's ledger row was inserted by hand
afterward, since that path does not update
`supabase_migrations.schema_migrations` the way `db push` does). Ledger count
is 54, not 55 — **0053 was deliberately skipped**, per its own "LAST, ALONE,
DIFFERENT DAY" instruction above. Schedule it separately.

## If something goes wrong

Each of these is a single `psql` invocation with `ON_ERROR_STOP=1`, and a failing
assertion inside a `DO $$` block aborts that statement — so a half-applied
migration is not a state you should reach. If you do:

1. Stop. Do not run the next one.
2. `psql "$SUPABASE_DB_URL" -f supabase/tests/money_boundary_sweep.sql` — decide
   first whether the money boundary is intact.
3. Then the rollback for that specific file, listed in its own header.
