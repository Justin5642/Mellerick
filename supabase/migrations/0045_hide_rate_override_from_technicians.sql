-- ============================================================================
-- time_entries.rate_override — the last money column a technician could read
--
-- Found 2026-08-04 by the production security audit, then verified by
-- impersonation before writing this.
--
-- THE HOLE. `time_entries` carries `rate_override` — an override of the hourly
-- charge-out rate, which is money — and its RLS policy is
-- `auth.role() = 'authenticated'`, i.e. every signed-in user. Impersonating a
-- real technician against the live database:
--
--     select count(*) from time_entries where rate_override is not null;
--     -> 1 non-null rows VISIBLE
--
-- The four-layer money boundary held on three layers and not this one:
--
--   • the SYNC path is clean — tech_time_entries selects explicit columns and
--     rate_override is not among them, so it never reaches a device
--   • the UI never renders it
--   • MoneyText/RoleGate never receive it
--   • RLS let a technician read it directly
--
-- which is precisely the threat model migration 0038 wrote down: "a technician
-- holds the anon key and can query PostgREST directly, regardless of what the
-- app's UI shows". The anon key ships inside the app. A technician does not
-- need the app to use it.
--
-- WHY A COLUMN-LEVEL REVOKE RATHER THAN A VIEW. 0038 solved the same shape for
-- purchase_orders with a money-free view plus a base-table lock, because those
-- tables were READ by the app and the reads could be repointed. This is
-- different in a way that makes the surgical fix correct:
--
--   • NO application code reads rate_override — zero hits across web and mobile
--   • no sync stream carries it
--   • no query does `select *` on time_entries
--   • the outbox writes with `return=minimal`, so no post-write representation
--     implicitly selects it
--
-- So revoking the column breaks nothing, and unlike a view it cannot be bypassed
-- by a caller who simply queries the base table. Technicians keep full INSERT
-- and UPDATE on time_entries — clocking in and out is their job — because
-- revoking SELECT on one column does not affect writes.
--
-- IF THE OFFICE EVER NEEDS THIS COLUMN, do not re-grant it to `authenticated`:
-- that puts the hole straight back. Expose it through an office/admin-gated
-- view, the way 0038 did, or read it with the service role from a route that
-- authorises the caller itself.
-- ============================================================================

-- A column-level REVOKE does NOT override a TABLE-level GRANT: the table grant
-- already implies every column, so revoking one column alone is a silent no-op.
-- (The assertion below caught exactly that on the first attempt.) The working
-- pattern is to drop the table-level grant and re-grant the columns explicitly.
--
-- Generated rather than hand-listed, so a column added later is granted
-- automatically and only rate_override stays excluded — a hand-written list
-- would quietly deny every future column instead.
do $$
declare
  cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'time_entries'
    and column_name <> 'rate_override';

  execute 'revoke select on public.time_entries from authenticated';
  execute 'revoke select on public.time_entries from anon';
  execute format('grant select (%s) on public.time_entries to authenticated', cols);
end;
$$;

-- ---------------------------------------------------------------------------
-- Assert the end state. A security migration that can silently achieve nothing
-- is worse than none, because it closes the ticket.
-- ---------------------------------------------------------------------------
do $$
declare
  can_read boolean;
  col_count int;
begin
  -- The grant must be gone for `authenticated`.
  select has_column_privilege('authenticated', 'public.time_entries', 'rate_override', 'SELECT')
    into can_read;
  if can_read then
    raise exception 'ASSERTION FAILED: authenticated can still SELECT time_entries.rate_override';
  end if;

  -- Every OTHER column must still be readable, or this has broken the app
  -- rather than secured it.
  select count(*) into col_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'time_entries'
    and column_name <> 'rate_override'
    and not has_column_privilege('authenticated', 'public.time_entries', column_name, 'SELECT');
  if col_count > 0 then
    raise exception 'ASSERTION FAILED: % other time_entries column(s) lost SELECT — this migration was too broad', col_count;
  end if;

  -- Writes must survive: clocking in and out is the technician's core action.
  if not has_table_privilege('authenticated', 'public.time_entries', 'INSERT') then
    raise exception 'ASSERTION FAILED: authenticated lost INSERT on time_entries';
  end if;
  if not has_table_privilege('authenticated', 'public.time_entries', 'UPDATE') then
    raise exception 'ASSERTION FAILED: authenticated lost UPDATE on time_entries';
  end if;
end;
$$;
