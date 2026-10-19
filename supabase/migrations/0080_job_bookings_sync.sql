-- ============================================================================
-- Job bookings on the phone: replicate job_bookings to devices (PowerSync).
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-19, via db query --linked). Gate test
-- passed; verified job_bookings is in the powersync publication with
-- sync_office set. Sync streams are deployed separately (docs/powersync-deploy.md).
--
-- WHY
-- 0079 made job_bookings the source of truth for who works a job, when, and
-- against which cost centre. The phone needs it offline: My Jobs lists a
-- technician's own bookings, the job screen shows the crew's bookings, and a
-- clock-in (manual or geofence) defaults to the cost centre of the booking
-- that covers it. None of that can wait for a network round trip on site.
--
-- WHAT THIS DOES — the same treatment 0068 gave every other job child
--   1. job_bookings joins the scoped `powersync` publication (0039). A table
--      missing there silently never replicates, whatever the streams say.
--   2. job_bookings.sync_office: the office window flag. True on insert and on
--      every real write; a real write also brings its job back in-window
--      (sync_office_child_before / sync_office_child_after, 0068); the job's
--      cascade brings it back with the job; only sync_window_refresh() sets
--      it false. Technicians need no flag: their stream follows the job's
--      sync_tech through the same subquery as every tech_job_* stream.
--   3. sync_window_refresh() is replaced by the 0068 body plus one block for
--      job_bookings (jobs first, then children — invariant O1).
--
-- WHY THE 0079 TRIGGERS ARE RE-HUNG (functions unchanged)
-- A flag-only write — the nightly refresh setting sync_office false, or a
-- job's cascade setting it true — must not look like activity. Under 0079 as
-- written it would:
--   * job_bookings_touch bumps updated_at on ANY update, so the AFTER trigger
--     (sync_office_child_after) would see a real change and flip the flag
--     straight back to true: bookings would never leave office devices;
--   * job_bookings_derive re-derives the job on any changed row, i.e. an
--     UPDATE of jobs, which bumps jobs.updated_at and marks the job recent:
--     every job with a booking would stay in both windows forever, and its
--     updated_at would lie about when anyone last touched it.
-- So both triggers now carry a WHEN clause that ignores a change to
-- sync_office alone. The UPDATE half of job_bookings_derive needs its own
-- trigger, because a WHEN clause cannot read OLD/NEW on a trigger that also
-- fires for INSERT or DELETE.
--
-- MONEY: none. job_bookings has no money column; the technician stream lists
-- its columns explicitly anyway (HANDOVER §2).
-- ============================================================================

do $$
begin
  if to_regclass('public.job_bookings') is null then
    raise exception '0080 needs 0079 (job_bookings) applied first';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Publication (idempotent: re-running this file must not fail on "already
--    member of publication").
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'powersync' and schemaname = 'public' and tablename = 'job_bookings') then
    alter publication powersync add table job_bookings;
  end if;
  -- The replication user reads every published table. Its grants on the
  -- tables added since 0039 came from default privileges; granting here makes
  -- this one explicit rather than assumed.
  if exists (select 1 from pg_roles where rolname = 'powersync_role') then
    grant select on job_bookings to powersync_role;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Office window flag + the 0068 child triggers.
-- ---------------------------------------------------------------------------
alter table job_bookings add column if not exists sync_office boolean not null default true;

comment on column job_bookings.sync_office is
  'PowerSync window (0068/0080): booking is on office/admin devices. Maintained by triggers + sync_window_refresh(); never set by clients.';

drop trigger if exists zz_job_bookings_sync_window on job_bookings;
create trigger zz_job_bookings_sync_window before insert or update on job_bookings
  for each row execute function sync_office_child_before();
drop trigger if exists zz_job_bookings_sync_window_touch on job_bookings;
create trigger zz_job_bookings_sync_window_touch after insert or update on job_bookings
  for each row execute function sync_office_child_after('jobs', 'job_id');

-- A job coming back in-window brings its bookings with it (invariant O1).
drop trigger if exists zz_jobs_sync_window_cascade on jobs;
create trigger zz_jobs_sync_window_cascade after update of sync_office on jobs
  for each row execute function sync_office_parent_cascade(
    'job_id', 'job_items', 'job_variations', 'job_expenses', 'job_notes',
    'job_stage_notes', 'job_photos', 'time_entries', 'equipment_usage_log',
    'job_bookings');

-- ---------------------------------------------------------------------------
-- 3. 0079's triggers ignore a flag-only write (see header).
-- ---------------------------------------------------------------------------
drop trigger if exists job_bookings_touch on job_bookings;
create trigger job_bookings_touch before update on job_bookings
  for each row
  when ((to_jsonb(new) - 'sync_office') is distinct from (to_jsonb(old) - 'sync_office'))
  execute function job_bookings_touch();

drop trigger if exists job_bookings_derive on job_bookings;
create trigger job_bookings_derive after insert or delete on job_bookings
  for each row execute function job_bookings_after_change();
drop trigger if exists job_bookings_derive_update on job_bookings;
create trigger job_bookings_derive_update after update on job_bookings
  for each row
  when ((to_jsonb(new) - 'sync_office' - 'updated_at') is distinct from (to_jsonb(old) - 'sync_office' - 'updated_at'))
  execute function job_bookings_after_change();

-- ---------------------------------------------------------------------------
-- 4. The refresh — 0068's body unchanged, plus job_bookings after the other
--    job children. Still the ONLY code path that sets a window flag false.
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

  -- 0080: bookings follow their job, like every other job child. A booking
  -- inside the window is on a job that is itself in-window (its window is the
  -- job's scheduled span), so the job's flag decides in practice.
  update job_bookings c set sync_office = x.v
    from (select c2.id, (coalesce(j.sync_office, false) or c2.created_at >= office_cut) as v
            from job_bookings c2 left join jobs j on j.id = c2.job_id) x
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

comment on function sync_window_refresh() is
  'Recomputes every PowerSync window flag (0068, job_bookings since 0080) and writes sync_horizon. The only path that sets a flag false. Scheduled nightly by pg_cron (job sync-window-refresh).';

-- Backfill: every existing booking defaulted to true above; this computes the
-- real flags (and every other table's, idempotently — only rows whose flag
-- changes are written).
select sync_window_refresh();

-- ---------------------------------------------------------------------------
-- 5. Assert.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'powersync' and schemaname = 'public' and tablename = 'job_bookings') then
    raise exception 'ASSERTION FAILED: job_bookings is not in the powersync publication';
  end if;

  select count(*) into n from job_bookings b join jobs j on j.id = b.job_id
   where j.sync_office and not b.sync_office;
  if n > 0 then
    raise exception 'ASSERTION FAILED: % booking(s) of in-window jobs flagged out (invariant O1)', n;
  end if;

  if position('job_bookings' in pg_get_functiondef('sync_window_refresh()'::regprocedure)) = 0 then
    raise exception 'ASSERTION FAILED: sync_window_refresh() does not refresh job_bookings';
  end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'job_bookings'::regclass and not tgisinternal
     and tgname in ('zz_job_bookings_sync_window', 'zz_job_bookings_sync_window_touch',
                    'job_bookings_touch', 'job_bookings_derive', 'job_bookings_derive_update');
  if n <> 5 then
    raise exception 'ASSERTION FAILED: expected 5 job_bookings triggers, found %', n;
  end if;

  if has_table_privilege('anon', 'public.job_bookings', 'select') then
    raise exception 'ASSERTION FAILED: anon can read job_bookings';
  end if;
end;
$$;
