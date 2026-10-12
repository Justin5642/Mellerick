-- =============================================
-- SYNC WINDOWS: STOP REPLICATING ALL OF HISTORY TO EVERY DEVICE
-- STATUS: DRAFT — NOT APPLIED. Apply BEFORE deploying the matching
-- mobile/powersync/sync-streams.yaml (ORDER below).
--
-- WHY
-- PowerSync stream filters cannot call now() and cannot compare a row to a
-- moving date (the service pre-computes bucket membership when a row changes,
-- not when the clock moves — confirmed by compiling the stream file with
-- @powersync/service-sync-rules: `now()` is "Unknown function"). So "the last
-- 90 days" cannot be written in sync-streams.yaml directly. The documented
-- pattern is a boolean column the database keeps current, which the stream
-- then filters on as a plain static condition. That is what this migration
-- adds.
--
-- WHAT EACH FLAG MEANS (all are window MEMBERSHIP, none is money)
--   jobs.sync_tech      open (not completed/cancelled) OR any job timestamp
--                       (created/updated/scheduled start+end/actual end)
--                       within 90 days. Technician streams follow it: a job
--                       and its notes/photos/time/variations/assignments
--                       leave a technician's phone 90 days after they go quiet.
--                       OPEN JOBS ARE ALWAYS IN, however old.
--   jobs.sync_office    open OR ready_to_invoice OR has an approved, unbilled
--                       variation OR any job timestamp within 24 months.
--   <job child>.sync_office   (job_items, job_variations, job_expenses,
--                       job_notes, job_stage_notes, job_photos, time_entries,
--                       equipment_usage_log) its job's sync_office OR its own
--                       date within 24 months. time_entries also: still open.
--   invoices.sync_office      not paid/cancelled OR created/updated/paid within
--                       24 months; invoice_items follow their invoice.
--   quotes.sync_office        draft/sent, accepted-not-converted, OR
--                       created/updated within 24 months; quote_items follow.
--   backflow_tests.sync_recent  tested/created within 24 months OR it is the
--                       device's LATEST PASS (due-date logic needs exactly that
--                       row, however old it is).
--   customers.sync_backflow / sites.sync_backflow  has an active backflow
--                       device. Technicians receive these so the all-devices
--                       backflow register can name every device's customer and
--                       suburb without syncing every customer in the business.
--
-- INVARIANTS THE MOBILE READS RELY ON (mobile/lib/data/reads/horizon.ts)
--   O1  a job with sync_office = true has ALL its children flagged true.
--   O2  every row whose own window timestamp is >= sync_horizon.office_cutoff
--       is flagged true (so "created_at >= cutoff" rows are all on the device).
--   T1  a job with sync_tech = false is closed and quiet for 90+ days.
--   B1  every device's latest passing test is flagged true.
-- How they hold:
--   * every flag defaults TRUE (sync_backflow: computed), so a new row is in;
--   * only sync_window_refresh() ever sets a flag FALSE, set-based, in one
--     transaction that also writes the sync_horizon row naming the cutoffs it
--     used — the device sees both together or neither;
--   * any real write to a row (anything but a flag) marks it recent; a write to
--     a job CHILD also marks its job in-window again, and a job (or invoice /
--     quote) coming back in-window cascades true to its children;
--   * client roles (authenticated / anon) cannot set a flag: their writes are
--     always treated as activity. A technician therefore cannot hide a row from
--     office devices by writing `sync_office = false`.
--
-- FAILURE DIRECTION IS OVER-SYNC, NEVER UNDER-SYNC
--   * If pg_cron is unavailable, nothing ages out — devices sync what they do
--     today. A WARNING is raised; sync_horizon.refreshed_at shows staleness.
--   * The stream filters are written `<flag> IS NOT false`, so a stream file
--     deployed against a database WITHOUT these columns still syncs every row
--     (a missing column reads NULL). Verified by evaluating rows with the
--     PowerSync compiler.
--
-- ORDER (owner action)
--   1. Apply this migration (`supabase db push`), then confirm:
--        select * from sync_horizon;            -- one row, cutoffs set
--        select jobname, schedule from cron.job where jobname = 'sync-window-refresh';
--   2. Deploy mobile/powersync/sync-streams.yaml to the PowerSync instance
--      (dashboard -> Validate -> Deploy). Devices re-sync and drop old rows.
--   The reverse order is also safe (see IS NOT false above) but syncs no less
--   data until step 1 lands.
--
-- MONEY: no money column is added, read or exposed. sync_horizon holds three
-- timestamps and is readable by any signed-in user.
-- =============================================

