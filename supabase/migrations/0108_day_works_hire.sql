-- ============================================================================
-- Day Works / Hire, Stage 1: hire setup on the fleet register, attachments,
-- and one signed Day Works line per machine per day on a job.
--
-- STATUS: DRAFT — NOT YET APPLIED. Paste into the Supabase SQL editor, then run
-- supabase/tests/0108_day_works_hire_test.sql; trust only its final
-- "0108 PASSED" row. Then change this line to applied.
--
-- WHY (Justin, Nov 2026): plant hire and cartage are charged to the builder
-- as Day Works, always on their own line under the job and never inside the
-- quoted value or a progress claim. The builder's rep signs each day's entry
-- on a phone or tablet, the entry then locks, and signed entries are invoiced
-- weekly or monthly. Operator labour is a separate cost, not in the hire rate.
--
-- WHAT IT ADDS
--   cost_centres            + Truck Cartage, Plant Wet Hire, Plant Dry Hire,
--                             Float Moves (only when missing, by name).
--   equipment_hire_options  how a machine is hired out and at what rate, ex
--                           GST. One row per (machine, hire type, unit), so
--                           the Cat 962H can be wet by the hour AND dry by the
--                           day. Types/units:
--                             wet      hour
--                             dry      day | engine_hour (meter close − open)
--                             cartage  hour | km | contract
--                             float    move (base covering float_km_included
--                                      km, then float_per_km, loaded leg only)
--                           cost_centre_id: the company cost centre the line
--                           belongs to; null = the default for the hire type.
--                           OFFICE/ADMIN ONLY — it carries rates.
--   hire_attachments        trencher etc., charged a full day when on a
--                           machine. OFFICE/ADMIN ONLY — it carries rates.
--   hire_entries            one Day Works line per machine per day on a job
--                           (floats may do several moves a day). Quantities
--                           only — NO money column, so the crew can read and
--                           write it. draft → signed → invoiced, or void.
--   hire_entry_attachments  which attachments were on the machine that day.
--
-- THE MONEY RULE (HANDOVER §2): technicians read hire_entries and
-- hire_entry_attachments for jobs they are on (user_can_manage_job, 0059) and
-- nothing else here. Rates live only in the two office-only tables; amounts
-- are computed office-side (lib/hire-pricing.ts on office routes). No column
-- on the technician-readable tables matches money_boundary_sweep.sql's money
-- regex. Not added to any PowerSync stream.
--
-- THE LOCK: hire_entries_guard() refuses any change to the quantities,
-- description, machine, date or sign-off once an entry is signed. Only
-- office/admin move signed → invoiced (with an invoice on the same job) or
-- void it. Deleting the invoice puts its entries back to signed. The cost
-- centre comes from the machine's hire setup; the crew never choose it.
--
-- New tables are granted explicitly (0088) and dropped/created policies are
-- on tables this migration creates, so nothing is guessed by name (§4). The
-- end state is asserted at the bottom.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The four hire cost centres.
-- ---------------------------------------------------------------------------
insert into cost_centres (name, sort_order)
select v.name, v.sort_order
from (values
  ('Truck Cartage', 20),
  ('Plant Wet Hire', 21),
  ('Plant Dry Hire', 22),
  ('Float Moves', 23)
) as v(name, sort_order)
where not exists (select 1 from cost_centres c where lower(btrim(c.name)) = lower(v.name));

