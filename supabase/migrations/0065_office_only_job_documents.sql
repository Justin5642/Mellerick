-- =============================================
-- OFFICE-ONLY JOB DOCUMENTS (+ mobile expense-receipt path fix)
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-08, via SQL editor).
--
-- WHY
-- job_documents (incl. ~3.9k files imported from Simpro) is readable by every
-- signed-in user, so a technician can open any purchase order, supplier
-- invoice or quote that was attached to a job. Technicians should only see
-- attachments with no dollar figures.
--
-- WHAT
-- 1. job_documents.office_only (default false). Set by office/admin, or in
--    bulk by scripts/audit-job-documents.mjs after it classifies each file.
-- 2. RLS on job_documents: a technician no longer sees (or edits/deletes)
--    office-only rows; office/admin see everything. Everyone can still add
--    ordinary documents — the technician Documents tab keeps working.
-- 3. storage_object_is_money_document() (0047), which gates every storage
--    policy on the job-documents bucket, now ALSO returns true for:
--      - any object whose job_documents row is office_only, so hiding the
--        row hides the FILE too (signed URLs, list, download);
--      - '<jobId>/expense-<id>.<ext>' — the path the MOBILE app writes
--        expense receipts to (mobile/lib/data/repositories/jobBilling.ts).
--        0047 only matched the web path 'expense-receipt-', so mobile
--        receipts were readable by technicians. Only office/admin can add
--        expenses on mobile (job/[id]/billing is office-guarded), so no
--        technician upload is newly refused.
--    The function becomes SECURITY DEFINER + STABLE: it must see office_only
--    rows that the caller's own RLS now hides, or the check would pass for
--    exactly the rows it exists to block.
--
-- Policies are dropped by ENUMERATING pg_policy (see 0042) and the end state
-- is asserted. Idempotent.
-- =============================================

alter table job_documents add column if not exists office_only boolean not null default false;
create index if not exists job_documents_storage_path_idx on job_documents (storage_path);

-- ---------------------------------------------------------------------------
-- job_documents row-level security
-- ---------------------------------------------------------------------------
alter table job_documents enable row level security;

do $$
declare
  pol record;
begin
  for pol in
    select polname from pg_policy where polrelid = 'public.job_documents'::regclass
  loop
    execute format('drop policy %I on public.job_documents', pol.polname);
  end loop;
end $$;

-- One policy per command with the whole condition inside: permissive policies
-- OR together, so a separate "office can see all" policy would be fine, but a
-- separate "everyone can see non-office-only" one must never be widened.
create policy "Job documents readable; office-only ones office/admin" on job_documents for select
  using (auth.role() = 'authenticated' and (not office_only or is_office_or_admin(auth.uid())));

create policy "Job documents insertable; office-only ones office/admin" on job_documents for insert
  with check (auth.role() = 'authenticated' and (not office_only or is_office_or_admin(auth.uid())));

create policy "Job documents updatable; office-only ones office/admin" on job_documents for update
  using (auth.role() = 'authenticated' and (not office_only or is_office_or_admin(auth.uid())))
  with check (auth.role() = 'authenticated' and (not office_only or is_office_or_admin(auth.uid())));

create policy "Job documents deletable; office-only ones office/admin" on job_documents for delete
  using (auth.role() = 'authenticated' and (not office_only or is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- Storage: widen the money-document test (policies from 0047 call it by name)
-- ---------------------------------------------------------------------------
create or replace function storage_object_is_money_document(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select object_name like '%/expense-receipt-%'
      or object_name like '%/expense-%'
      or object_name like '%/variations/%'
      or exists (
        select 1 from job_documents d
         where d.storage_path = object_name and d.office_only
      );
$$;

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
do $$
declare
  n_permissive int;
  n_restrictive int;
  bad text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.job_documents'::regclass) then
    raise exception 'job_documents: row level security is OFF after migration 0065';
  end if;

  select count(*) filter (where polpermissive), count(*) filter (where not polpermissive)
    into n_permissive, n_restrictive
    from pg_policy where polrelid = 'public.job_documents'::regclass;
  if n_permissive <> 4 or n_restrictive <> 0 then
    raise exception 'job_documents: expected 4 permissive / 0 restrictive policies after 0065, found % / %',
      n_permissive, n_restrictive;
  end if;

  -- Every policy must carry the office_only gate in each clause it has.
  select string_agg(polname, ', ') into bad
    from pg_policy
   where polrelid = 'public.job_documents'::regclass
     and (
       (polqual is not null and position('office_only' in pg_get_expr(polqual, polrelid)) = 0)
       or (polwithcheck is not null and position('office_only' in pg_get_expr(polwithcheck, polrelid)) = 0)
     );
  if bad is not null then
    raise exception 'job_documents: policies missing the office_only gate: %', bad;
  end if;

  -- The storage test must recognise every money path, including mobile receipts.
  if not storage_object_is_money_document('j1/expense-receipt-1_a.pdf')
     or not storage_object_is_money_document('j1/expense-abc.jpg')
     or not storage_object_is_money_document('j1/variations/1_q.pdf')
     or storage_object_is_money_document('j1/1700000000_plans.pdf') then
    raise exception 'storage_object_is_money_document: path classification is wrong after 0065';
  end if;
end $$;
