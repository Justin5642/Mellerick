-- ============================================================================
-- Komtrax (Komatsu machine data, ISO 15143-3 / AEMP 2.0) mirrored into Fleet.
--
-- STATUS: DRAFT — NOT YET APPLIED. Apply (SQL editor), then paste
-- supabase/tests/0113_komtrax_test.sql and trust only a final "0113 PASSED"
-- row. Then mark this header applied and add the ledger row:
--   insert into supabase_migrations.schema_migrations (version,name)
--   values ('0113','komtrax') on conflict do nothing;
-- Safe to merge the app before this is applied: the sync route answers
-- {skipped:true} and every reader treats a missing table as "no Komtrax data".
--
-- WHY (Justin, 20 Nov 2026): Komatsu's Komtrax already knows each machine's
-- engine hours (SMR), where it is, fuel used and its fault codes. Read them
-- automatically so service-due runs off real hours, Day Works engine-hour
-- lines prefill their meter readings, and faults reach the office.
--
--   komtrax_machines       one row per Komatsu machine (make/model/serial)
--                          with its latest snapshot: hours, location, fuel,
--                          DEF/fuel remaining %, idle hours. equipment_id links
--                          it to the fleet register (auto by serial, or the
--                          office links it in Fleet → Komtrax machines).
--   komtrax_hour_readings  the hour-meter time series (one row per reading).
--   komtrax_faults         fault codes as Komtrax reported them.
--   komtrax_sync_state     one row: last run, counts, last-call time per URL
--                          (Komatsu refuses a URL asked twice in 15 minutes),
--                          and the last error (server-side only — no column
--                          grant to signed-in users).
--
-- NO MONEY: none of these tables has a money column (the money sweep's regex
-- is asserted below). Office/admin read by RLS; only the service role (the
-- sync, after its cron/admin guard) writes — except that office/admin may
-- set a machine's equipment link (equipment_id, matched_by) and nothing else.
-- In NO PowerSync stream (sync-streams.yaml untouched): the phone reads these
-- through office routes, online. Granted explicitly (the 0088 lesson).
-- ============================================================================

create table if not exists komtrax_machines (
  id uuid primary key default gen_random_uuid(),
  make_code text not null,
  model text not null,
  serial text not null,
  oem_name text,
  -- Komtrax's own EquipmentID (the owner's label in Komtrax), not our equipment.id.
  komtrax_label text,
  equipment_id uuid references equipment(id) on delete set null,
  -- 'auto' = matched by serial on sync; 'office' = set (or cleared) by the
  -- office, which the sync never overrides. Null = never decided.
  matched_by text check (matched_by in ('auto', 'office')),
  hours numeric(10,2),
  hours_at timestamptz,
  lat double precision,
  lng double precision,
  location_at timestamptz,
  fuel_used_cumulative numeric(12,2),
  fuel_used_last24 numeric(10,2),
  fuel_units text,
  fuel_used_at timestamptz,
  fuel_remaining_pct numeric(5,1),
  def_remaining_pct numeric(5,1),
  idle_hours numeric(10,2),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint komtrax_machines_make_model_serial_key unique (make_code, model, serial)
);

-- One Komtrax machine per fleet item.
create unique index if not exists komtrax_machines_equipment_key on komtrax_machines (equipment_id) where equipment_id is not null;

create table if not exists komtrax_hour_readings (
  machine_id uuid not null references komtrax_machines(id) on delete cascade,
  read_at timestamptz not null,
  hours numeric(10,2) not null check (hours >= 0),
  primary key (machine_id, read_at)
);

create table if not exists komtrax_faults (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references komtrax_machines(id) on delete cascade,
  code text not null,
  severity text,
  description text,
  source text,
  occurred_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  constraint komtrax_faults_machine_code_time_key unique (machine_id, code, occurred_at)
);

create index if not exists komtrax_faults_occurred_idx on komtrax_faults (occurred_at desc);

create table if not exists komtrax_sync_state (
  id boolean primary key default true check (id),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_machines integer,
  last_requests integer,
  url_calls jsonb not null default '{}'::jsonb,
  last_error text
);

