-- =============================================
-- MANUAL RATE OVERRIDE FOR TIME ENTRIES
-- Run this once in the Supabase SQL editor.
--
-- Purpose: labour billing (migration 0024) auto-detects normal/time-and-a-
-- half/double-time purely from the day-of-week + wall-clock time of a time
-- entry (lib/labour-billing.ts's splitHoursByBand). That's right for a
-- genuine after-hours/weekend emergency call-out, but wrong for a job that
-- just happened to be scheduled on a weekend for the business's own
-- convenience rather than the customer's -- that should bill at the normal
-- rate instead. This lets an Admin manually correct which band a given
-- entry's hours are billed at, overriding the sync route's automatic
-- detection on a per-entry basis (see
-- app/api/time-entries/[id]/sync-billing/route.ts).
-- =============================================

alter table time_entries add column if not exists rate_override text
  check (rate_override in ('normal', 'time_and_half', 'double_time'));

comment on column time_entries.rate_override is
  'Admin-only override for which billing band (see lib/labour-billing.ts''s RateBand) this entry''s hours are charged at -- when set, the sync route bills ALL of the entry''s hours at this one band instead of splitting them by the automatic day/time detection. null (default) = auto-detect as before.';

-- time_entries as a whole must stay writable by the technician who logged
-- it (clock in/out, corrections, cost_center_id, etc.), so this can't just
-- be a blanket Admin-only RLS policy on the row the way job_items' source
-- column was locked down in migration 0024 -- Postgres RLS is row-level,
-- not column-level. Instead, a trigger silently reverts any attempted
-- change to this one column unless the caller is an Admin, leaving every
-- other column exactly as writable as it already was. Uses the same
-- is_admin() helper introduced in migration 0010 (security definer, so the
-- internal profiles lookup doesn't re-trigger RLS).
create or replace function enforce_rate_override_admin_only()
returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.rate_override is not null and not is_admin(auth.uid()) then
      new.rate_override := null;
    end if;
  else
    if new.rate_override is distinct from old.rate_override and not is_admin(auth.uid()) then
      new.rate_override := old.rate_override;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists time_entries_rate_override_admin_only on time_entries;
create trigger time_entries_rate_override_admin_only
  before insert or update on time_entries
  for each row execute function enforce_rate_override_admin_only();
