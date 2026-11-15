-- ============================================================================
-- Pinned suppliers for the PO supplier picker.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-14, via SQL editor). Gate test
-- supabase/tests/0097_pinned_suppliers_test.sql passed.
--
-- WHY (Justin, Nov 2026): picking a supplier on a PO meant scrolling the whole
-- Xero contact list. The pickers (web PO tab, phone Orders tab) now show
-- Pinned, then Recent, then everyone else A–Z, with a search across all of it.
--
--   suppliers.pin_order   position in the Pinned group, 1 first. Null = not
--                         pinned. Set by the office in Settings → Suppliers.
--                         The nightly Xero copy upserts only Xero's own
--                         columns, so it leaves this alone.
--
--   vendor_orders.entered_by  now defaults to the signed-in user. "Recent" is
--                         worked out from vendor_orders (supplier_id or name,
--                         created_at, entered_by) — no new table. The phone's
--                         route always set entered_by; the web PO tab did not,
--                         so the office's own recent list had nothing to go on.
--
--   vendor_orders_created_at_idx  the recent-suppliers read takes the newest
--                         few hundred orders across every job.
--
-- SEED: the four main suppliers are pinned by name, once — only when nothing
-- is pinned yet, so re-running never undoes what the office changed. Matches
-- (case-insensitive): names starting "Reece"; "Plumbers Co-op" / "Plumbers
-- Coop" / "Plumbers Co op"; "Northern Quarr…"; names starting "Boral". Every
-- active match is pinned (several Reece branches would all be pinned), in that
-- order, A–Z within each. A NOTICE names what was pinned and any of the four
-- not found — pin those by hand in Settings → Suppliers.
--
-- suppliers is office/admin only by RLS and granted at table level (0088), so
-- the new column needs no grant of its own. Technicians see pin_order only
-- through /api/jobs/[id]/supplier-orders (service role), next to the names
-- they already get. Nothing here carries money.
-- ============================================================================

alter table suppliers add column if not exists pin_order integer;
alter table suppliers drop constraint if exists suppliers_pin_order_positive;
alter table suppliers add constraint suppliers_pin_order_positive
  check (pin_order is null or pin_order > 0);

comment on column suppliers.pin_order is
  'Position in the Pinned group of the PO supplier picker, 1 first (0097). Null = not pinned. Set in Settings → Suppliers.';

alter table vendor_orders alter column entered_by set default auth.uid();

create index if not exists vendor_orders_created_at_idx on vendor_orders (created_at desc);

do $$
declare
  pinned text;
  missing text := '';
begin
  if exists (select 1 from suppliers where pin_order is not null) then
    raise notice '0097: suppliers already pinned — seed skipped';
    return;
  end if;

  with wanted as (
    select s.id,
           case
             when s.name ~* '^\s*reece' then 1
             when s.name ~* 'plumbers?\s*co[\s-]*op' then 2
             when s.name ~* 'northern\s+quarr' then 3
             when s.name ~* '^\s*boral' then 4
           end as grp,
           s.name
    from suppliers s
    where s.is_active
  ),
  ranked as (
    select id, row_number() over (order by grp, lower(name)) as pos
    from wanted
    where grp is not null
  )
  update suppliers s set pin_order = r.pos, updated_at = now()
  from ranked r
  where s.id = r.id;

  select string_agg(name, ', ' order by pin_order) into pinned from suppliers where pin_order is not null;
  raise notice '0097: pinned %', coalesce(pinned, 'nothing');

  if not exists (select 1 from suppliers where pin_order is not null and name ~* '^\s*reece') then missing := missing || ' Reece;'; end if;
  if not exists (select 1 from suppliers where pin_order is not null and name ~* 'plumbers?\s*co[\s-]*op') then missing := missing || ' Plumbers Co-op;'; end if;
  if not exists (select 1 from suppliers where pin_order is not null and name ~* 'northern\s+quarr') then missing := missing || ' Northern Quarries;'; end if;
  if not exists (select 1 from suppliers where pin_order is not null and name ~* '^\s*boral') then missing := missing || ' Boral;'; end if;
  if missing <> '' then
    raise notice '0097: not found on the supplier list, pin by hand in Settings → Suppliers:%', missing;
  end if;
end;
$$;

notify pgrst, 'reload schema';
