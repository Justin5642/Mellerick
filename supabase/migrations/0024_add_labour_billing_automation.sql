-- =============================================
-- AUTOMATED LABOUR BILLING
-- Run this once in the Supabase SQL editor.
--
-- Purpose: technicians were manually typing a labour line item price into
-- job_items (e.g. "Plumber Labor" x 3 @ $130), with nothing stopping any
-- authenticated user from typing whatever number they liked. This locks
-- rates down to Admins only and switches labour billing to be generated
-- automatically from logged time_entries, using:
--   - a flat rate for "qualified" tradespeople (same $ regardless of who's
--     on the tools), or their own loaded cost rate + a margin for
--     "apprentice" staff (see lib/staff-cost.ts's computeLoadedCost)
--   - a 1.5x / 2x multiplier stacked on top for time-and-a-half/double-time
--     hours, per lib/labour-billing.ts's splitHoursByBand
-- The actual sync (time_entries row -> job_items row) happens in
-- app/api/time-entries/[id]/sync-billing/route.ts, called right after any
-- client writes a time entry (mirrors the existing "insert then
-- fetch(/api/.../sync-...)" fire-and-forget pattern used for jobs' Google
-- Calendar sync).
-- =============================================

-- Qualified vs apprentice is a trade/pay-rate distinction, not the same
-- thing as profiles.role (admin/office/technician, which only controls app
-- access -- e.g. an admin can still be out doing plumbing work). Lives on
-- staff_cost_profiles (already admin-only, see migration 0014) since it
-- directly drives what a staff member bills out at.
alter table staff_cost_profiles add column if not exists trade_level text not null default 'qualified'
  check (trade_level in ('qualified', 'apprentice'));

comment on column staff_cost_profiles.trade_level is
  'Drives which labour billing formula applies to this person''s logged hours: qualified = flat company rate regardless of individual cost; apprentice = their own loaded hourly cost rate + billing_rate_config.apprentice_margin_pct. Independent of profiles.role (app-access level).';

-- Singleton table (the boolean PK + check trick guarantees exactly one row
-- can ever exist) holding the company-wide labour rates, so they can be
-- changed by an Admin without a code deploy. Locked to admins only, same
-- reasoning as staff_cost_profiles/equipment: these numbers directly
-- determine what customers get billed.
create table if not exists billing_rate_config (
  id boolean primary key default true,
  check (id),
  qualified_base_rate numeric(10,2) not null default 130,
  apprentice_margin_pct numeric(5,2) not null default 30,
  time_and_half_multiplier numeric(4,2) not null default 1.5,
  double_time_multiplier numeric(4,2) not null default 2,
  call_out_fee numeric(10,2) not null default 180,
  updated_at timestamptz default now(),
  updated_by uuid references profiles(id)
);

insert into billing_rate_config (id) values (true) on conflict (id) do nothing;

alter table billing_rate_config enable row level security;
create policy "Admin can manage billing rate config" on billing_rate_config for all
  using (is_admin(auth.uid())) with check (is_admin(auth.uid()));

comment on table billing_rate_config is
  'Company-wide labour billing rates (admin-only). Exactly one row ever exists. qualified_base_rate is the flat $/hr for a qualified tradesperson in ordinary hours; apprentice_margin_pct is added on top of an apprentice''s own loaded cost rate instead; the two multipliers stack on top of whichever base rate applies for time-and-a-half/double-time hours (see lib/labour-billing.ts). call_out_fee is billed once per job and is understood to cover travel time (travel time_entries are not separately billed).';

-- Links an auto-generated labour job_items row back to the time_entries row
-- that produced it, so the sync route can find-and-update (or the FK
-- cascade can clean up) the right row instead of guessing. `source`
-- distinguishes system-generated rows (which only Admins/the sync route can
-- touch, see RLS below) from ones a staff member typed in by hand.
alter table job_items add column if not exists source text not null default 'manual'
  check (source in ('manual', 'auto_labour', 'auto_callout'));
alter table job_items add column if not exists staff_id uuid references profiles(id);
alter table job_items add column if not exists time_entry_id uuid references time_entries(id) on delete cascade;

comment on column job_items.source is
  'manual = typed in by an Admin; auto_labour = generated from a time_entries row by the labour billing sync; auto_callout = the one-off call-out fee auto-added the first time work is logged on a job.';
comment on column job_items.time_entry_id is
  'The time_entries row this labour line item was generated from (auto_labour rows only). on delete cascade so deleting/correcting a time entry automatically removes its billed line item.';

create unique index if not exists job_items_time_entry_id_key on job_items(time_entry_id) where time_entry_id is not null;
-- At most one auto-added call-out fee per job, however many time entries get logged.
create unique index if not exists job_items_one_callout_per_job on job_items(job_id) where source = 'auto_callout';

-- Lock job_items down: everyone authenticated can still view the job's
-- billable items (technicians need to see what's on the job), but only
-- Admins can create/edit/delete one directly. The sync route uses the
-- service-role key (bypasses RLS entirely) to write auto_labour/
-- auto_callout rows on a technician's behalf when they log time, so this
-- doesn't block the automation -- it only blocks a non-admin typing a price
-- in themselves.
drop policy if exists "Authenticated users can manage job items" on job_items;
create policy "Authenticated users can view job items" on job_items for select using (auth.role() = 'authenticated');
create policy "Admin can manage job items" on job_items for all
  using (is_admin(auth.uid())) with check (is_admin(auth.uid()));
