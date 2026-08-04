-- ============================================================================
-- Make 0045's column grants maintainable.
--
-- 0045 secured time_entries.rate_override by revoking table-level SELECT and
-- re-granting every other column, with the list generated at migration time.
-- An adversarial review (gemini-2.5-pro, 4 Aug 2026) named the fragility that
-- creates, and it is worth stating plainly because it is this codebase's
-- signature failure:
--
--   a future migration adds a column, that column receives no grant, and
--   `authenticated` silently cannot read it. Nothing errors. The value simply
--   never arrives, and someone loses an afternoon to a screen that renders
--   blank for no visible reason.
--
-- money_boundary_sweep.sql asserts against exactly that, but only when someone
-- runs it. This gives migrations a one-liner to call so the problem is
-- prevented rather than detected later.
--
-- WHY NOT A VIEW. The reviewer argued for the view pattern used by 0038 —
-- fail-closed, since a new column is invisible until deliberately added. It is
-- the better default and was rejected here for one specific reason: technicians
-- must INSERT and UPDATE time_entries constantly (clocking in and out is the
-- app's core action), and an updatable view needs INSTEAD OF triggers for both.
-- That is materially more machinery on the single hottest write path in the
-- product, to protect a column no code reads. 0038's tables were read-only for
-- technicians, which is why a view was free there and is not free here.
--
-- WHY NOT AN EVENT TRIGGER. It cannot tell a new money column from a new
-- ordinary one, so it would either grant everything (reopening the hole) or
-- grant nothing (breaking the app). The judgement has to stay with whoever adds
-- the column.
-- ============================================================================

create or replace function reapply_time_entries_grants()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cols text;
begin
  -- Every column EXCEPT the money one. Regenerated from the live schema, so it
  -- is correct for whatever the table looks like when this runs.
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'time_entries'
    and column_name <> 'rate_override';

  if cols is null then
    raise exception 'reapply_time_entries_grants: time_entries has no columns — refusing to run';
  end if;

  execute 'revoke select on public.time_entries from authenticated';
  execute 'revoke select on public.time_entries from anon';
  execute format('grant select (%s) on public.time_entries to authenticated', cols);
end;
$$;

comment on function reapply_time_entries_grants() is
  'Re-applies the column-level SELECT grants that hide time_entries.rate_override '
  'from technicians (migration 0045). CALL THIS at the end of any migration that '
  'adds or removes a time_entries column, or the new column is silently invisible '
  'to authenticated users.';

-- The warning lives on the table too, because that is what someone reads when
-- they are about to alter it.
comment on table public.time_entries is
  'SECURITY: uses column-level SELECT grants — rate_override is hidden from '
  'technicians (migration 0045). After ALTERing columns, run '
  'select reapply_time_entries_grants(); otherwise the new column is invisible to '
  'authenticated users and reads as silently absent.';

-- ---------------------------------------------------------------------------
-- Assert: running the helper must leave exactly the state 0045 established —
-- rate_override hidden, everything else readable, writes intact.
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  perform reapply_time_entries_grants();

  if has_column_privilege('authenticated', 'public.time_entries', 'rate_override', 'SELECT') then
    raise exception 'ASSERTION FAILED: helper left rate_override readable by authenticated';
  end if;

  select string_agg(column_name, ', ') into bad
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'time_entries'
    and column_name <> 'rate_override'
    and not has_column_privilege('authenticated', 'public.time_entries', column_name, 'SELECT');
  if bad is not null then
    raise exception 'ASSERTION FAILED: helper left column(s) [%] unreadable', bad;
  end if;

  if not has_table_privilege('authenticated', 'public.time_entries', 'INSERT')
     or not has_table_privilege('authenticated', 'public.time_entries', 'UPDATE') then
    raise exception 'ASSERTION FAILED: helper broke INSERT/UPDATE — clocking in would stop working';
  end if;
end;
$$;