-- ---------------------------------------------------------------------------
-- 1. Flag columns. One ALTER per column (tests/helpers/migration-schema.ts
--    reads one `add column` per statement).
-- ---------------------------------------------------------------------------
alter table jobs add column if not exists sync_tech boolean not null default true;
alter table jobs add column if not exists sync_office boolean not null default true;
alter table job_items add column if not exists sync_office boolean not null default true;
alter table job_variations add column if not exists sync_office boolean not null default true;
alter table job_expenses add column if not exists sync_office boolean not null default true;
alter table job_notes add column if not exists sync_office boolean not null default true;
alter table job_stage_notes add column if not exists sync_office boolean not null default true;
alter table job_photos add column if not exists sync_office boolean not null default true;
alter table time_entries add column if not exists sync_office boolean not null default true;
alter table equipment_usage_log add column if not exists sync_office boolean not null default true;
alter table invoices add column if not exists sync_office boolean not null default true;
alter table invoice_items add column if not exists sync_office boolean not null default true;
alter table quotes add column if not exists sync_office boolean not null default true;
alter table quote_items add column if not exists sync_office boolean not null default true;
alter table backflow_tests add column if not exists sync_recent boolean not null default true;
alter table customers add column if not exists sync_backflow boolean not null default false;
alter table sites add column if not exists sync_backflow boolean not null default false;

-- time_entries uses column-level SELECT grants (0045/0046). A new column is
-- invisible to authenticated until the grants are regenerated.
select reapply_time_entries_grants();

comment on column jobs.sync_tech is
  'PowerSync window (0068): job is on assigned technicians'' devices. Maintained by triggers + sync_window_refresh(); never set by clients.';
comment on column jobs.sync_office is
  'PowerSync window (0068): job and its children are on office/admin devices. Maintained by triggers + sync_window_refresh().';

-- ---------------------------------------------------------------------------
-- 2. The horizon row: which cutoffs the flags were last computed against.
--    Synced to every device so a local read can tell "this request is inside
--    what my mirror holds" from "older history lives only on the server",
--    without trusting the phone's clock.
-- ---------------------------------------------------------------------------
create table if not exists sync_horizon (
  id text primary key default 'current' check (id = 'current'),
  tech_cutoff timestamptz not null,
  office_cutoff timestamptz not null,
  backflow_cutoff timestamptz not null,
  refreshed_at timestamptz not null default now()
);

alter table sync_horizon enable row level security;
drop policy if exists "sync horizon readable by signed-in users" on sync_horizon;
create policy "sync horizon readable by signed-in users" on sync_horizon
  for select to authenticated using (true);
revoke insert, update, delete on sync_horizon from anon, authenticated;
grant select on sync_horizon to authenticated;

comment on table sync_horizon is
  'Single row written by sync_window_refresh() (0068): rows newer than these cutoffs are guaranteed to be on devices. Read by mobile/lib/data/reads/horizon.ts.';

alter publication powersync add table sync_horizon;

-- ---------------------------------------------------------------------------
-- 3. Trigger functions.
-- ---------------------------------------------------------------------------

-- Parents (jobs, invoices, quotes): BEFORE INSERT OR UPDATE. TG_ARGV = flags.
-- SECURITY INVOKER on purpose: current_user is how a client write is told apart
-- from the definer-owned refresh/cascade writes below.
create or replace function sync_window_parent_before()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  flag text;
  flags_changed boolean := false;
  patch jsonb := '{}'::jsonb;
  o jsonb;
  n jsonb;
begin
  if tg_op = 'UPDATE' and current_user not in ('authenticated', 'anon') then
    o := to_jsonb(old);
    n := to_jsonb(new);
    foreach flag in array tg_argv loop
      if (n -> flag) is distinct from (o -> flag) then
        flags_changed := true;
      end if;
    end loop;
    if flags_changed and (n - tg_argv - 'updated_at') = (o - tg_argv - 'updated_at') then
      -- Flag-only write (window refresh or cascade). Not activity: keep the
      -- row's real updated_at, which update_updated_at() just overwrote.
      if o ? 'updated_at' then
        return jsonb_populate_record(new, jsonb_build_object('updated_at', o -> 'updated_at'));
      end if;
      return new;
    end if;
  end if;

  -- Insert, any client write, or a real change: recent by definition.
  foreach flag in array tg_argv loop
    patch := patch || jsonb_build_object(flag, true);
  end loop;
  return jsonb_populate_record(new, patch);
