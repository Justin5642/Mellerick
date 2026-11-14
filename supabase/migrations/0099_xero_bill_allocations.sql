-- ============================================================================
-- Which job (or overhead) each Xero supplier bill belongs to.
--
-- STATUS: DRAFT — NOT APPLIED. Written 14 Nov 2026 on branch feat/unallocated-bills.
-- Needs 0098 first (xero_invoices). Apply (SQL editor), run
-- supabase/tests/0099_xero_bill_allocations_test.sql, THEN merge.
--
-- WHY (Justin, 14 Nov 2026): profit per job has never been accurate because
-- supplier bills land in Xero by account ("Materials"), not by job. Bills the
-- app makes itself (a PO's invoice, an expense) already know their job. Every
-- OTHER bill — keyed straight into Xero, a Reece statement, fuel — has no job.
-- The Unallocated bills report lists them, and the office assigns each one here:
--
--   kind = 'job'       the bill's cost belongs to job_id (and, if known, the
--                      cost centre that bore it)
--   kind = 'overhead'  a business running cost, deliberately not on any job
--
-- Assigning is a decision the office made, so it is its own row (who, when,
-- why) rather than an edit of the Xero mirror, which is re-copied from Xero and
-- must stay a faithful copy. One allocation per bill. No money is stored here:
-- the amount is read from xero_invoices, so it can never disagree with Xero.
--
-- OFFICE/ADMIN ONLY by RLS (it names costs against jobs), in no PowerSync
-- stream. Granted explicitly (the 0088 lesson).
-- ============================================================================

create table if not exists xero_bill_allocations (
  xero_invoice_id text primary key references xero_invoices(xero_invoice_id) on delete cascade,
  kind text not null check (kind in ('job', 'overhead')),
  job_id uuid references jobs(id) on delete cascade,
  cost_centre_id uuid references cost_centres(id) on delete set null,
  note text,
  allocated_by uuid default auth.uid() references profiles(id) on delete set null,
  allocated_at timestamptz not null default now(),
  -- A 'job' allocation names its job. If the job is later deleted its
  -- allocations go with it (ON DELETE CASCADE) and the bill shows as
  -- unallocated again — the safe reading, and it keeps this CHECK satisfiable.
  constraint xero_bill_allocations_job_named check (kind <> 'job' or job_id is not null),
  constraint xero_bill_allocations_overhead_has_no_job check (kind <> 'overhead' or job_id is null)
);

create index if not exists xero_bill_allocations_job_idx on xero_bill_allocations (job_id);

alter table xero_bill_allocations enable row level security;

drop policy if exists "xero bill allocations: office/admin" on xero_bill_allocations;
create policy "xero bill allocations: office/admin" on xero_bill_allocations for all to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

revoke all on xero_bill_allocations from anon;
grant select, insert, update, delete on xero_bill_allocations to authenticated;
grant select, insert, update, delete on xero_bill_allocations to service_role;

comment on table xero_bill_allocations is
  'The office''s decision on which job (or overhead) a Xero supplier bill belongs to (0099). No amounts — read from xero_invoices.';
