-- ============================================================================
-- REGRESSION TEST for 0077 — a job assignment queues exactly one push, and only
-- when a real person assigns someone new.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0077_job_assignment_push_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Every queued request
-- is rolled back with the rest, so this never sends a real notification.
--
-- "Queued" is read from net.http_request_queue, where pg_net holds a request
-- until the transaction commits. If the vault secrets are missing, test ones
-- are created inside the undone block.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  off  uuid;
  cust uuid := gen_random_uuid();
  j_none uuid := gen_random_uuid();
  j_user uuid := gen_random_uuid();
  j_script uuid := gen_random_uuid();
  j_route uuid := gen_random_uuid();
  j_done uuid := gen_random_uuid();
  j_self uuid := gen_random_uuid();
  before_n int;
  after_n int;
  payload jsonb;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into off  from profiles where role in ('office', 'admin') and coalesce(is_active, true)
      order by (role = 'office') desc limit 1;
    if tech is null or off is null then
      raise exception 'fixture missing: need an active technician and an office user or admin';
    end if;

    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0077 Customer');
    insert into jobs (id, customer_id, title) values
      (j_none, cust, '0077 no secrets'), (j_user, cust, '0077 office assigns'),
      (j_script, cust, '0077 import script'), (j_route, cust, '0077 mobile route'),
      (j_self, cust, '0077 self');
    insert into jobs (id, customer_id, title, status) values (j_done, cust, '0077 completed', 'completed');

    -- 1. No vault secrets: nothing is queued, and the assignment still saves.
    --    (Only meaningful where the secrets do not exist yet.)
    if not exists (select 1 from vault.decrypted_secrets where name in ('push_function_url', 'push_internal_secret')) then
      perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
      select count(*) into before_n from net.http_request_queue;
      insert into job_assignments (job_id, staff_id, assigned_by) values (j_none, tech, off);
      select count(*) into after_n from net.http_request_queue;
      res := res || format('without secrets nothing is queued|0|%s', after_n - before_n);
      res := res || format('without secrets the assignment still saves|1|%s',
        (select count(*) from job_assignments where job_id = j_none));
      perform vault.create_secret('http://push.invalid/functions/v1/send-push', 'push_function_url');
      perform vault.create_secret('test-secret', 'push_internal_secret');
    end if;

    -- 2. An office user assigns a technician: one request, to that technician.
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    select count(*) into before_n from net.http_request_queue;
    insert into job_assignments (job_id, staff_id, assigned_by) values (j_user, tech, off);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('office assigns a technician: one push queued|1|%s', after_n - before_n);
    select convert_from(body, 'utf8')::jsonb into payload
      from net.http_request_queue order by id desc limit 1;
    res := res || format('push is addressed to the technician|%s|%s', tech, payload ->> 'userId');
    res := res || format('push carries the job id|%s|%s', j_user, payload -> 'notification' -> 'data' ->> 'jobId');
    res := res || format('push body names the job|true|%s',
      position('0077 office assigns' in payload -> 'notification' ->> 'body') > 0);

    -- 3. Saving the same crew again (set_job_assignments) adds nobody: no push.
    select count(*) into before_n from net.http_request_queue;
    insert into job_assignments (job_id, staff_id, assigned_by) values (j_user, tech, off)
      on conflict (job_id, staff_id) do nothing;
    select count(*) into after_n from net.http_request_queue;
    res := res || format('re-saving the same crew sends nothing|0|%s', after_n - before_n);

    -- 4. An import script (service role, unmarked): nothing.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    perform set_config('request.headers', '{}', true);
    select count(*) into before_n from net.http_request_queue;
    insert into job_assignments (job_id, staff_id) values (j_script, tech);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('import script (service role) sends nothing|0|%s', after_n - before_n);

    -- 5. The mobile assignment route (service role, marked): one push.
    perform set_config('request.headers', json_build_object('x-mellerick-assignment', '1')::text, true);
    select count(*) into before_n from net.http_request_queue;
    insert into job_assignments (job_id, staff_id) values (j_route, tech);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('mobile assignment route sends one push|1|%s', after_n - before_n);
    perform set_config('request.headers', '{}', true);

    -- 6. A completed job: nothing.
    perform set_config('request.jwt.claims', json_build_object('sub', off::text, 'role', 'authenticated')::text, true);
    select count(*) into before_n from net.http_request_queue;
    insert into job_assignments (job_id, staff_id, assigned_by) values (j_done, tech, off);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('completed job sends nothing|0|%s', after_n - before_n);

    -- 7. Assigning yourself: nothing.
    select count(*) into before_n from net.http_request_queue;
    insert into job_assignments (job_id, staff_id, assigned_by) values (j_self, off, off);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('assigning yourself sends nothing|0|%s', after_n - before_n);

    -- 8. Clients cannot call the trigger function directly.
    res := res || format('authenticated cannot execute notify_job_assignment|false|%s',
      has_function_privilege('authenticated', 'public.notify_job_assignment()', 'execute'));

    -- Undo every change above, including the queued requests.
    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    -- format('%s', <boolean>) writes t / f; compare as true / false.
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — job assignment push not behaving:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
