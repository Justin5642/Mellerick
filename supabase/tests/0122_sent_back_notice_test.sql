-- ============================================================================
-- GATE TEST for 0122 — a job sent back by the office pushes its crew once,
-- never the sender, and the crew can read the note.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0122_sent_back_notice_test.sql
--   or paste the whole file into the Supabase SQL editor AFTER 0122.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header. Writes run under
-- the `authenticated` role as a real office/admin user and a real technician,
-- as the apps do. Every queued push is rolled back with the rest, so this
-- never sends a real notification ("queued" = net.http_request_queue, where
-- pg_net holds a request until commit). Missing vault secrets are created
-- inside the undone block. Trust only the final "0122 PASSED" row.
--
-- Needs an active technician and an active office/admin profile.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  tech uuid;
  office uuid;
  cust uuid := gen_random_uuid();
  j_crew uuid := gen_random_uuid();   -- lead = tech, office also on the crew
  j_none uuid := gen_random_uuid();   -- no secrets
  j_script uuid := gen_random_uuid(); -- sent back by a script
  j_done uuid := gen_random_uuid();   -- sent back but left completed
  before_n int;
  after_n int;
  payload jsonb;
  long_note text := repeat('Photos of the pit before backfill please. ', 10);
  v text;
  outcome text;
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    select id into tech from profiles
     where role = 'technician' and coalesce(is_active, true) limit 1;
    select id into office from profiles
     where role in ('office', 'admin') and coalesce(is_active, true)
     order by (role = 'admin') desc limit 1;
    if tech is null or office is null then
      raise exception 'fixture missing: need an active technician and an active office/admin user';
    end if;

    -- Fixtures as the session owner (no push from 0077: not a signed-in user).
    perform set_config('request.jwt.claims', '', true);
    insert into customers (id, name) values (cust, '0122 Customer');
    insert into jobs (id, customer_id, title, status, assigned_to) values
      (j_crew, cust, '0122 crew job', 'completed', tech),
      (j_none, cust, '0122 no secrets', 'completed', tech),
      (j_script, cust, '0122 script', 'completed', tech),
      (j_done, cust, '0122 left completed', 'completed', tech);
    insert into job_assignments (job_id, staff_id) values (j_crew, tech), (j_crew, office)
      on conflict do nothing;
    insert into job_assignments (job_id, staff_id) values (j_none, tech), (j_script, tech), (j_done, tech)
      on conflict do nothing;

    res := res || format('clients cannot run notify_job_sent_back|false|%s',
      has_function_privilege('authenticated', 'public.notify_job_sent_back()', 'execute'));

    -- 1. No vault secrets: nothing queued, the send-back still saves.
    if not exists (select 1 from vault.decrypted_secrets where name in ('push_function_url', 'push_internal_secret')) then
      select count(*) into before_n from net.http_request_queue;
      perform set_config('role', 'authenticated', true);
      perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
      update jobs set admin_status = 'rejected', admin_notes = 'no secrets', status = 'in_progress' where id = j_none;
      perform set_config('role', 'postgres', true);
      select count(*) into after_n from net.http_request_queue;
      res := res || format('without secrets nothing is queued|0|%s', after_n - before_n);
      res := res || format('without secrets the send-back still saves|rejected|%s',
        (select admin_status from jobs where id = j_none));
      perform set_config('request.jwt.claims', '', true);
      perform vault.create_secret('http://push.invalid/functions/v1/send-push', 'push_function_url');
      perform vault.create_secret('test-secret', 'push_internal_secret');
    end if;

    -- 2. Office sends the job back: one push, to the technician only (the
    --    sender is on the crew too and gets nothing).
    perform set_config('role', 'postgres', true);
    select count(*) into before_n from net.http_request_queue;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
    update jobs set admin_status = 'rejected', admin_notes = '  Need the CCTV report  ',
                    status = 'in_progress', ready_to_invoice = false
     where id = j_crew;
    perform set_config('role', 'postgres', true);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('send-back queues one push (crew of 2, sender skipped)|1|%s', after_n - before_n);
    select convert_from(body, 'utf8')::jsonb into payload from net.http_request_queue order by id desc limit 1;
    res := res || format('push goes to the technician|%s|%s', tech, payload ->> 'userId');
    res := res || format('push title names the job|Job #%s sent back|%s',
      (select job_number from jobs where id = j_crew), payload -> 'notification' ->> 'title');
    res := res || format('push body is the note|Need the CCTV report|%s', payload -> 'notification' ->> 'body');
    res := res || format('push opens the job|%s|%s', j_crew, payload -> 'notification' -> 'data' ->> 'jobId');
    res := res || format('push type|job_sent_back|%s', payload -> 'notification' -> 'data' ->> 'type');
    res := res || format('note stamped (trimmed)|Need the CCTV report|%s', (select sent_back_note from jobs where id = j_crew));
    res := res || format('time stamped|true|%s', (select sent_back_at is not null from jobs where id = j_crew));

    -- 3. Another edit while sent back (title): nothing.
    select count(*) into before_n from net.http_request_queue;
    perform set_config('role', 'authenticated', true);
    update jobs set title = '0122 crew job (renamed)' where id = j_crew;
    perform set_config('role', 'postgres', true);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('other edits while sent back send nothing|0|%s', after_n - before_n);

    -- 4. The office changes the note: one more push, trimmed to 150 characters.
    select count(*) into before_n from net.http_request_queue;
    perform set_config('role', 'authenticated', true);
    update jobs set admin_notes = long_note where id = j_crew;
    perform set_config('role', 'postgres', true);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('a changed note sends one more push|1|%s', after_n - before_n);
    select convert_from(body, 'utf8')::jsonb into payload from net.http_request_queue order by id desc limit 1;
    res := res || format('long note trimmed to at most 150 characters|true|%s',
      length(payload -> 'notification' ->> 'body') <= 150 and payload -> 'notification' ->> 'body' like '%%…');

    -- 5. The technician: reads the note on their job, can't forge it, can't
    --    send a job back themselves.
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', tech::text, 'role', 'authenticated')::text, true);
    select admin_status || ':' || left(sent_back_note, 17) into v from jobs where id = j_crew;
    res := res || format('technician reads status and note on their job|rejected:Photos of the pit|%s', v);
    update jobs set sent_back_note = 'forged', sent_back_at = now() - interval '1 day' where id = j_crew;
    res := res || format('technician cannot write the note|false|%s',
      (select sent_back_note = 'forged' from jobs where id = j_crew));
    begin
      update jobs set admin_notes = 'tech wrote this' where id = j_crew;
      outcome := 'ALLOWED';
    exception when insufficient_privilege then outcome := 'BLOCKED';
    end;
    res := res || format('technician cannot change admin_notes (0074)|BLOCKED|%s', outcome);

    -- 6. The technician signs the job off again: back to Approvals (0098), no
    --    push; the last note stays as history.
    perform set_config('role', 'postgres', true);
    select count(*) into before_n from net.http_request_queue;
    perform set_config('role', 'authenticated', true);
    update jobs set status = 'completed', ready_to_invoice = true where id = j_crew;
    perform set_config('role', 'postgres', true);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('re-sign-off returns the job to Approvals|pending|%s',
      (select admin_status from jobs where id = j_crew));
    res := res || format('re-sign-off sends nothing|0|%s', after_n - before_n);
    res := res || format('the last note is kept|true|%s',
      (select sent_back_note like 'Photos of the pit%' from jobs where id = j_crew));

    -- 7. A script (service role) sending a job back: stamped, no push.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    select count(*) into before_n from net.http_request_queue;
    update jobs set admin_status = 'rejected', admin_notes = 'by script', status = 'in_progress' where id = j_script;
    select count(*) into after_n from net.http_request_queue;
    res := res || format('service-role send-back sends nothing|0|%s', after_n - before_n);
    res := res || format('service-role send-back still stamps the note|by script|%s',
      (select sent_back_note from jobs where id = j_script));

    -- 8. Rejected but left completed: no push (only open jobs are worked on).
    select count(*) into before_n from net.http_request_queue;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', office::text, 'role', 'authenticated')::text, true);
    update jobs set admin_status = 'rejected', admin_notes = 'still completed' where id = j_done;
    perform set_config('role', 'postgres', true);
    select count(*) into after_n from net.http_request_queue;
    res := res || format('a completed job sends nothing|0|%s', after_n - before_n);

    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claims', '', true);
    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    parts[3] := case parts[3] when 't' then 'true' when 'f' then 'false' else parts[3] end;
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'0122 gate FAILED — % of % scenario(s):%', n_fail, array_length(res, 1), failures;
  end if;
end;
$$;

select '0122 PASSED' as result;
