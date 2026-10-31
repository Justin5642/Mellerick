-- ============================================================================
-- Stage 0 fixes from the 31 Oct 2026 workflow review.
--
-- STATUS: DRAFT, not applied yet. Gate test supabase/tests/0086_stage_0_fixes_test.sql.
--
-- 1. "Project" job type. The web New Job form and job Overview offer
--    'project', but the baseline check (0000) only allows service /
--    installation / maintenance / emergency / quote, so saving a Project job
--    fails. The old check is found by its definition, not its name, in case
--    production named it differently.
--
-- 2. No automatic hourly labour lines (Justin, 31 Oct 2026: "Never
--    automatic"). Each clock-in used to add a "Labour" job_items line at the
--    charge-out rate plus a "Call Out Fee", which put hours on top of a
--    builder's fixed price. billing_rate_config.auto_labour_lines = false stops
--    lib/labour-billing-sync.ts adding or repricing them; lines already on a
--    job are left as they are. Set it back to true to switch them on again.
--
-- 3. Minimum margin flag 30% -> 20% (Justin, 31 Oct 2026). Nothing in the app
--    edits this setting yet, so it is set here.
-- ============================================================================

do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.jobs'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%job_type%'
  loop
    execute format('alter table public.jobs drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table jobs add constraint jobs_job_type_check
  check (job_type in ('service', 'installation', 'maintenance', 'emergency', 'quote', 'project'));

alter table billing_rate_config
  add column if not exists auto_labour_lines boolean not null default false;

comment on column billing_rate_config.auto_labour_lines is
  'Whether time entries add hourly "Labour" and "Call Out Fee" lines to a job automatically (0086). Off since 31 Oct 2026: builder work is fixed price; the office adds labour by hand for day work.';

update billing_rate_config set min_margin_pct = 20 where id;