-- ---------------------------------------------------------------------------
-- 2. Hire setup per machine (office/admin only).
-- ---------------------------------------------------------------------------
create table if not exists equipment_hire_options (
  id uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references equipment(id) on delete cascade,
  hire_type text not null check (hire_type in ('wet', 'dry', 'cartage', 'float')),
  hire_unit text not null check (hire_unit in ('hour', 'day', 'engine_hour', 'km', 'contract', 'move')),
  rate numeric(10,2) not null default 0 check (rate >= 0),
  fuel_included boolean not null default false,
  whole_days_only boolean not null default false,
  float_base numeric(10,2) not null default 0 check (float_base >= 0),
  float_km_included numeric(8,1) not null default 0 check (float_km_included >= 0),
  float_per_km numeric(10,2) not null default 0 check (float_per_km >= 0),
  cost_centre_id uuid references cost_centres(id) on delete set null,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint equipment_hire_options_unit_fits_type check (
       (hire_type = 'wet' and hire_unit = 'hour')
    or (hire_type = 'dry' and hire_unit in ('day', 'engine_hour'))
    or (hire_type = 'cartage' and hire_unit in ('hour', 'km', 'contract'))
    or (hire_type = 'float' and hire_unit = 'move')
  ),
  constraint equipment_hire_options_one_per_unit unique (equipment_id, hire_type, hire_unit)
);
create index if not exists equipment_hire_options_equipment_id_idx on equipment_hire_options(equipment_id);

drop trigger if exists equipment_hire_options_updated_at on equipment_hire_options;
create trigger equipment_hire_options_updated_at before update on equipment_hire_options
  for each row execute function update_updated_at();

-- Re-runnable: clear any policies on this migration's own tables by
-- enumeration before (re)creating them (HANDOVER §4 — never by guessed name).
do $$
declare p record;
begin
  for p in
    select polname, polrelid::regclass::text as tbl from pg_policy
     where polrelid in (select oid from pg_class
                         where relnamespace = 'public'::regnamespace
                           and relname in ('equipment_hire_options', 'hire_attachments', 'hire_entries', 'hire_entry_attachments'))
  loop
    execute format('drop policy %I on %s', p.polname, p.tbl);
  end loop;
end $$;

alter table equipment_hire_options enable row level security;
create policy "hire options: office/admin manage" on equipment_hire_options for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

comment on table equipment_hire_options is
  'How a fleet item is hired out as Day Works, ex GST (0108). One row per machine, hire type and unit. Office/admin only: it carries rates.';
comment on column equipment_hire_options.cost_centre_id is
  'Company cost centre for this hire (0108). Null = the default for the hire type: wet → Plant Wet Hire, dry → Plant Dry Hire, cartage → Truck Cartage, float → Float Moves.';
comment on column equipment_hire_options.whole_days_only is
  'Dry day hire charged in whole days only (the roller: no half days). Part days round up.';

-- ---------------------------------------------------------------------------
-- 3. Attachments (office/admin only).
-- ---------------------------------------------------------------------------
create table if not exists hire_attachments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  day_rate numeric(10,2) not null default 0 check (day_rate >= 0),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists hire_attachments_name_key on hire_attachments (lower(btrim(name)));

drop trigger if exists hire_attachments_updated_at on hire_attachments;
create trigger hire_attachments_updated_at before update on hire_attachments
  for each row execute function update_updated_at();

alter table hire_attachments enable row level security;
create policy "hire attachments: office/admin manage" on hire_attachments for all
  to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

comment on table hire_attachments is
  'Machine attachments hired out as Day Works (0108), charged day_rate (ex GST) for each day they are on a machine. Office/admin only: it carries rates.';

-- ---------------------------------------------------------------------------
-- 4. Day Works entries (quantities only — readable by the job's crew).
-- ---------------------------------------------------------------------------
create table if not exists hire_entries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id) on delete cascade,
  equipment_id uuid not null references equipment(id) on delete restrict,
  hire_type text not null check (hire_type in ('wet', 'dry', 'cartage', 'float')),
  hire_unit text not null check (hire_unit in ('hour', 'day', 'engine_hour', 'km', 'contract', 'move')),
  work_date date not null,
  hours numeric(6,2) check (hours is null or (hours >= 0 and hours <= 24)),
  days numeric(5,2) check (days is null or days >= 0),
  meter_open numeric(10,1) check (meter_open is null or meter_open >= 0),
  meter_close numeric(10,1) check (meter_close is null or meter_close >= 0),
  km numeric(8,1) check (km is null or km >= 0),
  pickup text,
  dropoff text,
  description text,
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
  constraint hire_entries_meter_forwards check (meter_open is null or meter_close is null or meter_close >= meter_open),
  constraint hire_entries_invoiced_has_invoice check ((status = 'invoiced') = (invoice_id is not null))
);
create index if not exists hire_entries_job_id_idx on hire_entries(job_id, work_date);
create index if not exists hire_entries_equipment_date_idx on hire_entries(equipment_id, work_date);
create index if not exists hire_entries_invoice_id_idx on hire_entries(invoice_id);
-- One line per machine per day on a job. Floats are exempt: one float can make
-- several moves for the same job in a day, each with its own base charge.
create unique index if not exists hire_entries_one_per_machine_day
  on hire_entries (job_id, equipment_id, work_date)
  where status <> 'void' and hire_type <> 'float';