end;
$$;

-- Children: BEFORE INSERT OR UPDATE. Static column, no row comparison here:
-- job_items/invoice_items/quote_items carry GENERATED columns, which a BEFORE
-- trigger must not read. Real-change detection for trusted callers happens in
-- the AFTER trigger below, where generated values exist.
create or replace function sync_office_child_before()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or current_user in ('authenticated', 'anon') then
    new.sync_office := true;
  end if;
  return new;
end;
$$;

-- Children: AFTER INSERT OR UPDATE. TG_ARGV = (parent table, fk column).
-- A real write marks the row AND its parent in-window again; the parent's own
-- cascade then brings every sibling back (invariant O1).
create or replace function sync_office_child_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n jsonb := to_jsonb(new);
  parent_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (n - 'sync_office') = (to_jsonb(old) - 'sync_office') then
      return null; -- flag-only write: refresh or cascade
    end if;
    if not new.sync_office then
      execute format('update %I.%I set sync_office = true where id = $1', tg_table_schema, tg_table_name)
        using new.id;
    end if;
  end if;

  parent_id := nullif(n ->> tg_argv[1], '')::uuid;
  if parent_id is not null then
    execute format('update public.%I set sync_office = true where id = $1 and not sync_office', tg_argv[0])
      using parent_id;
  end if;
  return null;
end;
$$;

-- Parents: AFTER UPDATE OF sync_office. TG_ARGV = (fk column, child tables...).
-- false -> true only. true -> false is done set-based by the refresh.
create or replace function sync_office_parent_cascade()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i int;
begin
  if new.sync_office and not old.sync_office then
    for i in 1 .. tg_nargs - 1 loop
      execute format('update public.%I set sync_office = true where %I = $1 and not sync_office', tg_argv[i], tg_argv[0])
        using new.id;
    end loop;
  end if;
  return null;
end;
$$;

-- backflow_tests: BEFORE (static column, same reasoning as children).
create or replace function sync_recent_backflow_before()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or current_user in ('authenticated', 'anon') then
    new.sync_recent := true;
  end if;
  return new;
end;
$$;

-- backflow_tests: AFTER INSERT/UPDATE/DELETE. Keeps invariant B1 when the
-- latest pass changes hands (a pass deleted, a result corrected, a device id
-- changed): the new latest pass is flagged in, immediately.
create or replace function sync_recent_backflow_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d uuid;
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'sync_recent') = (to_jsonb(old) - 'sync_recent') then
      return null;
    end if;
    if not new.sync_recent then
      update backflow_tests set sync_recent = true where id = new.id;
    end if;
  end if;

  for d in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.device_id end,
      case when tg_op <> 'DELETE' then new.device_id end
    ]) as x where x is not null
  loop
    update backflow_tests t set sync_recent = true
     where t.device_id = d and t.result = 'pass' and not t.sync_recent
       and t.test_date = (select max(test_date) from backflow_tests
                           where device_id = d and result = 'pass');
  end loop;
  return null;
end;
$$;

-- customers / sites: BEFORE. Clients cannot set sync_backflow; a flag-only
-- write from the definer functions keeps the row's real updated_at.
create or replace function sync_backflow_before()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.sync_backflow := false;
    else
      new.sync_backflow := old.sync_backflow;
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.sync_backflow is distinct from old.sync_backflow
     and (to_jsonb(new) - 'sync_backflow' - 'updated_at') = (to_jsonb(old) - 'sync_backflow' - 'updated_at') then
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

