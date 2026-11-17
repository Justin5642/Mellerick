-- ============================================================================
-- Truck loads (cartage): the driver logs each trip on the job as it happens —
-- quarry product IN, spoil OUT to a tip — instead of only end-of-day hours.
--
-- STATUS: DRAFT — NOT APPLIED. Paste it into the Supabase SQL editor, then
-- paste supabase/tests/0111_cartage_loads_test.sql and trust only its final
-- "0111 PASSED" row. Then change this line to applied and record it in the
-- ledger.
--
-- WHY (Justin, 17 Nov 2026):
--   1. "Some jobs include quarry products, some don't." Each material-in load
--      is INCLUDED (in the quoted price — a cost only) or EXTRA (charged to the
--      builder). jobs.quarry_included is the job's default, set by the office
--      (null = included); the driver can change it per load.
--   2. "The spoil removal is almost always an extra charge." Spoil-out loads
--      default to EXTRA; the driver can switch one to included.
--   3. Spoil cartage is charged per tonne or per m³ (from the tip docket), at
--      the truck's own rate: equipment_hire_options (0108) gains the units
--      'tonne' and 'm3' for hire_type 'cartage'.
--   4. Quarry product and tip fees charged on are priced cost + margin + km:
--      docket cost (ex GST) × (1 + margin%) + km × the truck's per-km rate.
--      The margin is a company setting (billing_rate_config.cartage_margin_pct,
--      default 15%), overridable per load by the office. Pricing is in
--      lib/cartage-pricing.ts, office-side only.
--
-- WHAT IT ADDS
--   equipment_hire_options   hire_unit may be 'tonne' / 'm3' (cartage only).
--   billing_rate_config      + cartage_margin_pct (admin table; read by the
--                              app's office routes through the service role).
--   jobs                     + quarry_included (office/admin only to change).
--   cartage_loads            one row per trip. Quantities only — NO money
--                            column — so the job's crew read and write it
--                            (user_can_manage_job). draft → signed →
--                            invoiced, or void, with 0108's lock: an EXTRA
--                            load needs the builder's sign-off before it is
--                            invoiced; once signed nothing about it changes
--                            for anyone; only the office moves signed →
--                            invoiced (same job's invoice) or void; deleting
--                            the invoice puts its loads back to signed.
--                            Included loads need no signing and are never
--                            invoiced.
--   cartage_load_costs       the docket cost (ex GST) and a margin override,
--                            per load. OFFICE/ADMIN ONLY. Locked once the load
--                            is invoiced or void.
--
-- DOCKET PHOTOS show prices. They are stored in job-documents at
--   <jobId>/expense-receipt-cartage-<loadId>-<ts>.<ext>
-- which storage_object_is_money_document() (0047, widened by 0065) already
-- classifies as a money document, so technicians can neither read nor write
-- it; the app uploads it through the service role after requireOnJob. The
-- assert at the bottom checks that classification.
--
-- THE MONEY RULE (HANDOVER §2): no column on cartage_loads matches
-- money_boundary_sweep.sql's money regex (the included/extra flag is named
-- `billing`, not "charge", for that reason). Not added to any PowerSync
-- stream.
--
-- New tables are granted explicitly (0088). Policies are dropped by
-- enumeration on this migration's own tables, constraints by definition, and
-- the end state is asserted (§4). Idempotent: safe to paste twice.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Truck rates per tonne / m³ on the existing hire setup.
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  -- Every check constraint that mentions hire_unit (the column check and
  -- 0108's unit_fits_type), whatever it is called.
  for c in
    select conname from pg_constraint
     where conrelid = 'public.equipment_hire_options'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%hire_unit%'
  loop
    execute format('alter table equipment_hire_options drop constraint %I', c.conname);
  end loop;
end $$;

alter table equipment_hire_options
  add constraint equipment_hire_options_hire_unit_check
  check (hire_unit in ('hour', 'day', 'engine_hour', 'km', 'contract', 'move', 'tonne', 'm3'));
alter table equipment_hire_options
  add constraint equipment_hire_options_unit_fits_type check (
       (hire_type = 'wet' and hire_unit = 'hour')
    or (hire_type = 'dry' and hire_unit in ('day', 'engine_hour'))
    or (hire_type = 'cartage' and hire_unit in ('hour', 'km', 'contract', 'tonne', 'm3'))
    or (hire_type = 'float' and hire_unit = 'move')
  );

comment on column equipment_hire_options.hire_unit is
  'hour | day | engine_hour | km | contract | move (0108); tonne | m3 (0111, cartage only: a truck''s rate per tonne / m³ carted, used for Truck loads).';

-- ---------------------------------------------------------------------------
-- 2. Company margin on quarry product and tip fees charged on.
-- ---------------------------------------------------------------------------
alter table billing_rate_config
  add column if not exists cartage_margin_pct numeric(6,2) not null default 15;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.billing_rate_config'::regclass
                  and conname = 'billing_rate_config_cartage_margin_pct_range') then
    alter table billing_rate_config add constraint billing_rate_config_cartage_margin_pct_range
      check (cartage_margin_pct >= 0 and cartage_margin_pct <= 1000);
  end if;
end $$;
comment on column billing_rate_config.cartage_margin_pct is
  'Margin (%) added to the docket cost of quarry product and tip fees charged on as Truck loads (0111). Overridable per load in cartage_load_costs.margin_pct.';

-- ---------------------------------------------------------------------------
-- 3. The job's default for quarry product: included in the quote or extra.
-- ---------------------------------------------------------------------------
alter table jobs add column if not exists quarry_included boolean;
comment on column jobs.quarry_included is
  'Truck loads (0111): is quarry product included in this job''s quoted price? Null = included (the default). The driver can change it per load. Office/admin only to change.';

create or replace function jobs_quarry_included_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') and not (select is_office_or_admin(auth.uid())) then
    if tg_op = 'INSERT' then
      new.quarry_included := null;
    elsif new.quarry_included is distinct from old.quarry_included then
      raise exception 'Only the office can change whether quarry product is included on this job.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_quarry_included_guard on jobs;
create trigger jobs_quarry_included_guard before insert or update of quarry_included on jobs
  for each row execute function jobs_quarry_included_guard();

-- ---------------------------------------------------------------------------
-- 4. The loads (quantities only — readable by the job's crew).
-- ---------------------------------------------------------------------------
create table if not exists cartage_loads (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  equipment_id uuid not null references equipment(id) on delete restrict,
  load_date date not null,
  direction text not null check (direction in ('material_in', 'spoil_out')),
  material text check (material is null or length(material) <= 200),
  supplier_id uuid references suppliers(id) on delete set null,
  place text check (place is null or length(place) <= 200),
  from_text text check (from_text is null or length(from_text) <= 200),
  to_text text check (to_text is null or length(to_text) <= 200),
  quantity numeric(10,2) check (quantity is null or quantity >= 0),
  unit text not null default 'tonne' check (unit in ('tonne', 'm3', 'load')),
  km numeric(8,1) check (km is null or km >= 0),
  docket_number text check (docket_number is null or length(docket_number) <= 60),
  docket_photo_path text,
  billing text not null check (billing in ('included', 'extra')),
  cost_centre_id uuid references cost_centres(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'signed', 'invoiced', 'void')),
  signer_name text,
  signature_path text,
  signed_at timestamptz,
  signed_by uuid references profiles(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  void_reason text,
  created_by uuid references profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cartage_loads_invoiced_has_invoice check ((status = 'invoiced') = (invoice_id is not null)),
  constraint cartage_loads_only_extras_invoiced check (status <> 'invoiced' or billing = 'extra')
);
create index if not exists cartage_loads_job_id_idx on cartage_loads(job_id, load_date);
create index if not exists cartage_loads_equipment_date_idx on cartage_loads(equipment_id, load_date);
create index if not exists cartage_loads_invoice_id_idx on cartage_loads(invoice_id);
create index if not exists cartage_loads_supplier_id_idx on cartage_loads(supplier_id) where supplier_id is not null;

comment on table cartage_loads is
  'Truck loads (0111): one row per trip on a job — quarry product in or spoil out — quantities only; costs and prices are office-side (cartage_load_costs, lib/cartage-pricing.ts). Extra loads are signed by the builder''s rep, then locked, then invoiced as Day Works.';
comment on column cartage_loads.billing is
  'included = in the quoted price (a cost only, never invoiced); extra = charged to the builder. Defaults: spoil_out → extra; material_in → extra only when jobs.quarry_included is false.';
comment on column cartage_loads.docket_photo_path is
  'job-documents key <job>/expense-receipt-cartage-<load>-<ts>.<ext>: a money document (0047/0065), hidden from technicians.';

-- The cost centre for a truck's loads, and the check that it is a truck at
-- all. SECURITY DEFINER because the crew cannot read equipment or
-- equipment_hire_options (they carry costs and rates); returns only an id.
create or replace function cartage_load_cost_centre(p_equipment uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  cat text;
  found_it boolean;
  centre uuid;
begin
  select true, e.category into found_it, cat from equipment e where e.id = p_equipment and coalesce(e.is_active, true);
  if not coalesce(found_it, false) or cat = 'tool' then
    raise exception 'Pick the truck from the fleet register.' using errcode = 'check_violation';
  end if;
  select o.cost_centre_id into centre
    from equipment_hire_options o
   where o.equipment_id = p_equipment and o.hire_type = 'cartage' and o.is_active and o.cost_centre_id is not null
   order by o.hire_unit
   limit 1;
  if centre is null then
    select c.id into centre from cost_centres c where lower(btrim(c.name)) = 'transport' limit 1;
  end if;
  if centre is null then
    select c.id into centre from cost_centres c where lower(btrim(c.name)) = 'truck cartage' limit 1;
  end if;
  return centre;
end;
$$;
revoke all on function cartage_load_cost_centre(uuid) from public, anon;
grant execute on function cartage_load_cost_centre(uuid) to authenticated, service_role;

-- The defaults, the lock and the status rules. Runs as the caller (not
-- SECURITY DEFINER), so current_user tells a signed-in app user
-- (authenticated) from the service role, the SQL editor, or a cascade from
-- deleting an invoice (table owner) — as 0108's hire_entries_guard.
create or replace function cartage_loads_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  privileged boolean := (select is_office_or_admin(auth.uid())) or current_user not in ('authenticated', 'anon');
  derived uuid;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A truck load starts as a draft and is signed off afterwards.' using errcode = 'check_violation';
    end if;
    new.signer_name := null;
    new.signature_path := null;
    new.signed_at := null;
    new.signed_by := null;
    new.invoice_id := null;
    if not privileged then
      -- Docket photos are uploaded through the app's route, which sets the path on its own write.
      new.docket_photo_path := null;
    end if;
    if not privileged or new.created_by is null then
      new.created_by := auth.uid();
    end if;
    if new.billing is null then
      new.billing := case
        when new.direction = 'spoil_out' then 'extra'
        when (select j.quarry_included from jobs j where j.id = new.job_id) is false then 'extra'
        else 'included'
      end;
    end if;
    derived := cartage_load_cost_centre(new.equipment_id);
    if not privileged or new.cost_centre_id is null then
      new.cost_centre_id := derived;
    end if;
    return new;
  end if;

  -- UPDATE ------------------------------------------------------------------
  -- An invoice deleted (FK set null) or taken off by the office: back to signed.
  if old.status = 'invoiced' and new.invoice_id is null and new.status = 'invoiced' then
    new.status := 'signed';
  end if;

  if old.status = 'draft' then
    if new.status = 'invoiced' then
      raise exception 'Get the builder to sign this load off before invoicing it.' using errcode = 'check_violation';
    end if;
    if new.status = 'void' and not privileged then
      raise exception 'Only the office can void a truck load. Delete the draft instead.' using errcode = 'insufficient_privilege';
    end if;
    if new.billing is null then
      new.billing := old.billing;
    end if;
    if new.equipment_id is distinct from old.equipment_id
       or (not privileged and new.cost_centre_id is distinct from old.cost_centre_id) then
      derived := cartage_load_cost_centre(new.equipment_id);
      if not privileged or new.cost_centre_id is not distinct from old.cost_centre_id then
        new.cost_centre_id := derived;
      end if;
    end if;
    if not privileged then
      new.created_by := old.created_by;
      new.docket_photo_path := old.docket_photo_path;
      new.job_id := old.job_id;
    end if;
    if new.status = 'signed' then
      if length(btrim(coalesce(new.signer_name, ''))) = 0 then
        raise exception 'Enter the name of the builder''s representative signing.' using errcode = 'check_violation';
      end if;
      if length(btrim(coalesce(new.signature_path, ''))) = 0 then
        raise exception 'The signature is missing. Ask them to sign again.' using errcode = 'check_violation';
      end if;
      if coalesce(new.quantity, 0) <= 0 then
        raise exception 'Enter how much was carted before it is signed.' using errcode = 'check_violation';
      end if;
      new.signed_at := now();
      new.signed_by := auth.uid();
    else
      new.signer_name := old.signer_name;
      new.signature_path := old.signature_path;
      new.signed_at := old.signed_at;
      new.signed_by := old.signed_by;
    end if;
    if new.invoice_id is not null then
      raise exception 'Get the builder to sign this load off before invoicing it.' using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- Signed, invoiced or void: locked.
  if not privileged then
    raise exception 'This truck load is signed and locked. Ask the office if it needs changing.' using errcode = 'insufficient_privilege';
  end if;
  -- The office may still attach the docket photo afterwards (the docket can
  -- reach the office after the builder signed); nothing else changes.
  if (new.job_id, new.equipment_id, new.load_date, new.direction, new.material, new.supplier_id, new.place,
      new.from_text, new.to_text, new.quantity, new.unit, new.km, new.docket_number, new.billing,
      new.signer_name, new.signature_path, new.signed_at, new.signed_by, new.created_by)
     is distinct from
     (old.job_id, old.equipment_id, old.load_date, old.direction, old.material, old.supplier_id, old.place,
      old.from_text, old.to_text, old.quantity, old.unit, old.km, old.docket_number, old.billing,
      old.signer_name, old.signature_path, old.signed_at, old.signed_by, old.created_by) then
    raise exception 'This truck load is signed and locked: its truck, date, quantities and docket cannot change. Void it and enter a new one.'
      using errcode = 'check_violation';
  end if;

  if old.status = 'void' and new.status <> 'void' then
    raise exception 'A voided truck load stays void. Enter a new one.' using errcode = 'check_violation';
  end if;
  if new.status = 'draft' then
    raise exception 'A signed truck load cannot go back to draft.' using errcode = 'check_violation';
  end if;
  if old.status = 'invoiced' and new.status = 'void' then
    raise exception 'Take this load off its invoice before voiding it.' using errcode = 'check_violation';
  end if;
  if new.status = 'invoiced' then
    if new.billing <> 'extra' then
      raise exception 'Only extra loads are invoiced; this one is included in the quoted price.' using errcode = 'check_violation';
    end if;
    if new.invoice_id is null then
      raise exception 'Choose the invoice this truck load is on.' using errcode = 'check_violation';
    end if;
    if old.status = 'invoiced' and new.invoice_id is distinct from old.invoice_id then
      raise exception 'This truck load is already on an invoice.' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from invoices i where i.id = new.invoice_id and i.job_id = new.job_id) then
      raise exception 'A truck load can only go on an invoice for its own job.' using errcode = 'check_violation';
    end if;
  else
    new.invoice_id := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cartage_loads_guard on cartage_loads;
create trigger cartage_loads_guard before insert or update on cartage_loads
  for each row execute function cartage_loads_guard();

-- ---------------------------------------------------------------------------
-- 5. Docket costs (office/admin only).
-- ---------------------------------------------------------------------------
create table if not exists cartage_load_costs (
  load_id uuid primary key references cartage_loads(id) on delete cascade,
  docket_cost_ex_gst numeric(10,2) check (docket_cost_ex_gst is null or docket_cost_ex_gst >= 0),
  margin_pct numeric(6,2) check (margin_pct is null or (margin_pct >= 0 and margin_pct <= 1000)),
  entered_by uuid references profiles(id) on delete set null default auth.uid(),
  entered_at timestamptz not null default now()
);

comment on table cartage_load_costs is
  'Truck loads (0111): the docket cost ex GST (quarry product or tip fee) and an optional margin override for one load. Office/admin only. Locked once the load is invoiced or void.';

create or replace function cartage_load_costs_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  load_status text;
  target uuid := case when tg_op = 'DELETE' then old.load_id else new.load_id end;
begin
  select l.status into load_status from cartage_loads l where l.id = target;
  if load_status in ('invoiced', 'void') and current_user in ('authenticated', 'anon') then
    raise exception 'This truck load is invoiced or void: its docket cost is locked.' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.load_id is distinct from new.load_id then
    raise exception 'A docket cost belongs to one load.' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  new.entered_by := coalesce(auth.uid(), new.entered_by);
  new.entered_at := now();
  return new;
end;
$$;

drop trigger if exists cartage_load_costs_guard on cartage_load_costs;
create trigger cartage_load_costs_guard before insert or update or delete on cartage_load_costs
  for each row execute function cartage_load_costs_guard();

-- ---------------------------------------------------------------------------
-- 6. RLS — re-runnable: clear this migration's own tables' policies by
--    enumeration first (HANDOVER §4 — never by guessed name).
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in
    select polname, polrelid::regclass::text as tbl from pg_policy
     where polrelid in (select oid from pg_class
                         where relnamespace = 'public'::regnamespace
                           and relname in ('cartage_loads', 'cartage_load_costs'))
  loop
    execute format('drop policy %I on %s', p.polname, p.tbl);
  end loop;
end $$;

alter table cartage_loads enable row level security;
create policy "cartage loads: crew and office read" on cartage_loads for select
  to authenticated
  using (user_can_manage_job(job_id::text));
create policy "cartage loads: crew and office add" on cartage_loads for insert
  to authenticated
  with check (user_can_manage_job(job_id::text));
create policy "cartage loads: crew edit drafts, office edit" on cartage_loads for update
  to authenticated
  using (user_can_manage_job(job_id::text) and (status = 'draft' or (select is_office_or_admin(auth.uid()))))
  with check (user_can_manage_job(job_id::text));
create policy "cartage loads: crew and office delete drafts" on cartage_loads for delete
  to authenticated
  using (user_can_manage_job(job_id::text) and status = 'draft');

alter table cartage_load_costs enable row level security;
create policy "cartage load costs: office/admin manage" on cartage_load_costs for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- 7. Grants (0088: this project does not expose new tables by itself).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on cartage_loads, cartage_load_costs to authenticated;
grant all on cartage_loads, cartage_load_costs to service_role;
revoke all on cartage_loads, cartage_load_costs from anon;

-- ---------------------------------------------------------------------------
-- 8. Assert the end state.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['cartage_loads', 'cartage_load_costs'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0111: RLS is off on %', t;
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception '0111: authenticated cannot read %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '0111: anon can read %', t;
    end if;
  end loop;

  -- The cost table: office/admin only.
  select count(*) into n from pg_policy
   where polrelid = 'public.cartage_load_costs'::regclass
     and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '')) = 0;
  if n > 0 then raise exception '0111: cartage_load_costs has a policy that is not office/admin only'; end if;
  select count(*) into n from pg_policy where polrelid = 'public.cartage_load_costs'::regclass;
  if n <> 1 then raise exception '0111: expected 1 policy on cartage_load_costs, found %', n; end if;

  -- The crew-readable table carries no money-named column (money_boundary_sweep.sql's regex).
  select count(*) into n from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'cartage_loads'
     and c.column_name ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                        || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                        || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
     and c.column_name !~* '(_id$|^id$)';
  if n > 0 then raise exception '0111: cartage_loads has a money-named column'; end if;

  -- Every crew policy is scoped to the job.
  select count(*) into n from pg_policy
   where polrelid = 'public.cartage_loads'::regclass
     and position('user_can_manage_job' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then raise exception '0111: a cartage_loads policy is not scoped to the job''s crew'; end if;
  select count(*) into n from pg_policy where polrelid = 'public.cartage_loads'::regclass;
  if n <> 4 then raise exception '0111: expected 4 policies on cartage_loads, found %', n; end if;

  -- The lock triggers are on.
  foreach t in array array['cartage_loads', 'cartage_load_costs'] loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = t || '_guard' and not tgisinternal) then
      raise exception '0111: % guard trigger missing', t;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_quarry_included_guard' and not tgisinternal) then
    raise exception '0111: jobs_quarry_included_guard trigger missing';
  end if;

  -- Exactly the two hire_unit checks, and they take the new units.
  select count(*) into n from pg_constraint
   where conrelid = 'public.equipment_hire_options'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%hire_unit%';
  if n <> 2 then raise exception '0111: expected 2 hire_unit checks on equipment_hire_options, found %', n; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.equipment_hire_options'::regclass
                  and conname = 'equipment_hire_options_unit_fits_type'
                  and pg_get_constraintdef(oid) like '%tonne%' and pg_get_constraintdef(oid) like '%m3%') then
    raise exception '0111: equipment_hire_options does not accept tonne / m3';
  end if;

  -- Docket photos land where technicians cannot read them.
  if not storage_object_is_money_document('00000000-0000-0000-0000-000000000000/expense-receipt-cartage-00000000-0000-0000-0000-000000000000-1.jpg') then
    raise exception '0111: the docket photo path is not classified as a money document';
  end if;
end $$;

notify pgrst, 'reload schema';