insert into komtrax_sync_state (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- RLS — re-runnable: clear this migration's tables' policies by enumeration.
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in
    select polname, polrelid::regclass::text as tbl from pg_policy
     where polrelid in (select oid from pg_class
                         where relnamespace = 'public'::regnamespace
                           and relname in ('komtrax_machines', 'komtrax_hour_readings', 'komtrax_faults', 'komtrax_sync_state'))
  loop
    execute format('drop policy %I on %s', p.polname, p.tbl);
  end loop;
end $$;

alter table komtrax_machines enable row level security;
alter table komtrax_hour_readings enable row level security;
alter table komtrax_faults enable row level security;
alter table komtrax_sync_state enable row level security;

create policy "komtrax machines: office/admin read" on komtrax_machines for select to authenticated
  using ((select is_office_or_admin(auth.uid())));
create policy "komtrax machines: office/admin link" on komtrax_machines for update to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));
create policy "komtrax hour readings: office/admin read" on komtrax_hour_readings for select to authenticated
  using ((select is_office_or_admin(auth.uid())));
create policy "komtrax faults: office/admin read" on komtrax_faults for select to authenticated
  using ((select is_office_or_admin(auth.uid())));
create policy "komtrax sync state: office/admin read" on komtrax_sync_state for select to authenticated
  using ((select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- Grants (0088). People read; the office may only change the equipment link;
-- the sync (service role) writes everything. last_error and url_calls are
-- never granted to signed-in users.
-- ---------------------------------------------------------------------------
revoke all on komtrax_machines, komtrax_hour_readings, komtrax_faults, komtrax_sync_state from anon;
revoke all on komtrax_machines, komtrax_hour_readings, komtrax_faults, komtrax_sync_state from authenticated;
grant select on komtrax_machines, komtrax_hour_readings, komtrax_faults to authenticated;
grant update (equipment_id, matched_by) on komtrax_machines to authenticated;
grant select (id, last_run_at, last_ok_at, last_machines, last_requests) on komtrax_sync_state to authenticated;
grant select, insert, update, delete on komtrax_machines, komtrax_hour_readings, komtrax_faults, komtrax_sync_state to service_role;

comment on table komtrax_machines is
  'Komatsu machines from Komtrax (ISO 15143-3) with their latest snapshot (0113). Written by lib/komtrax.ts; the office sets only the equipment link.';
comment on table komtrax_hour_readings is 'Komtrax hour-meter (SMR) readings (0113). Feeds service due and Day Works meter prefill.';
comment on table komtrax_faults is 'Komtrax fault codes (0113).';
comment on table komtrax_sync_state is 'Komtrax sync bookkeeping (0113). last_error and url_calls are server-side only.';

-- ---------------------------------------------------------------------------
-- Assert the end state.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['komtrax_machines', 'komtrax_hour_readings', 'komtrax_faults', 'komtrax_sync_state'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '0113: RLS is off on %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT') then
      raise exception '0113: anon can read %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_table_privilege('authenticated', 'public.' || t, 'DELETE') then
      raise exception '0113: signed-in users can insert or delete %', t;
    end if;
    -- Every policy gates on office/admin.
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass
       and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '')) = 0;
    if n > 0 then raise exception '0113: % has a policy that is not office/admin only', t; end if;
    -- No money-named column (money_boundary_sweep.sql's regex).
    select count(*) into n from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = t
       and c.column_name ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                          || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                          || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
       and c.column_name !~* '(_id$|^id$)';
    if n > 0 then raise exception '0113: % has a money-named column', t; end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.komtrax_machines', 'SELECT') then
    raise exception '0113: authenticated cannot read komtrax_machines (the 0088 trap)';
  end if;
  if not has_column_privilege('authenticated', 'public.komtrax_machines', 'equipment_id', 'UPDATE') then
    raise exception '0113: the office cannot link a Komtrax machine';
  end if;
  if has_column_privilege('authenticated', 'public.komtrax_machines', 'hours', 'UPDATE') then
    raise exception '0113: signed-in users can change Komtrax hours';
  end if;
  if has_column_privilege('authenticated', 'public.komtrax_sync_state', 'last_error', 'SELECT') then
    raise exception '0113: signed-in users can read the sync error text';
  end if;
  select count(*) into n from pg_policy where polrelid in (
    'public.komtrax_machines'::regclass, 'public.komtrax_hour_readings'::regclass,
    'public.komtrax_faults'::regclass, 'public.komtrax_sync_state'::regclass);
  if n <> 5 then raise exception '0113: expected 5 policies, found %', n; end if;
  -- Not replicated to devices.
  if exists (select 1 from pg_publication_tables where tablename like 'komtrax%') then
    raise exception '0113: a komtrax table is in a publication (PowerSync must not carry it)';
  end if;
end $$;
