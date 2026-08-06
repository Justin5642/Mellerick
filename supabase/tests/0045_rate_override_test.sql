-- ============================================================================
-- REGRESSION TEST for 0045 — time_entries.rate_override is office/admin only.
--
-- Run against the LIVE database; everything is inside a transaction that is
-- ROLLED BACK, so nothing is modified:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0045_rate_override_test.sql
--
-- WHAT IT PROTECTS. rate_override overrides the hourly charge-out rate, so it is
-- money. Its RLS policy is `auth.role() = 'authenticated'` — every signed-in
-- user — and before 0045 a technician impersonation returned 1 non-null row.
-- The sync path was already clean (tech_time_entries lists explicit columns and
-- rate_override is not among them), the UI never rendered it, and MoneyText
-- never received it. RLS was the one layer of four that leaked, which is exactly
-- the threat model 0038 wrote down: a technician holds the anon key and can
-- query PostgREST directly regardless of what the UI shows.
--
-- WHY THE "ALLOWED" CASES MATTER AS MUCH AS THE BLOCK. The fix revokes the
-- TABLE-level SELECT and re-grants every column except one. Get that wrong and
-- technicians lose their own time entries — so a test that only asserted the
-- block would pass just as happily on a change that broke clocking in entirely.
--
-- Each scenario resets `role` to postgres before recording, because the temp
-- table is not writable while impersonating.
-- ============================================================================

begin;

create temp table r(scenario text, expected text, actual text) on commit drop;
do $$
declare tech uuid; n int; leak text; ok1 text; ok2 text;
begin
  select id into tech from profiles where role='technician' limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub',tech::text,'role','authenticated')::text, true);

  perform set_config('role','authenticated',true);
  begin
    select count(*) into n from time_entries where rate_override is not null;
    leak := 'VISIBLE (' || n || ' rows)';
  exception when others then leak := 'BLOCKED';
  end;
  perform set_config('role','postgres',true);

  perform set_config('role','authenticated',true);
  begin
    select count(*) into n from time_entries;
    ok1 := 'ALLOWED';
  exception when others then ok1 := 'BLOCKED';
  end;
  perform set_config('role','postgres',true);

  perform set_config('role','authenticated',true);
  begin
    select count(*) into n from (select id, job_id, clock_in, clock_out, hours from time_entries limit 5) x;
    ok2 := 'ALLOWED';
  exception when others then ok2 := 'BLOCKED';
  end;
  perform set_config('role','postgres',true);

  insert into r values
    ('technician reads rate_override','BLOCKED',leak),
    ('technician reads time entries','ALLOWED',ok1),
    ('technician reads clock columns','ALLOWED',ok2);
end $$;
select coalesce(json_agg(row_to_json(t)),'[]'::json)::text from (
  select scenario, actual, case when expected=actual then 'PASS' else '*** FAIL ***' end as verdict
  from r) t;

do $$
declare failures int;
begin
  select count(*) into failures from r where expected <> actual;
  if failures > 0 then
    raise exception '% scenario(s) FAILED — rate_override is not properly gated', failures;
  end if;
  raise notice 'all scenarios passed';
end;
$$;

rollback;
