-- ============================================================================
-- REGRESSION TEST for 0099 — Xero bill allocations.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0099_xero_bill_allocations_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Asserts the end
-- state and raises on any failure: RLS on, exactly one office/admin policy,
-- anon has nothing, and the two CHECKs behave (a job allocation needs a job; an
-- overhead allocation must not have one).
-- ============================================================================

do $$
declare
  n int;
  failures text := '';
  j uuid;
  ok boolean;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.xero_bill_allocations'::regclass) then
    failures := failures || 'RLS is off; ';
  end if;
  select count(*) into n from pg_policy where polrelid = 'public.xero_bill_allocations'::regclass;
  if n <> 1 then failures := failures || format('expected 1 policy, found %s; ', n); end if;
  if has_table_privilege('anon', 'public.xero_bill_allocations', 'select') then failures := failures || 'anon can SELECT; '; end if;
  if not has_table_privilege('authenticated', 'public.xero_bill_allocations', 'insert') then
    failures := failures || 'signed-in users cannot INSERT (the 0088 trap); ';
  end if;

  begin
    insert into xero_invoices (xero_invoice_id, type, status) values ('0099-test-bill', 'ACCPAY', 'AUTHORISED');

    -- a job allocation with no job is refused
    ok := false;
    begin
      insert into xero_bill_allocations (xero_invoice_id, kind) values ('0099-test-bill', 'job');
    exception when check_violation then ok := true;
    end;
    if not ok then failures := failures || 'job allocation without a job was accepted; '; end if;

    -- an overhead allocation WITH a job is refused
    select id into j from jobs limit 1;
    if j is not null then
      ok := false;
      begin
        insert into xero_bill_allocations (xero_invoice_id, kind, job_id) values ('0099-test-bill', 'overhead', j);
      exception when check_violation then ok := true;
      end;
      if not ok then failures := failures || 'overhead allocation with a job was accepted; '; end if;
    end if;

    -- a plain overhead allocation is accepted
    insert into xero_bill_allocations (xero_invoice_id, kind) values ('0099-test-bill', 'overhead');

    raise exception 'ZX001 undo';
  exception when others then
    if sqlerrm <> 'ZX001 undo' then failures := failures || 'unexpected: ' || sqlerrm || '; '; end if;
  end;

  if failures <> '' then raise exception '0099 gate FAILED: %', failures; end if;
  raise notice '0099 gate passed';
end $$;
