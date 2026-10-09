-- =============================================
-- RESTRICT SITE EDIT / ARCHIVE / DELETE TO OFFICE + ADMIN
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-08, via SQL editor).
--
-- The baseline policy "Authenticated users can manage sites" (0000) let any
-- signed-in user — a technician holding the anon key included — update,
-- archive (0063) or delete any customer site straight through the API. The UI
-- only offers those actions to office/admin; this makes the database agree.
--
-- What each role keeps:
--   SELECT — every authenticated user. Technicians need site addresses for
--            their jobs, geofencing and backflow devices.
--   INSERT — every authenticated user. Technicians can open web job create/
--            edit (/dashboard/jobs is tech-visible) and its "Add site" dialog.
--   UPDATE / DELETE — office/admin only (is_office_or_admin from 0027).
--
-- Mobile technicians never write sites (the customer screens are office-only),
-- so no queued offline write is newly refused.
--
-- Drops policies by ENUMERATING pg_policy (never by guessed name — see 0042)
-- and asserts the end state. Idempotent and safe to re-run.
-- =============================================

alter table sites enable row level security;

do $$
declare
  pol record;
begin
  for pol in
    select polname from pg_policy where polrelid = 'public.sites'::regclass
  loop
    execute format('drop policy %I on public.sites', pol.polname);
  end loop;
end $$;

create policy "Authenticated users can read sites" on sites for select
  using (auth.role() = 'authenticated');

create policy "Authenticated users can add sites" on sites for insert
  with check (auth.role() = 'authenticated');

create policy "Office/admin can update sites" on sites for update
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

create policy "Office/admin can delete sites" on sites for delete
  using (is_office_or_admin(auth.uid()));

-- Post-condition: exactly these four permissive policies, and the two write
-- policies gated on is_office_or_admin exactly (not a superset like `... OR true`).
do $$
declare
  expected text := 'is_office_or_admin(auth.uid())';
  rls_on boolean;
  n_permissive int;
  n_restrictive int;
  r record;
begin
  select relrowsecurity into rls_on from pg_class where oid = 'public.sites'::regclass;
  if not rls_on then
    raise exception 'sites: row level security is OFF after migration 0064';
  end if;

  select count(*) filter (where polpermissive), count(*) filter (where not polpermissive)
    into n_permissive, n_restrictive
    from pg_policy where polrelid = 'public.sites'::regclass;
  if n_permissive <> 4 or n_restrictive <> 0 then
    raise exception 'sites: expected 4 permissive / 0 restrictive policies after 0064, found % / %',
      n_permissive, n_restrictive;
  end if;

  for r in
    select polname, polcmd,
           regexp_replace(coalesce(pg_get_expr(polqual, polrelid), ''), '\s+', '', 'g') as qual,
           regexp_replace(coalesce(pg_get_expr(polwithcheck, polrelid), ''), '\s+', '', 'g') as chk
      from pg_policy
     where polrelid = 'public.sites'::regclass and polcmd in ('w', 'd')
  loop
    if r.qual <> expected then
      raise exception 'sites: policy "%" USING is "%", expected "%"', r.polname, r.qual, expected;
    end if;
    if r.polcmd = 'w' and r.chk <> expected then
      raise exception 'sites: policy "%" WITH CHECK is "%", expected "%"', r.polname, r.chk, expected;
    end if;
  end loop;

  if (select count(*) from pg_policy
       where polrelid = 'public.sites'::regclass and polcmd in ('w', 'd')) <> 2 then
    raise exception 'sites: expected one UPDATE and one DELETE policy after 0064';
  end if;
end $$;