-- backflow_devices: AFTER INSERT/UPDATE/DELETE. Recomputes sync_backflow for
-- the customer(s) and site(s) the row was or is attached to.
create or replace function sync_backflow_from_devices()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update customers c
     set sync_backflow = exists (select 1 from backflow_devices d where d.customer_id = c.id and d.is_active is true)
   where c.id in (
           case when tg_op <> 'INSERT' then old.customer_id end,
           case when tg_op <> 'DELETE' then new.customer_id end)
     and c.sync_backflow is distinct from exists (select 1 from backflow_devices d where d.customer_id = c.id and d.is_active is true);

  update sites s
     set sync_backflow = exists (select 1 from backflow_devices d where d.site_id = s.id and d.is_active is true)
   where s.id in (
           case when tg_op <> 'INSERT' then old.site_id end,
           case when tg_op <> 'DELETE' then new.site_id end)
     and s.sync_backflow is distinct from exists (select 1 from backflow_devices d where d.site_id = s.id and d.is_active is true);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Triggers. BEFORE triggers are named zz_* so they fire AFTER the existing
--    update_*_updated_at triggers (same-event triggers fire in name order) and
--    can restore updated_at on a flag-only write.
-- ---------------------------------------------------------------------------
drop trigger if exists zz_jobs_sync_window on jobs;
create trigger zz_jobs_sync_window before insert or update on jobs
  for each row execute function sync_window_parent_before('sync_tech', 'sync_office');
drop trigger if exists zz_invoices_sync_window on invoices;
create trigger zz_invoices_sync_window before insert or update on invoices
  for each row execute function sync_window_parent_before('sync_office');
drop trigger if exists zz_quotes_sync_window on quotes;
create trigger zz_quotes_sync_window before insert or update on quotes
  for each row execute function sync_window_parent_before('sync_office');

drop trigger if exists zz_jobs_sync_window_cascade on jobs;
create trigger zz_jobs_sync_window_cascade after update of sync_office on jobs
  for each row execute function sync_office_parent_cascade(
    'job_id', 'job_items', 'job_variations', 'job_expenses', 'job_notes',
    'job_stage_notes', 'job_photos', 'time_entries', 'equipment_usage_log');
drop trigger if exists zz_invoices_sync_window_cascade on invoices;
create trigger zz_invoices_sync_window_cascade after update of sync_office on invoices
  for each row execute function sync_office_parent_cascade('invoice_id', 'invoice_items');
drop trigger if exists zz_quotes_sync_window_cascade on quotes;
create trigger zz_quotes_sync_window_cascade after update of sync_office on quotes
  for each row execute function sync_office_parent_cascade('quote_id', 'quote_items');

do $$
declare
  child record;