create table if not exists hire_entry_attachments (
  entry_id uuid not null references hire_entries(id) on delete cascade,
  attachment_id uuid not null references hire_attachments(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (entry_id, attachment_id)
);
create index if not exists hire_entry_attachments_attachment_idx on hire_entry_attachments(attachment_id);

comment on table hire_entries is
  'Day Works / Hire (0108): one line per machine per day on a job, quantities only — rates and amounts are office-side. Signed by the builder''s rep, then locked; invoiced separately from quoted progress claims.';
comment on table hire_entry_attachments is
  'Attachments on the machine for a Day Works entry (0108). Each is charged a full day at hire_attachments.day_rate.';

-- The cost centre for a machine's hire option. SECURITY DEFINER because the
-- crew cannot read equipment_hire_options (it carries rates); this returns
-- only the cost centre id, and raises when the machine is not set up for that
-- kind of hire.
create or replace function hire_entry_cost_centre(p_equipment uuid, p_type text, p_unit text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  found_option boolean;
  centre uuid;
begin
  select true, o.cost_centre_id into found_option, centre
    from equipment_hire_options o
   where o.equipment_id = p_equipment and o.hire_type = p_type and o.hire_unit = p_unit and o.is_active;
  if not coalesce(found_option, false) then
    raise exception 'That machine is not set up for this kind of hire. Ask the office to add it in Fleet → Hire setup.'
      using errcode = 'check_violation';
  end if;
  if centre is null then
    select c.id into centre from cost_centres c
     where lower(btrim(c.name)) = case p_type
       when 'wet' then 'plant wet hire'
       when 'dry' then 'plant dry hire'
       when 'cartage' then 'truck cartage'
       when 'float' then 'float moves'
     end
     limit 1;
  end if;
  return centre;
end;
$$;
revoke all on function hire_entry_cost_centre(uuid, text, text) from public, anon;
grant execute on function hire_entry_cost_centre(uuid, text, text) to authenticated, service_role;

-- The lock and the status rules. Runs as the caller (not SECURITY DEFINER), so
-- current_user tells a signed-in app user (authenticated) from the service
-- role, the SQL editor, or a cascade from deleting an invoice (table owner).
create or replace function hire_entries_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  privileged boolean := (select is_office_or_admin(auth.uid())) or current_user not in ('authenticated', 'anon');
  derived uuid;
  qty_ok boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A Day Works entry starts as a draft and is signed off afterwards.' using errcode = 'check_violation';
    end if;
    new.signer_name := null;
    new.signature_path := null;
    new.signed_at := null;
    new.signed_by := null;
    new.invoice_id := null;
    if not privileged or new.created_by is null then
      new.created_by := auth.uid();
    end if;
    derived := hire_entry_cost_centre(new.equipment_id, new.hire_type, new.hire_unit);
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
      raise exception 'Sign this Day Works entry off before invoicing it.' using errcode = 'check_violation';
    end if;
    if new.status = 'void' and not privileged then
      raise exception 'Only the office can void a Day Works entry. Delete the draft instead.' using errcode = 'insufficient_privilege';
    end if;
    if (new.equipment_id, new.hire_type, new.hire_unit) is distinct from (old.equipment_id, old.hire_type, old.hire_unit)
       or (not privileged and new.cost_centre_id is distinct from old.cost_centre_id) then
      derived := hire_entry_cost_centre(new.equipment_id, new.hire_type, new.hire_unit);
      if not privileged or new.cost_centre_id is not distinct from old.cost_centre_id then
        new.cost_centre_id := derived;
      end if;
    end if;
    if not privileged then
      new.created_by := old.created_by;
    end if;
    if new.status = 'signed' then
      if length(btrim(coalesce(new.signer_name, ''))) = 0 then
        raise exception 'Enter the name of the builder''s representative signing.' using errcode = 'check_violation';
      end if;
      if length(btrim(coalesce(new.signature_path, ''))) = 0 then
        raise exception 'The signature is missing. Ask them to sign again.' using errcode = 'check_violation';
      end if;
      -- (A CASE straight inside IF would end at its first THEN, hence the variable.)
      qty_ok := case new.hire_unit
        when 'hour' then coalesce(new.hours, 0) > 0
        when 'day' then coalesce(new.days, 0) > 0
        when 'engine_hour' then new.meter_open is not null and new.meter_close is not null and new.meter_close > new.meter_open
        when 'km' then coalesce(new.km, 0) > 0
        when 'move' then new.km is not null
        else true
      end;
      if not qty_ok then
        raise exception 'Enter the quantity for this hire before it is signed.' using errcode = 'check_violation';
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
      raise exception 'Sign this Day Works entry off before invoicing it.' using errcode = 'check_violation';
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- Signed, invoiced or void: locked.
  if not privileged then
    raise exception 'This Day Works entry is signed and locked. Ask the office if it needs changing.' using errcode = 'insufficient_privilege';
  end if;
  if (new.job_id, new.equipment_id, new.hire_type, new.hire_unit, new.work_date, new.hours, new.days,
      new.meter_open, new.meter_close, new.km, new.pickup, new.dropoff, new.description,
      new.signer_name, new.signature_path, new.signed_at, new.signed_by, new.created_by)
     is distinct from
     (old.job_id, old.equipment_id, old.hire_type, old.hire_unit, old.work_date, old.hours, old.days,
      old.meter_open, old.meter_close, old.km, old.pickup, old.dropoff, old.description,
      old.signer_name, old.signature_path, old.signed_at, old.signed_by, old.created_by) then
    raise exception 'This Day Works entry is signed and locked: its machine, date, quantities and description cannot change. Void it and enter a new one.'
      using errcode = 'check_violation';
  end if;

  if old.status = 'void' and new.status <> 'void' then
    raise exception 'A voided Day Works entry stays void. Enter a new one.' using errcode = 'check_violation';
  end if;
  if new.status = 'draft' then
    raise exception 'A signed Day Works entry cannot go back to draft.' using errcode = 'check_violation';
  end if;
  if old.status = 'invoiced' and new.status = 'void' then
    raise exception 'Take this entry off its invoice before voiding it.' using errcode = 'check_violation';
  end if;
  if new.status = 'invoiced' then
    if new.invoice_id is null then
      raise exception 'Choose the invoice this Day Works entry is on.' using errcode = 'check_violation';
    end if;
    if old.status = 'invoiced' and new.invoice_id is distinct from old.invoice_id then
      raise exception 'This Day Works entry is already on an invoice.' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from invoices i where i.id = new.invoice_id and i.job_id = new.job_id) then
      raise exception 'A Day Works entry can only go on an invoice for its own job.' using errcode = 'check_violation';
    end if;
  else
    new.invoice_id := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists hire_entries_guard on hire_entries;
create trigger hire_entries_guard before insert or update on hire_entries
  for each row execute function hire_entries_guard();

-- Attachments change only while the entry is a draft (a job being deleted
-- cascades through; the entry is already gone then).
create or replace function hire_entry_attachments_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  entry_status text;
  target uuid := case when tg_op = 'DELETE' then old.entry_id else new.entry_id end;
begin
  select e.status into entry_status from hire_entries e where e.id = target;
  if entry_status is not null and entry_status <> 'draft' and current_user in ('authenticated', 'anon') then
    raise exception 'This Day Works entry is signed and locked: its attachments cannot change.' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and old.entry_id is distinct from new.entry_id then
    raise exception 'Remove the attachment and add it again instead.' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists hire_entry_attachments_guard on hire_entry_attachments;
create trigger hire_entry_attachments_guard before insert or update or delete on hire_entry_attachments
  for each row execute function hire_entry_attachments_guard();

alter table hire_entries enable row level security;
create policy "hire entries: crew and office read" on hire_entries for select
  to authenticated
  using (user_can_manage_job(job_id::text));
create policy "hire entries: crew and office add" on hire_entries for insert
  to authenticated
  with check (user_can_manage_job(job_id::text));
create policy "hire entries: crew edit drafts, office edit" on hire_entries for update
  to authenticated
  using (user_can_manage_job(job_id::text) and (status = 'draft' or (select is_office_or_admin(auth.uid()))))
  with check (user_can_manage_job(job_id::text));
create policy "hire entries: crew and office delete drafts" on hire_entries for delete
  to authenticated
  using (user_can_manage_job(job_id::text) and status = 'draft');

alter table hire_entry_attachments enable row level security;
create policy "hire entry attachments: read with the entry" on hire_entry_attachments for select
  to authenticated
  using (exists (select 1 from hire_entries e where e.id = entry_id));
create policy "hire entry attachments: add to a draft" on hire_entry_attachments for insert
  to authenticated
  with check (exists (select 1 from hire_entries e
                      where e.id = entry_id and e.status = 'draft' and user_can_manage_job(e.job_id::text)));
create policy "hire entry attachments: remove from a draft" on hire_entry_attachments for delete
  to authenticated
  using (exists (select 1 from hire_entries e
                 where e.id = entry_id and e.status = 'draft' and user_can_manage_job(e.job_id::text)));

-- ---------------------------------------------------------------------------
-- 5. Grants (0088: this project does not expose new tables by itself).
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on equipment_hire_options, hire_attachments, hire_entries to authenticated;
grant select, insert, delete on hire_entry_attachments to authenticated;
grant all on equipment_hire_options, hire_attachments, hire_entries, hire_entry_attachments to service_role;
revoke all on equipment_hire_options, hire_attachments, hire_entries, hire_entry_attachments from anon;

-- ---------------------------------------------------------------------------
-- 6. Seed: Justin's rates (Nov 2026), ex GST, matched to machines by name.
--    A machine whose name doesn't match is left for the office to set up.
--    Never overwrites an option the office has already entered.
-- ---------------------------------------------------------------------------
insert into equipment_hire_options
  (equipment_id, hire_type, hire_unit, rate, fuel_included, whole_days_only,
   float_base, float_km_included, float_per_km, cost_centre_id, notes)
select e.id, v.hire_type, v.hire_unit, v.rate, v.fuel_included, v.whole_days_only,
       v.float_base, v.float_km_included, v.float_per_km,
       (select c.id from cost_centres c where lower(btrim(c.name)) = v.centre limit 1),
       v.notes
from (values
  ('pc ?-?88(?![0-9])',              'wet', 'hour',        146.00, true,  false,   0, 0, 0, 'plant wet hire', 'PC88 wet hire (Justin, Nov 2026).'),
  ('pc ?-?18(?![0-9])',              'dry', 'day',         250.00, true,  false,   0, 0, 0, 'plant dry hire', 'PC18 dry hire, fuel included (Justin, Nov 2026).'),
  ('pc ?-?35(?![0-9])',              'dry', 'day',         300.00, true,  false,   0, 0, 0, 'plant dry hire', 'PC35 dry hire, fuel included (Justin, Nov 2026).'),
  ('(svl ?-?75|bobcat)',             'wet', 'hour',        115.00, true,  false,   0, 0, 0, 'plant wet hire', 'Kubota SVL75 (Bobcat) wet hire (Justin, Nov 2026).'),
  ('700 ?-?l(?![a-z0-9])',           'wet', 'hour',        200.00, true,  false,   0, 0, 0, 'plant wet hire', 'John Deere 700L dozer wet hire (Justin, Nov 2026). Standby rate still to be set.'),
  ('962 ?-?h(?![a-z0-9])',           'wet', 'hour',        200.00, true,  false,   0, 0, 0, 'plant wet hire', 'Cat 962H wet hire (Justin, Nov 2026).'),
  ('962 ?-?h(?![a-z0-9])',           'dry', 'day',         800.00, false, false,   0, 0, 0, 'plant dry hire', 'Cat 962H truly dry: hirer supplies fuel, no operator (Justin, Nov 2026).'),
  ('roller',                         'dry', 'day',         400.00, true,  true,    0, 0, 0, 'plant dry hire', 'Roller dry hire, fuel included, full days only (Justin, Nov 2026).'),
  ('(warrior|screener)',             'dry', 'engine_hour', 140.00, false, false,   0, 0, 0, 'plant dry hire', 'Warrior 1400 screener, per engine hour from meter readings (Justin, Nov 2026). Fuel not stated.'),
  ('(quad.*float|float.*quad)',      'float', 'move',        0.00, false, false, 470, 30, 5, 'float moves',    'Quad axle float: $470 covers the first 30 km, then $5/km, loaded leg only (Justin, Nov 2026).'),
  ('(twin ?-?steer.*float|float.*twin ?-?steer)', 'float', 'move', 0.00, false, false, 375, 30, 5, 'float moves', 'Twin steer float: $375 base; 30 km and $5/km ASSUMED to match the quad axle — confirm.')
) as v(pattern, hire_type, hire_unit, rate, fuel_included, whole_days_only, float_base, float_km_included, float_per_km, centre, notes)
join equipment e on e.name ~* v.pattern and e.category <> 'tool'
on conflict (equipment_id, hire_type, hire_unit) do nothing;

insert into hire_attachments (name, day_rate, notes)
select 'Trencher', 200.00, 'Trencher attachment, full day when on the machine (Justin, Nov 2026).'
where not exists (select 1 from hire_attachments a where lower(btrim(a.name)) = 'trencher');

-- ---------------------------------------------------------------------------
-- 7. Assert the end state.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['equipment_hire_options', 'hire_attachments', 'hire_entries', 'hire_entry_attachments'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0108: RLS is off on %', t;
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception '0108: authenticated cannot read %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '0108: anon can read %', t;
    end if;
  end loop;

  -- The two rate tables: office/admin only.
  foreach t in array array['equipment_hire_options', 'hire_attachments'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass
       and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '')) = 0;
    if n > 0 then raise exception '0108: % has a policy that is not office/admin only', t; end if;
  end loop;

  -- The crew-readable tables carry no money-named column (money_boundary_sweep.sql's regex).
  select count(*) into n from information_schema.columns c
   where c.table_schema = 'public' and c.table_name in ('hire_entries', 'hire_entry_attachments')
     and c.column_name ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                        || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                        || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
     and c.column_name !~* '(_id$|^id$)';
  if n > 0 then raise exception '0108: a crew-readable Day Works table has a money-named column'; end if;

  -- The crew tables: every policy is scoped to the job (directly or through its entry).
  select count(*) into n from pg_policy
   where polrelid = 'public.hire_entries'::regclass
     and position('user_can_manage_job' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then raise exception '0108: a hire_entries policy is not scoped to the job''s crew'; end if;
  select count(*) into n from pg_policy
   where polrelid = 'public.hire_entry_attachments'::regclass
     and position('hire_entries' in coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if n > 0 then raise exception '0108: a hire_entry_attachments policy is not scoped through its entry'; end if;

  -- The four hire cost centres exist.
  select count(*) into n from cost_centres
   where lower(btrim(name)) in ('truck cartage', 'plant wet hire', 'plant dry hire', 'float moves');
  if n <> 4 then raise exception '0108: expected the 4 hire cost centres, found %', n; end if;

  -- The lock trigger is on.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.hire_entries'::regclass and tgname = 'hire_entries_guard' and not tgisinternal) then
    raise exception '0108: hire_entries_guard trigger missing';
  end if;
end $$;

notify pgrst, 'reload schema';
