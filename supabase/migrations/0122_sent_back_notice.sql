-- ============================================================================
-- A job sent back by the office tells its crew: a push, and a note on the job.
--
-- STATUS: DRAFT — NOT APPLIED. Paste this, then
-- supabase/tests/0122_sent_back_notice_test.sql, and trust only "0122 PASSED".
--
-- WHY (27 Nov 2026)
-- On Approvals (web components/approvals/approvals-client.tsx reject(), phone
-- mobile/lib/data/repositories/approvals.ts sendBackJob) an admin "sends back"
-- a job: admin_status = 'rejected', admin_notes = <what's missing>, status =
-- 'in_progress', ready_to_invoice = false. The toast said "technician will be
-- notified" — nothing did. No push, the note was shown nowhere, and the job
-- quietly reappeared in the technician's My Jobs.
--
-- WHY A NEW COLUMN FOR THE NOTE, NOT jobs.admin_notes ON THE PHONE
-- jobs.admin_notes is two things: the send-back note AND the approval note —
-- lib/approve-job.ts writes the admin's approval comment into it, and that is
-- where invoicing talk ("invoice the $4,200 PO, not the quote") goes. Every
-- technician's job stays on their phone up to 90 days after it closes (0068),
-- so syncing admin_notes would put approval comments in plaintext SQLite on
-- technicians' phones. tests/unit/sync-streams-contract.test.ts lists
-- "admin_notes" as a money term for exactly that reason, and it stays there.
-- So the send-back note gets its own column, written only by the trigger below
-- and only from a send-back:
--   jobs.sent_back_note  text         the note the office wrote TO the crew
--   jobs.sent_back_at    timestamptz  when it was sent back
-- Nobody writes them directly (a direct write is put back to the old value).
-- They keep the LAST send-back after the job is signed off again — history;
-- the banner and tag key off admin_status = 'rejected', which 0098 already
-- resets to 'pending' when the crew complete the job again.
--
-- WHO GETS THE PUSH
-- The job's crew — jobs.assigned_to and every job_assignments row — once each,
-- never the person who sent it back. Sent when admin_status becomes 'rejected',
-- or the note changes while it is 'rejected', on an open job, by a signed-in
-- user (auth.role() = 'authenticated' — both Approvals screens write as the
-- admin). Service-role writes (scripts, the SQL editor) send nothing, as 0077.
-- Title "Job #123 sent back", body = the note (≤150 characters), data
-- { type: 'job_sent_back', jobId } — the shape the phone's tap handler opens
-- (mobile/lib/push/notificationTaps.ts, 0077's 'job_assigned' shape).
--
-- HOW — exactly 0077's mechanism: pg_net queues a POST to send-push with the
-- internal secret from Vault (push_function_url, push_internal_secret); it is
-- sent after commit, a rolled-back write sends nothing, no secrets = nothing,
-- and any failure is a WARNING — a push never stops a send-back saving.
--
-- No money: the note is free text the admin addresses to the crew (the web and
-- phone Approvals boxes say so). Idempotent; no temp tables; nothing dropped
-- by guessed name (only this migration's own triggers, by their own names).
-- ============================================================================

create extension if not exists pg_net;

-- 1. Columns ------------------------------------------------------------------

alter table jobs add column if not exists sent_back_note text;
alter table jobs add column if not exists sent_back_at timestamptz;

comment on column jobs.sent_back_note is
  'The note the office wrote to the crew when it last sent this job back (0122). Set only by jobs_sent_back_stamp from admin_notes; never an approval note. Synced to technicians (tech_jobs).';
comment on column jobs.sent_back_at is
  'When the office last sent this job back (0122). Set only by jobs_sent_back_stamp.';

-- jobs has no column-level grants today (table-level select covers new
-- columns); granted explicitly anyway so a future column lockdown keeps them.
grant select (sent_back_note, sent_back_at) on jobs to authenticated, service_role;

-- 2. Jobs already sent back get their note -------------------------------------
--
-- Before the stamp trigger exists (once it does, a direct write is put back).
-- Only rows still unstamped, so a re-run touches nothing. updated_at moves to
-- now on these few rows (update_jobs_updated_at); their sent_back_at takes the
-- old updated_at, the best record of when they were sent back.

update jobs
   set sent_back_note = nullif(btrim(admin_notes), ''),
       sent_back_at = coalesce(updated_at, now())
 where admin_status = 'rejected'
   and sent_back_at is null
   and not exists (select 1 from pg_trigger t
                    where t.tgrelid = 'public.jobs'::regclass and t.tgname = 'jobs_sent_back_stamp');

-- 3. Stamp: the only writer of sent_back_note / sent_back_at -------------------
--
-- BEFORE triggers run in name order: jobs_office_columns (0074, refuses a
-- technician changing admin_status/admin_notes) and jobs_requeue_on_complete
-- (0098) both sort before jobs_sent_back_stamp, so this sees the final
-- admin_status.

create or replace function stamp_job_sent_back()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.admin_status = 'rejected' then
      new.sent_back_note := nullif(btrim(new.admin_notes), '');
      new.sent_back_at := now();
    else
      new.sent_back_note := null;
      new.sent_back_at := null;
    end if;
    return new;
  end if;

  if new.admin_status = 'rejected'
     and (old.admin_status is distinct from 'rejected'
          or new.admin_notes is distinct from old.admin_notes) then
    new.sent_back_note := nullif(btrim(new.admin_notes), '');
    new.sent_back_at := now();
  else
    new.sent_back_note := old.sent_back_note;
    new.sent_back_at := old.sent_back_at;
  end if;
  return new;
end;
$$;

revoke execute on function stamp_job_sent_back() from public, anon, authenticated;

drop trigger if exists jobs_sent_back_stamp on jobs;
create trigger jobs_sent_back_stamp
  before insert or update on jobs
  for each row execute function stamp_job_sent_back();

-- 4. Push the crew --------------------------------------------------------------

create or replace function notify_job_sent_back()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text;
  v_secret text;
  v_body text;
  v_staff uuid;
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;
  if new.admin_status is distinct from 'rejected'
     or new.status in ('completed', 'cancelled') then
    return new;
  end if;
  if old.admin_status = 'rejected'
     and new.sent_back_note is not distinct from old.sent_back_note then
    return new;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_internal_secret';
  if v_url is null or v_secret is null then
    return new;
  end if;

  v_body := regexp_replace(coalesce(new.sent_back_note, ''), '\s+', ' ', 'g');
  if length(v_body) > 150 then
    v_body := rtrim(left(v_body, 149)) || '…';
  end if;
  if v_body = '' then
    v_body := concat('#', new.job_number, ' ', new.title, ' needs more before it can be approved.');
  end if;

  for v_staff in
    select staff_id from job_assignments where job_id = new.id and staff_id is not null
    union
    select new.assigned_to where new.assigned_to is not null
  loop
    continue when v_staff = auth.uid();
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object(
        'userId', v_staff,
        'notification', jsonb_build_object(
          'title', concat('Job #', new.job_number, ' sent back'),
          'body', v_body,
          'data', jsonb_build_object('type', 'job_sent_back', 'jobId', new.id)
        )
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-internal-secret', v_secret),
      timeout_milliseconds := 5000
    );
  end loop;
  return new;
exception when others then
  raise warning 'job sent-back push not queued (job %): %', new.id, sqlerrm;
  return new;
end;
$$;

revoke execute on function notify_job_sent_back() from public, anon, authenticated;

drop trigger if exists jobs_sent_back_notify on jobs;
create trigger jobs_sent_back_notify
  after update of admin_status, admin_notes on jobs
  for each row execute function notify_job_sent_back();

-- 5. End state ----------------------------------------------------------------

do $$
declare
  n int;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'ASSERTION FAILED: pg_net is not installed';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs'
     and ((column_name = 'sent_back_note' and data_type = 'text')
       or (column_name = 'sent_back_at' and data_type = 'timestamp with time zone'));
  if n <> 2 then
    raise exception 'ASSERTION FAILED: jobs.sent_back_note / sent_back_at missing or wrong type';
  end if;

  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'jobs' and t.tgname = 'jobs_sent_back_stamp'
                    and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception 'ASSERTION FAILED: jobs_sent_back_stamp missing or disabled';
  end if;
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'jobs' and t.tgname = 'jobs_sent_back_notify'
                    and not t.tgisinternal and t.tgenabled = 'O') then
    raise exception 'ASSERTION FAILED: jobs_sent_back_notify missing or disabled';
  end if;

  if not (select prosecdef from pg_proc where oid = 'public.stamp_job_sent_back()'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.notify_job_sent_back()'::regprocedure) then
    raise exception 'ASSERTION FAILED: sent-back trigger functions must be SECURITY DEFINER';
  end if;
  if has_function_privilege('authenticated', 'public.notify_job_sent_back()', 'execute')
     or has_function_privilege('anon', 'public.notify_job_sent_back()', 'execute')
     or has_function_privilege('authenticated', 'public.stamp_job_sent_back()', 'execute') then
    raise exception 'ASSERTION FAILED: clients may execute a sent-back trigger function';
  end if;

  if not has_column_privilege('authenticated', 'public.jobs', 'sent_back_note', 'select')
     or not has_column_privilege('authenticated', 'public.jobs', 'sent_back_at', 'select')
     or not has_column_privilege('authenticated', 'public.jobs', 'admin_status', 'select') then
    raise exception 'ASSERTION FAILED: authenticated cannot select the sent-back columns';
  end if;

  -- The new columns are not money-named (the money sweep's own pattern).
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'jobs'
                and column_name in ('sent_back_note', 'sent_back_at')
                and column_name ~* '(rate|amount|price|cost|total|fee|margin|markup|charge)') then
    raise exception 'ASSERTION FAILED: a sent-back column is money-named';
  end if;

  -- The 0074 guard that keeps admin_status/admin_notes office-only still runs first.
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                  where c.relname = 'jobs' and t.tgname = 'jobs_office_columns' and not t.tgisinternal) then
    raise exception 'ASSERTION FAILED: jobs_office_columns (0074) is missing';
  end if;
end;
$$;

notify pgrst, 'reload schema';
