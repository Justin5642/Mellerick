-- ============================================================================
-- THE MONEY BOUNDARY, SWEPT EXHAUSTIVELY.
--
-- Run against the LIVE database; everything is inside a transaction that is
-- ROLLED BACK, so nothing is modified:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/money_boundary_sweep.sql
--
-- WHY THIS EXISTS, AND WHY IT IS NOT PATTERN-MATCHING.
--
-- "Technicians must never see dollar figures" is the hardest invariant in this
-- system. It is enforced in four places — RLS, the PowerSync sync rules, the
-- MoneyText/RoleGate UI guards, and the API route guards — and it had been
-- reviewed repeatedly. On 2026-08-04 an audit still found a live leak:
-- time_entries.rate_override was readable by a technician through PostgREST
-- with the anon key that ships inside the app.
--
-- It survived because every previous check reasoned about POLICIES. A policy
-- can look correct and still permit the read. This test does not read policies
-- at all: it enumerates every money-named column in the schema, impersonates a
-- REAL technician, and tries to actually SELECT it. What the database does is
-- the only evidence that counts.
--
-- READING THE RESULT — the distinction that matters:
--
--   • "blocked"            the read is refused outright (column grant revoked)
--   • "readable, 0 rows"   the grant exists but RLS returns NO ROWS. Safe: the
--                          technician can name the column and never sees a
--                          value. Verified separately that these tables DO hold
--                          rows as postgres — invoices 4, job_items 6,
--                          staff_cost_profiles 2 — so zero is RLS filtering,
--                          not an empty table.
--   • "READABLE WITH DATA" a leak. This is what rate_override looked like.
--
-- Only the third is a failure, and the test fails loudly on it.
--
-- A NOTE FOR WHOEVER RUNS THIS NEXT: an empty table proves nothing here. Most
-- of this schema was empty the first several times the boundary was "verified",
-- which is exactly how the leak survived. If a table is empty, seed it and rerun
-- before believing the result.
-- ============================================================================

begin;

create temp table sweep(tbl text, col text, verdict text, rows_seen int) on commit drop;

do $$
declare
  tech uuid;
  rec record;
  n int;
begin
  select id into tech from profiles where role = 'technician' limit 1;
  if tech is null then
    raise exception 'fixture missing: no technician profile to impersonate';
  end if;

  for rec in
    select c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema
     and t.table_name  = c.table_name
     and t.table_type  = 'BASE TABLE'
    where c.table_schema = 'public'
      -- Money-shaped names. Deliberately broad: a false positive costs one line
      -- of output, a false negative costs a leak.
      --
      -- WIDENED 2026-08-04 after a review asked what this MISSED. The original
      -- list skipped four genuinely money-bearing columns —
      -- billing_rate_config.call_out_fee and equipment's insurance_annual /
      -- maintenance_annual / registration_annual — so the sweep had been
      -- reporting "0 leaks" without ever looking at them. They turned out to be
      -- safe (RLS denies the rows: equipment holds 21 priced rows and a
      -- technician sees 0), but the test had no way of knowing that.
      --
      -- A test that silently under-samples is the same failure mode as a read
      -- that silently returns []. Hence the unmatched-column report below,
      -- which makes the blind spot visible instead of leaving it to the next
      -- reviewer to guess at.
      -- PARENTHESISED, and that is not cosmetic. `~*` and `||` sit in the same
      -- precedence class and are left-associative, so
      --     c.column_name ~* 'A' || 'B'
      -- parses as ((c.column_name ~* 'A') || 'B') — a boolean concatenated with
      -- text — and the whole WHERE clause fails with "argument of AND must be
      -- type boolean, not type text". This script could not execute at all until
      -- CI began running it.
      and c.column_name ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                         || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                         || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
      -- ...minus foreign keys and identifiers, which carry no value.
      and c.column_name !~* '(_id$|^id$|cost_center_id|rate_config_id|_number$)'
    order by c.table_name, c.column_name
  loop
    perform set_config('request.jwt.claims',
                       json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      execute format('select count(*) from public.%I where %I is not null',
                     rec.table_name, rec.column_name) into n;
      -- Reset BEFORE writing: the temp table is not writable while impersonating.
      perform set_config('role', 'postgres', true);
      insert into sweep values (
        rec.table_name, rec.column_name,
        case when n > 0 then 'READABLE WITH DATA' else 'readable, 0 rows' end, n);
    exception when others then
      perform set_config('role', 'postgres', true);
      insert into sweep values (rec.table_name, rec.column_name, 'blocked', 0);
    end;
  end loop;
end;
$$;

select verdict, count(*) as columns
from sweep group by verdict order by verdict;

select tbl, col, rows_seen
from sweep where verdict = 'READABLE WITH DATA'
order by tbl, col;

-- WHAT THIS SWEEP DID NOT LOOK AT.
--
-- The regex above decides coverage, and a regex is exactly the kind of thing
-- that silently under-samples: the first version skipped four real money
-- columns and still printed "0 leaks". So the test now shows its own blind
-- spot. Every numeric column NOT matched is listed here — scan it, and if
-- anything in it carries currency, widen the regex rather than assume.
select c.table_name, c.column_name, c.data_type
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema
 and t.table_name  = c.table_name
 and t.table_type  = 'BASE TABLE'
where c.table_schema = 'public'
  and c.data_type in ('numeric','money','double precision','real')
  -- Parenthesised for the same precedence reason as the sweep above: without it
  -- this reads as ((column_name !~* 'A') || 'B') and the clause is text, not
  -- boolean.
  and c.column_name !~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                      || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                      || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
  and c.column_name !~* '(_id$|^id$)'
order by c.table_name, c.column_name;

-- THE OTHER DIRECTION: a column that is accidentally INVISIBLE.
--
-- 0045 secured rate_override by revoking table-level SELECT on time_entries and
-- re-granting a column list generated at migration time. That has a failure mode
-- pointing the opposite way to a leak: a column added by a LATER migration
-- receives no grant, and `authenticated` simply cannot see it. Nothing errors —
-- the value just never arrives, which in this codebase is the signature of every
-- bug worth having: silently empty.
--
-- So the same sweep also asserts the inverse. Every column on time_entries
-- except rate_override must be readable by `authenticated`.
do $$
declare
  ungranted text;
begin
  select string_agg(column_name, ', ' order by ordinal_position) into ungranted
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'time_entries'
    and column_name <> 'rate_override'
    and not has_column_privilege('authenticated', 'public.time_entries', column_name, 'SELECT');

  if ungranted is not null then
    raise exception
      'COLUMN GRANT DRIFT: time_entries column(s) [%] are invisible to authenticated. '
      'A migration added them after 0045 generated its grant list. Re-grant them, '
      'or the app reads them as silently absent.', ungranted;
  end if;
end;
$$;

do $$
declare leaks int;
begin
  select count(*) into leaks from sweep where verdict = 'READABLE WITH DATA';
  if leaks > 0 then
    raise exception 'MONEY BOUNDARY BREACHED: % money column(s) are readable by a technician WITH DATA IN THEM', leaks;
  end if;
  raise notice 'money boundary intact: no money column returns a value to a technician';
end;
$$;

rollback;
