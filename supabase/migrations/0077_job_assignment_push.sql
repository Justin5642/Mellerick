-- ============================================================================
-- Push a notification to a technician when they are assigned a job.
--
-- STATUS: DRAFT — NOT APPLIED. Apply ONLY after the send-push edge function is
-- redeployed with --no-verify-jwt and PUSH_INTERNAL_SECRET is set, and the two
-- vault secrets below exist — see docs/push-notifications.md. Without the
-- secrets this trigger does nothing (it never blocks an assignment).
--
-- WHY
-- Everything else for push was in place — APNs/FCM credentials in EAS, the
-- device_tokens table (0036), phones registering tokens, and the send-push edge
-- function — but nothing ever called send-push, so no notification was ever
-- sent. job_assignments is the one table every assignment path writes:
--   * the web schedule board and Schedule dialog (set_job_assignments RPC),
--   * the mobile office screens (/api/jobs/[id]/set-assignments → RPC),
--   * creating a job with a technician, or a direct jobs.assigned_to write
--     (collapse_job_assignments_on_direct_write, 0059).
-- set_job_assignments only INSERTs people who are new to the crew (on conflict
-- do nothing), so re-saving a crew does not re-notify anyone.
--
-- WHO TRIGGERS A PUSH
-- A real person assigning someone: a signed-in user (auth.role() =
-- 'authenticated'), OR the mobile assignment route, which uses the service role
-- and marks its requests with the header `x-mellerick-assignment: 1`.
-- Everything else — Simpro import scripts, the SQL editor, migrations — sends
-- nothing, so re-running an import never notifies technicians about hundreds
-- of old jobs. Completed / cancelled jobs, and assigning yourself, send nothing.
--
-- HOW
-- pg_net queues an HTTP POST to send-push with the internal secret; it is sent
-- after the transaction commits, and a rolled-back assignment sends nothing.
-- The URL and secret live in Supabase Vault (never in this file):
--   push_function_url     https://<project>.supabase.co/functions/v1/send-push
--   push_internal_secret  same value as the function's PUSH_INTERNAL_SECRET
-- Any failure here is swallowed with a WARNING: a notification must never stop
-- an assignment from saving.
-- ============================================================================

create extension if not exists pg_net;

create or replace function notify_job_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_marked boolean;
  v_url text;
  v_secret text;
  v_job record;
  v_body text;
begin
  v_marked := coalesce(
    (nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-mellerick-assignment') = '1',
    false
  );
  if auth.role() is distinct from 'authenticated' and not v_marked then
    return new;
  end if;
  if new.staff_id = auth.uid() then
    return new;
  end if;

  select j.job_number, j.title, j.status, j.scheduled_start, c.name as customer, s.suburb
    into v_job
    from jobs j
    left join customers c on c.id = j.customer_id
    left join sites s on s.id = j.site_id
   where j.id = new.job_id;
  if not found or v_job.status in ('completed', 'cancelled') then
    return new;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret';
  if v_url is null or v_secret is null then
    return new;
  end if;

  -- "#2523 Blocked drain — Smith Plumbing, Epping · Tue 21 Oct 7:30am"
  v_body := concat_ws(' — ',
              concat('#', v_job.job_number, ' ', v_job.title),
              nullif(concat_ws(', ', v_job.customer, v_job.suburb), ''));
  if v_job.scheduled_start is not null then
    v_body := v_body || ' · ' ||
      lower(to_char(v_job.scheduled_start at time zone 'Australia/Melbourne', 'Dy FMDD Mon FMHH12:MIam'));
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object(
      'userId', new.staff_id,
      'notification', jsonb_build_object(
        'title', 'New job assigned',
        'body', v_body,
        'data', jsonb_build_object('type', 'job_assigned', 'jobId', new.job_id)
      )
    ),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  raise warning 'job assignment push not queued (job %, staff %): %', new.job_id, new.staff_id, sqlerrm;
  return new;
end;
$$;

revoke execute on function notify_job_assignment() from public, anon, authenticated;

drop trigger if exists job_assignments_notify on job_assignments;
create trigger job_assignments_notify
  after insert on job_assignments
  for each row execute function notify_job_assignment();

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'ASSERTION FAILED: pg_net is not installed';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'job_assignments_notify' and not tgisinternal) then
    raise exception 'ASSERTION FAILED: job_assignments_notify trigger missing';
  end if;
end;
$$;