begin
  for child in
    select * from (values
      ('job_items', 'jobs', 'job_id'),
      ('job_variations', 'jobs', 'job_id'),
      ('job_expenses', 'jobs', 'job_id'),
      ('job_notes', 'jobs', 'job_id'),
      ('job_stage_notes', 'jobs', 'job_id'),
      ('job_photos', 'jobs', 'job_id'),
      ('time_entries', 'jobs', 'job_id'),
      ('equipment_usage_log', 'jobs', 'job_id'),
      ('invoice_items', 'invoices', 'invoice_id'),
      ('quote_items', 'quotes', 'quote_id')
    ) as t(tbl, parent, fk)
  loop
    execute format('drop trigger if exists zz_%s_sync_window on public.%I', child.tbl, child.tbl);
    execute format('create trigger zz_%s_sync_window before insert or update on public.%I
                      for each row execute function sync_office_child_before()', child.tbl, child.tbl);
    execute format('drop trigger if exists zz_%s_sync_window_touch on public.%I', child.tbl, child.tbl);
    execute format('create trigger zz_%s_sync_window_touch after insert or update on public.%I
                      for each row execute function sync_office_child_after(%L, %L)',
                   child.tbl, child.tbl, child.parent, child.fk);
  end loop;
end;
$$;

drop trigger if exists zz_backflow_tests_sync_window on backflow_tests;
create trigger zz_backflow_tests_sync_window before insert or update on backflow_tests
  for each row execute function sync_recent_backflow_before();
drop trigger if exists zz_backflow_tests_sync_window_latest on backflow_tests;
create trigger zz_backflow_tests_sync_window_latest after insert or update or delete on backflow_tests
  for each row execute function sync_recent_backflow_after();

drop trigger if exists zz_customers_sync_backflow on customers;
create trigger zz_customers_sync_backflow before insert or update on customers
  for each row execute function sync_backflow_before();
drop trigger if exists zz_sites_sync_backflow on sites;
create trigger zz_sites_sync_backflow before insert or update on sites
  for each row execute function sync_backflow_before();
drop trigger if exists zz_backflow_devices_sync_backflow on backflow_devices;
create trigger zz_backflow_devices_sync_backflow after insert or update or delete on backflow_devices
  for each row execute function sync_backflow_from_devices();

-- ---------------------------------------------------------------------------
-- 5. The refresh: the ONLY code path that sets a window flag false.
--    Idempotent; touches only rows whose flag actually changes, so a nightly
--    run replicates a handful of rows, not the database.
-- ---------------------------------------------------------------------------
create or replace function sync_window_refresh()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tech_cut timestamptz := now() - interval '90 days';
  office_cut timestamptz := now() - interval '24 months';
  backflow_cut timestamptz := now() - interval '24 months';
begin
  -- jobs first: every child below reads the job's new flag.
  update jobs j
     set sync_tech = w.t, sync_office = w.o
    from (
      select j2.id,
             (coalesce(j2.status, '') not in ('completed', 'cancelled')
               or greatest(j2.created_at, j2.updated_at, j2.scheduled_start, j2.scheduled_end, j2.actual_end) >= tech_cut) as t,
             (coalesce(j2.status, '') not in ('completed', 'cancelled')
               or coalesce(j2.ready_to_invoice, false)
               or greatest(j2.created_at, j2.updated_at, j2.scheduled_start, j2.scheduled_end, j2.actual_end) >= office_cut
               or exists (select 1 from job_variations v
                           where v.job_id = j2.id
                             and v.status in ('approved', 'auto_approved')
                             and v.invoice_id is null)) as o
        from jobs j2
    ) w
   where j.id = w.id
     and (j.sync_tech is distinct from w.t or j.sync_office is distinct from w.o);

  update job_items c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_items c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update job_variations c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_variations c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update job_expenses c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_expenses c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update job_notes c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_notes c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update job_stage_notes c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_stage_notes c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update job_photos c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_photos c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update time_entries c set sync_office = x.v
    from (select c2.id,
                 (coalesce(j.sync_office, false)
                   or c2.clock_out is null
                   or greatest(c2.clock_in, c2.clock_out, c2.created_at, c2.edited_at) >= office_cut) as v
            from time_entries c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update equipment_usage_log c set sync_office = x.v
    from (select c2.id,
                 (coalesce(j.sync_office, false)
                   or greatest(c2.usage_date::timestamptz, c2.created_at) >= office_cut) as v
            from equipment_usage_log c2 left join jobs j on j.id = c2.job_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update invoices i set sync_office = x.v
    from (select i2.id,
                 (coalesce(i2.status, '') not in ('paid', 'cancelled')
                   or greatest(i2.created_at, i2.updated_at, i2.paid_at) >= office_cut) as v
            from invoices i2) x
   where i.id = x.id and i.sync_office is distinct from x.v;

  update invoice_items c set sync_office = x.v
    from (select c2.id, (coalesce(p.sync_office, false) or c2.created_at >= office_cut) as v
            from invoice_items c2 left join invoices p on p.id = c2.invoice_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update quotes q set sync_office = x.v
    from (select q2.id,
                 (coalesce(q2.status, '') in ('draft', 'sent')
                   or (q2.status = 'accepted' and q2.job_id is null)
                   or greatest(q2.created_at, q2.updated_at) >= office_cut) as v
            from quotes q2) x
   where q.id = x.id and q.sync_office is distinct from x.v;

  update quote_items c set sync_office = x.v
    from (select c2.id, (coalesce(p.sync_office, false) or c2.created_at >= office_cut) as v
            from quote_items c2 left join quotes p on p.id = c2.quote_id) x
   where c.id = x.id and c.sync_office is distinct from x.v;

  update backflow_tests t set sync_recent = x.v
    from (select t2.id,
                 (t2.test_date >= backflow_cut::date
                   or t2.created_at >= backflow_cut
                   or (t2.result = 'pass' and t2.test_date = lp.latest)) as v
            from backflow_tests t2
            left join (select device_id, max(test_date) as latest
                         from backflow_tests where result = 'pass'
                        group by device_id) lp on lp.device_id = t2.device_id) x
   where t.id = x.id and t.sync_recent is distinct from coalesce(x.v, true);

  update customers c
     set sync_backflow = x.v
    from (select c2.id, exists (select 1 from backflow_devices d
                                 where d.customer_id = c2.id and d.is_active is true) as v
            from customers c2) x
   where c.id = x.id and c.sync_backflow is distinct from x.v;

  update sites s
     set sync_backflow = x.v
    from (select s2.id, exists (select 1 from backflow_devices d
                                 where d.site_id = s2.id and d.is_active is true) as v
            from sites s2) x
   where s.id = x.id and s.sync_backflow is distinct from x.v;

  -- Same transaction as the flags above: a device never sees a cutoff the
  -- flags do not honour.
  insert into sync_horizon (id, tech_cutoff, office_cutoff, backflow_cutoff, refreshed_at)
  values ('current', tech_cut, office_cut, backflow_cut, now())
  on conflict (id) do update
    set tech_cutoff = excluded.tech_cutoff,
        office_cutoff = excluded.office_cutoff,
        backflow_cutoff = excluded.backflow_cutoff,
        refreshed_at = excluded.refreshed_at;
end;
$$;

revoke execute on function sync_window_refresh() from public, anon, authenticated;
revoke execute on function sync_office_child_after() from public, anon, authenticated;
revoke execute on function sync_office_parent_cascade() from public, anon, authenticated;
revoke execute on function sync_recent_backflow_after() from public, anon, authenticated;
revoke execute on function sync_backflow_from_devices() from public, anon, authenticated;

comment on function sync_window_refresh() is
  'Recomputes every PowerSync window flag (0068) and writes sync_horizon. The only path that sets a flag false. Scheduled nightly by pg_cron (job sync-window-refresh).';

-- Backfill now: computes every flag and writes the horizon row.
select sync_window_refresh();

-- ---------------------------------------------------------------------------
-- 6. Nightly schedule. 16:17 UTC = 02:17/03:17 Melbourne.
--    pg_cron missing means nothing ages out (over-sync), not data loss, so it
--    WARNS rather than failing a migration that is otherwise complete.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('sync-window-refresh', '17 16 * * *', 'select public.sync_window_refresh()');
  else
    raise warning 'pg_cron is not available: sync windows will not age out until public.sync_window_refresh() is scheduled. Devices keep syncing everything meanwhile.';
  end if;
exception when others then
  raise warning 'could not schedule sync_window_refresh via pg_cron (%). Schedule it by hand; until then nothing ages out.', sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Post-conditions. A window migration that silently achieved nothing would
--    be harmless; one that left a flag FALSE on current work would not be.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from sync_horizon where id = 'current';
  if n <> 1 then
    raise exception 'ASSERTION FAILED: sync_horizon has % rows, expected 1', n;
  end if;

  select count(*) into n from jobs
   where coalesce(status, '') not in ('completed', 'cancelled')
     and (not sync_tech or not sync_office);
  if n > 0 then
    raise exception 'ASSERTION FAILED: % open job(s) flagged out of a sync window', n;
  end if;

  select count(*) into n from jobs j
   where j.sync_office
     and (exists (select 1 from job_notes c where c.job_id = j.id and not c.sync_office)
       or exists (select 1 from time_entries c where c.job_id = j.id and not c.sync_office)
       or exists (select 1 from job_variations c where c.job_id = j.id and not c.sync_office));
  if n > 0 then
    raise exception 'ASSERTION FAILED: % in-window job(s) with out-of-window children (invariant O1)', n;
  end if;

  select count(*) into n from backflow_tests t
   where t.result = 'pass' and not t.sync_recent
     and t.test_date = (select max(test_date) from backflow_tests x
                         where x.device_id = t.device_id and x.result = 'pass');
  if n > 0 then
    raise exception 'ASSERTION FAILED: % latest-pass backflow test(s) flagged out (invariant B1)', n;
  end if;

  if has_column_privilege('authenticated', 'public.time_entries', 'rate_override', 'SELECT') then
    raise exception 'ASSERTION FAILED: rate_override became readable by authenticated';
  end if;
  if not has_column_privilege('authenticated', 'public.time_entries', 'sync_office', 'SELECT') then
    raise exception 'ASSERTION FAILED: time_entries.sync_office unreadable by authenticated';
  end if;
end;
$$;
