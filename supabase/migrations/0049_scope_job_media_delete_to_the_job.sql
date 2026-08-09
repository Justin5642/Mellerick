-- ============================================================================
-- Any authenticated user can destroy any job's photos, customer signatures and
-- voice recordings. This closes that — and the three ways round it.
--
-- STATUS: DRAFT — NOT APPLIED. (tests/unit/migration-header-truth.test.ts fails
-- the build if this line is still here once it IS applied.)
--
-- ---------------------------------------------------------------------------
-- THE HOLE
-- ---------------------------------------------------------------------------
-- 0037 gave job-photos and job-audio a DELETE policy of exactly:
--
--     using (bucket_id = 'job-photos' and auth.role() = 'authenticated')
--
-- and said so at :38-45, choosing to mirror the existing INSERT/SELECT policies
-- rather than widen its own change. 0047 looked again, wrote the fix out in its
-- footer, and deliberately did not ship it — "its failure mode is technicians
-- silently losing the ability to delete their own photos, and that deserves its
-- own change with its own rollback". This is that change.
--
-- What is in these buckets is not holiday snaps. job-photos holds:
--
--     <jobId>/<epochMs>_<name>            site photos       job-photos.tsx:44
--     <jobId>/signature_<...>.png         CUSTOMER SIGN-OFF job-signature.tsx:106
--     <jobId>/variations/<rowUuid>.jpg    variation evidence
--                                         mobile .../repositories/variations.ts:39
--
-- and job-audio holds <jobId>/voice-report.m4a, the completion voice report
-- (mobile .../repositories/voiceReport.ts:33). There is no bucket versioning, so
-- a delete is final.
--
--   (Correcting a note that has been repeated in review: the WEB variations
--    uploader at components/job/job-variations.tsx:113 writes to job-documents,
--    NOT job-photos. The '<jobId>/variations/' keys that do exist inside
--    job-photos come from the MOBILE repository. This matters because 0047's
--    storage_object_is_money_document() classifies '%/variations/%' as a money
--    document; it is currently applied only to job-documents policies, and if
--    someone extends it to job-photos every mobile variation photo instantly
--    disappears from the technician who took it.)
--
-- ---------------------------------------------------------------------------
-- WHY THIS MIGRATION IS BIGGER THAN "A STORAGE POLICY"
-- ---------------------------------------------------------------------------
-- Scoping storage.objects on its own would have closed the ticket and fixed
-- almost nothing. Three routes go straight round it, and all three are one
-- PostgREST call with the anon key that ships inside the app:
--
--   1. THE METADATA ROW. job_photos is still governed by
--      `for all using (auth.role() = 'authenticated')` (0000_baseline.sql:165,
--      untouched in 49 migrations). `delete().eq('job_id', victim)` erases every
--      photo record for a given job. The file survives in the bucket with
--      nothing pointing at it, so from the business's point of view the sign-off
--      photo and the signature are gone — absent from every screen, every query
--      and every report. 0037:26-27 justified its weak storage policy on the
--      grounds that "both apps already authorize the *row* delete". At the
--      database level that is not true.
--
--   2. SELF-ASSIGNMENT. The policy below authorizes on jobs.assigned_to — and
--      jobs carries the same blanket policy (0000_baseline.sql:131). `for all`
--      with only a USING clause means Postgres reuses it as WITH CHECK, so every
--      authenticated user can UPDATE every job. Assign the victim job to
--      yourself, delete, assign it back: three calls, no UI. A predicate the
--      attacker can write is not a predicate.
--
--   3. THE CASCADE. job_photos.job_id is ON DELETE CASCADE, and jobs itself is
--      deletable by every authenticated user under that same blanket policy. One
--      `delete from jobs` takes the photo rows with it.
--
-- So this migration covers four surfaces. That is a wider blast radius than one
-- change ideally carries, and splitting it was considered and rejected, because
-- a split leaves a window in which the storage policy is decorative and the
-- ticket looks closed. Each section below is separately assertable and
-- separately revertible, and the revert for each is written at the bottom.
--
-- ---------------------------------------------------------------------------
-- MEASURED AGAINST PRODUCTION, 2026-08-10
-- (scripts/check-storage-path-scoping.mjs, read-only, counts only)
-- ---------------------------------------------------------------------------
-- The policy extracts the job with split_part(name, '/', 1), which is only
-- sound if every object key really does begin with a job id. Counted, not
-- assumed — 0047 earned its credibility by pasting real numbers into its own
-- header and this does the same:
--
--     job-photos objects                              9722
--       first segment IS a live jobs.id               9716   (99.9%)
--       uuid-shaped but no job row (orphans)             6
--       first segment not a uuid                         0
--       no '/' at all (bucket-root object)               0
--     job-audio objects                                  0
--
--     jobs                                             827
--       with assigned_to set                             5
--       with assigned_to NULL                          822
--
-- Three things follow, and the second is uncomfortable:
--
--   * split_part is safe here. There is no key in either bucket that it
--     mis-parses, and the 6 orphans simply stop matching, which is the correct
--     outcome — they belong to no job, so no technician has a claim on them.
--
--   * 9710 of the 9716 matched objects hang off jobs with NO assignee. Those
--     were imported from simPRO by scripts/sync-simpro-attachments.mjs:232,
--     which prefixes the Supabase jobs.id correctly but whose jobs were
--     inserted unassigned. After this migration no technician can delete them.
--     That is the historical bulk of the bucket, and it is a recorded decision
--     rather than a discovered surprise: office/admin retain full access, and no
--     technician can currently reach those jobs on mobile in the first place
--     (see the next section).
--
--   * job-audio is empty, so its half of this change cannot break a flow that
--     works today — the same argument 0047 used for equipment-documents. It is
--     also the half with no client deleter at all, which means the ONLY thing
--     0037's job-audio policy currently enables is the abuse. It should not be
--     deferred a second time.
--
-- ---------------------------------------------------------------------------
-- WHY assigned_to IS THE RIGHT PREDICATE
-- ---------------------------------------------------------------------------
-- Not invented here. It is the rule this codebase already applies twice:
--
--   lib/api/job-authz.ts:16-28  canManageJobBilling — office/admin, OR the
--                               job's assigned_to. Enforced by four API routes.
--   mobile/powersync/sync-streams.yaml:89  a technician's entire sync is
--                               `FROM jobs WHERE assigned_to = auth.user_id()`,
--                               and :96/:103/:110/:119 scope every child table
--                               through that same subquery.
--
-- The helper below is the third implementation of one rule. It is named so the
-- next person changing either of the others finds it.
--
-- ---------------------------------------------------------------------------
-- WHY A SECURITY DEFINER HELPER AND NOT A BARE exists()
-- ---------------------------------------------------------------------------
-- 0047's footer proposed the ownership test inline. An RLS policy body is
-- evaluated AS THE INVOKING USER, so a bare `select ... from jobs` inside it is
-- itself filtered by the RLS policies on public.jobs. Today that happens to
-- work, because jobs is wide open — meaning the correctness of a security
-- policy would rest on another table being INSECURE. Every migration in this
-- series has narrowed technician visibility (0027, 0028, 0035, 0038, 0045); the
-- day someone gives jobs the same treatment, this policy silently starts
-- denying technicians their own photos with no error anywhere to explain it.
--
-- So it goes in a SECURITY DEFINER function, as is_office_or_admin does
-- (0027:27). search_path pins pg_temp LAST — 0027 wrote `set search_path =
-- public`, which leaves pg_temp ahead of it and the function shadowable; the
-- hardened form names pg_temp explicitly at the end. EXECUTE is revoked from
-- public so the helper is not a job-ownership oracle for anon.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The rule, in one place.
--
--    Takes TEXT, not uuid, and compares j.id::text. The cast direction is
--    load-bearing and a reviewer will want to "optimise" it:
--
--        j.id = split_part(name,'/',1)::uuid     -- DO NOT
--
--    would let the jobs primary-key index be used, and would also raise
--    `invalid input syntax for type uuid` on an object whose first segment is
--    not a uuid — aborting the entire DELETE statement rather than filtering
--    that one row out. Since INSERT on these buckets stays open (below), that
--    turns into a self-service denial of service: upload one object with a
--    non-uuid prefix and photo deletion breaks for everybody. The text
--    comparison simply fails to match. Keep it.
--
--    (Performance is not the reason to prefer either form: jobs.assigned_to is
--    indexed (0029:26) and the table holds 827 rows.)
-- ---------------------------------------------------------------------------
create or replace function user_can_manage_job(job_id_text text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select is_office_or_admin(auth.uid())
      or exists (
           select 1
           from public.jobs j
           where j.id::text = job_id_text
             and j.assigned_to = auth.uid()
         );
$$;

comment on function user_can_manage_job(text) is
  'Office/admin, or the technician the job is assigned to. The database half of '
  'canManageJobBilling (lib/api/job-authz.ts:16-28), and the same scope as the '
  'technician PowerSync streams (mobile/powersync/sync-streams.yaml:89). Takes '
  'text so storage policies can pass split_part(name, ''/'', 1) without a uuid '
  'cast that would RAISE on a non-uuid key rather than simply not matching. '
  'SECURITY DEFINER because an RLS policy body runs as the invoking user, so a '
  'bare subquery over jobs would be filtered by jobs own RLS — correct only for '
  'as long as jobs stays wide open. If you change this rule, change the other '
  'two.';

revoke execute on function user_can_manage_job(text) from public;
grant execute on function user_can_manage_job(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. storage.objects — drop whatever governs these two buckets, BY ENUMERATION.
--
--    Never `drop policy if exists "<guessed name>"`. 0034 did that, production
--    had named the policy differently, the drop matched nothing, the migration
--    reported success and xero_tokens stayed open for weeks. 0042 exists to
--    undo it.
--
--    Matching on polqual || polwithcheck rather than coalesce(polqual,
--    polwithcheck). 0047:137-142 used coalesce, which inspects ONLY polqual
--    whenever both are present — a FOR ALL policy naming the bucket solely in
--    its WITH CHECK would slip through. Concatenating tests both.
-- ---------------------------------------------------------------------------
do $$
declare
  pol record;
  managed_buckets text[] := array['job-photos', 'job-audio'];
  b text;
begin
  for pol in
    select p.polname,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '')
        || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as body
    from pg_policy p
    where p.polrelid = 'storage.objects'::regclass
  loop
    foreach b in array managed_buckets loop
      if position(b in pol.body) > 0 then
        execute format('drop policy %I on storage.objects', pol.polname);
        exit;  -- this policy is gone; on to the next
      end if;
    end loop;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. storage.objects — recreate. Read and create stay open; destroying or
--    replacing an object is scoped to the job.
--
--    SELECT is deliberately NOT narrowed. Reusing this predicate for reads
--    would take 9710 objects away from technicians — every completed job, the
--    whole simPRO import, and their own photos the moment a job is reassigned —
--    on a tab they use daily. That is exactly the breakage 0047:66-70 refused
--    for job-documents. These files are not money documents; 0047 already moved
--    those to job-documents' money paths. The hole here is DESTRUCTION, so
--    destruction is what changes.
--
--    INSERT is also NOT narrowed, and that is a real (smaller) hole left open:
--    a technician can plant an object under another job's prefix. Narrowing it
--    would break the second-technician-helping-out flow described below, and
--    unlike deletion an unwanted upload is reversible. Recorded as an open
--    decision at the bottom rather than fixed silently.
--
--    `to authenticated` on every policy. 0037:39 and 0000_baseline.sql:328/332
--    and 0006:27/31 all omit it, leaving the policies TO PUBLIC and held shut
--    only by the auth.role() test inside the body — one careless edit to that
--    body away from world-accessible. 0047:186-187 called this out.
--
--    ONE permissive policy per command, whole condition inside it. Two
--    permissive policies for the same command OR together, which is how 0034's
--    surviving policy kept xero_tokens open.
-- ---------------------------------------------------------------------------
create policy "job photos are readable by authenticated users"
  on storage.objects for select to authenticated
  using (bucket_id = 'job-photos');

create policy "job photos are uploadable by authenticated users"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos');

create policy "job photos are deletable only on your own job"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'job-photos'
    and (select user_can_manage_job(split_part(name, '/', 1)))
  );

-- UPDATE is granted here where it never existed before, and both USING and
-- WITH CHECK are spelled out.
--
-- Why grant it at all: mobile uploads with `upsert: true` unconditionally
-- (gateway.supabase.ts:65, "idempotent re-upload on replay"). Supabase Storage
-- implements upsert-over-an-existing-object as an UPDATE on storage.objects, so
-- with no UPDATE policy the one path that flag exists to serve is the one path
-- that fails — and uploadObject THROWS (unlike removeObject, which swallows),
-- so the operation retries and dead-letters at MAX_ATTEMPTS. 0047 created this
-- asymmetry without noticing: it gave job-documents and equipment-documents
-- UPDATE policies (:197-200, :236-251), so expense-receipt replays work while
-- job-photo replays do not.
--
--   PROVISIONAL, and flagged as such deliberately. That upsert is implemented
--   as an UPDATE comes from the installed SDK's own doc block
--   (node_modules/@supabase/storage-js/dist/index.cjs:700) — it has NOT been
--   tested against the deployed storage-api. If that version implements upsert
--   as delete-then-insert instead, DELETE governs it rather than UPDATE. The
--   migration is right either way, because both commands carry the same
--   predicate; it is the EXPLANATION above that is unconfirmed. Probe it when
--   verifying (upload twice to one key, on an assigned job and an unassigned
--   one) and correct this paragraph with what you observe.
--
-- Why it must be scoped: overwriting an object with a one-byte file destroys
-- evidence just as thoroughly as deleting it, and needs no DELETE at all.
-- Leaving UPDATE unspecified is only safe while it is denied to everyone — and
-- the obvious fix for the replay bug is for someone to add
-- `auth.role() = 'authenticated'` in a hurry and hand the whole hole back under
-- a different command. Scoping it now removes that loaded gun.
--
-- Why WITH CHECK is written out: Postgres reuses USING as WITH CHECK when WITH
-- CHECK is omitted on FOR UPDATE. That implicit reuse is the 0044
-- vulnerability. Relying on it would check the row you may overwrite but not
-- the row you overwrite it INTO.
create policy "job photos are replaceable only on your own job"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'job-photos'
    and (select user_can_manage_job(split_part(name, '/', 1)))
  )
  with check (
    bucket_id = 'job-photos'
    and (select user_can_manage_job(split_part(name, '/', 1)))
  );

create policy "job audio is readable by authenticated users"
  on storage.objects for select to authenticated
  using (bucket_id = 'job-audio');

create policy "job audio is uploadable by authenticated users"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'job-audio');

create policy "job audio is deletable only on your own job"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'job-audio'
    and (select user_can_manage_job(split_part(name, '/', 1)))
  );

-- The voice report writes a FIXED key per job (voiceReport.ts:33), so every
-- re-record is an upsert over an existing object — an UPDATE, not a DELETE.
-- Without this policy a second recording cannot land at all; with an UNSCOPED
-- one, every authenticated user could substitute arbitrary audio on a job,
-- which the transcribe route would then re-transcribe into
-- jobs.voice_report_transcript under the service role, producing a
-- plausible-looking false record. That is the same hole the route's own
-- membership check was added to close.
create policy "job audio is replaceable only on your own job"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'job-audio'
    and (select user_can_manage_job(split_part(name, '/', 1)))
  )
  with check (
    bucket_id = 'job-audio'
    and (select user_can_manage_job(split_part(name, '/', 1)))
  );

-- ---------------------------------------------------------------------------
-- 4. job_photos — the metadata row. Bypass route 1.
--
--    RESTRICTIVE, not a replacement. The blanket policy at
--    0000_baseline.sql:165 is `for all`, covering select/insert/update/delete;
--    swapping it out means re-deriving three other commands this change has not
--    measured. A restrictive policy ANDs with every permissive one, so
--    effective delete becomes (blanket AND this scope) — surgical, and it keeps
--    binding even if someone later adds another permissive delete policy.
--
--    Deliberately DELETE only. Editing a caption is not evidence destruction.
-- ---------------------------------------------------------------------------
create policy "job photo rows are deletable only on your own job"
  on job_photos as restrictive for delete to authenticated
  using ((select user_can_manage_job(job_id::text)));

-- ---------------------------------------------------------------------------
-- 5. jobs.assigned_to — bypass route 2 (self-assignment).
--
--    A trigger, not a policy: RLS cannot express "this column is different".
--    Modelled on 0025's enforce_rate_override_admin_only, which protects
--    time_entries.rate_override the same way and for the same reason.
--
--    Diverges from 0025 in one respect. 0025 SILENTLY reverts the column. Here
--    it RAISES, because a technician has no legitimate reason to touch
--    assigned_to at all, and a silent revert would leave an attacker's probe
--    indistinguishable from success while giving a confused office user no
--    explanation. `is distinct from` means a client that PATCHes the whole row
--    with assigned_to unchanged is unaffected — which matters, because
--    mobile .../repositories/jobs.ts:58 sends the column only when it is
--    explicitly supplied, and the Schedule reassign path
--    (.../repositories/schedule.ts:21) is an office-only screen.
--
--    The alternative considered and rejected:
--      revoke update (assigned_to) on public.jobs from authenticated;
--    plus a security-definer reassign_job() RPC. Column privileges do bite here
--    (PostgREST names only the columns in the PATCH body), and it is arguably
--    the tidier mechanism. It was rejected because REVOKE hits office/admin too
--    — they are the same `authenticated` role — so it cannot ship without also
--    repointing both reassign call sites (mobile .../repositories/schedule.ts:21
--    and components/schedule/team-schedule-view.tsx) at the RPC. The trigger
--    needs no client change at all, which keeps this migration's blast radius
--    where it belongs.
-- ---------------------------------------------------------------------------
create or replace function enforce_job_assignment_office_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and not is_office_or_admin(auth.uid()) then
      raise exception
        'only office/admin may assign a job (attempted assignment to %)', new.assigned_to
        using errcode = 'insufficient_privilege';
    end if;
  elsif new.assigned_to is distinct from old.assigned_to
        and not is_office_or_admin(auth.uid()) then
    raise exception
      'only office/admin may change a job assignment (% -> %)', old.assigned_to, new.assigned_to
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

comment on function enforce_job_assignment_office_only() is
  'jobs.assigned_to is the predicate that guards job photos, voice reports and '
  'billing actions. jobs itself is governed by a blanket '
  'auth.role() = ''authenticated'' policy (0000_baseline.sql:131), so without '
  'this a technician could assign a victim job to themselves, destroy its '
  'evidence, and assign it back. Same shape as '
  'enforce_rate_override_admin_only (0025:32).';

drop trigger if exists jobs_assignment_office_only on jobs;
create trigger jobs_assignment_office_only
  before insert or update on jobs
  for each row execute function enforce_job_assignment_office_only();

-- ---------------------------------------------------------------------------
-- 6. jobs DELETE — bypass route 3 (the cascade).
--
--    job_photos.job_id is ON DELETE CASCADE, so deleting the job takes the
--    photo rows with it and sections 4 and 5 count for nothing.
--
--    Restrictive again, for the same reason as section 4: the blanket `for all`
--    policy stays, and this ANDs a role requirement onto DELETE alone.
--    Technicians keep every other write on jobs — status, notes, completion —
--    exactly as before.
--
--    Blast radius: one call site. components/job/delete-job-dialog.tsx:34 is
--    the only place in either app that deletes a job, and it is a back-office
--    screen. (The web dashboard has no role gate of its own, so before this a
--    technician who found the URL could delete a job outright.)
-- ---------------------------------------------------------------------------
create policy "only office/admin may delete a job"
  on jobs as restrictive for delete to authenticated
  using ((select is_office_or_admin(auth.uid())));

-- ---------------------------------------------------------------------------
-- 7. Assert the end state, and RAISE if it is not what was intended.
--
--    A security migration that can silently achieve nothing is worse than no
--    migration, because it closes the ticket. 0034 reported success and did
--    nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  leftover text;
begin
  -- (a) Nothing destructive may still govern these buckets without the scope.
  --     Tests polqual AND polwithcheck: an INSERT policy stores its expression
  --     in with_check and NOTHING in qual, so a qual-only sweep reads an empty
  --     string and reports a clean bill of health it has not earned.
  --     polcmd '*' is FOR ALL, which also confers DELETE.
  select string_agg(polname, ', ') into leftover
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and polcmd in ('d', 'w', '*')
    and (
      position('job-photos' in coalesce(pg_get_expr(polqual, polrelid), '')
                            || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
      or position('job-audio' in coalesce(pg_get_expr(polqual, polrelid), '')
                              || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
    )
    and position('user_can_manage_job' in coalesce(pg_get_expr(polqual, polrelid), '')
                                       || coalesce(pg_get_expr(polwithcheck, polrelid), '')) = 0;
  if leftover is not null then
    raise exception
      'ASSERTION FAILED: destructive storage policy(ies) [%] still govern job media unscoped', leftover;
  end if;

  -- (b) Exactly the eight policies created above. More than eight means an old
  --     permissive policy survived the drop — and permissive policies OR, so a
  --     survivor silently restores the hole.
  select count(*) into n
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and (
      position('job-photos' in coalesce(pg_get_expr(polqual, polrelid), '')
                            || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
      or position('job-audio' in coalesce(pg_get_expr(polqual, polrelid), '')
                              || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
    );
  if n <> 8 then
    raise exception 'ASSERTION FAILED: expected 8 job-media storage policies, found %', n;
  end if;

  -- (c) The row-level and cascade guards exist and are RESTRICTIVE. A
  --     permissive policy here would OR with the blanket rule and do nothing.
  select count(*) into n
  from pg_policy
  where polrelid = 'job_photos'::regclass
    and polcmd = 'd' and not polpermissive
    and position('user_can_manage_job' in coalesce(pg_get_expr(polqual, polrelid), '')) > 0;
  if n <> 1 then
    raise exception 'ASSERTION FAILED: job_photos has % restrictive scoped DELETE policies, expected 1', n;
  end if;

  select count(*) into n
  from pg_policy
  where polrelid = 'jobs'::regclass
    and polcmd = 'd' and not polpermissive
    and position('is_office_or_admin' in coalesce(pg_get_expr(polqual, polrelid), '')) > 0;
  if n <> 1 then
    raise exception 'ASSERTION FAILED: jobs has % restrictive office-only DELETE policies, expected 1', n;
  end if;

  -- (d) The assignment trigger is attached and enabled. A function with no
  --     trigger on it protects nothing.
  select count(*) into n
  from pg_trigger
  where tgrelid = 'jobs'::regclass
    and tgname = 'jobs_assignment_office_only'
    and tgenabled <> 'D';
  if n <> 1 then
    raise exception 'ASSERTION FAILED: jobs_assignment_office_only trigger missing or disabled';
  end if;

  -- (e) The predicate must actually discriminate. If someone "simplifies" it to
  --     `select true`, every assertion above still passes and the hole is wide
  --     open — so test the classifier itself, in BOTH directions.
  --
  --     Negative half first, as a caller with no JWT: no claim means auth.uid()
  --     is null, so nothing can match.
  perform set_config('request.jwt.claims', '', true);
  if user_can_manage_job('not-a-uuid') is not false then
    raise exception 'ASSERTION FAILED: a non-uuid job key is treated as manageable';
  end if;
  if user_can_manage_job('00000000-0000-0000-0000-000000000000') is not false then
    raise exception 'ASSERTION FAILED: a key naming no real job is treated as manageable';
  end if;

  -- Positive half, against a real assignment, so the function cannot pass by
  -- returning false for everything.
  if exists (select 1 from jobs where assigned_to is not null) then
    declare
      j jobs%rowtype;
      owned boolean;
    begin
      select * into j from jobs where assigned_to is not null limit 1;
      perform set_config('request.jwt.claims',
                         json_build_object('sub', j.assigned_to::text,
                                           'role', 'authenticated')::text, true);
      owned := user_can_manage_job(j.id::text);
      perform set_config('request.jwt.claims', '', true);
      if owned is not true then
        raise exception
          'ASSERTION FAILED: the assigned technician of job % is not recognised as able to manage it', j.id;
      end if;
    end;
  else
    raise warning
      'no job has assigned_to set — the positive half of the predicate test could not run';
  end if;

  -- (f) 0047's buckets must be untouched. This migration has no business
  --     reaching job-documents or equipment-documents; if the drop loop ever
  --     over-matches, this is what says so.
  select count(*) into n
  from pg_policy
  where polrelid = 'storage.objects'::regclass
    and (
      position('job-documents' in coalesce(pg_get_expr(polqual, polrelid), '')
                               || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
      or position('equipment-documents' in coalesce(pg_get_expr(polqual, polrelid), '')
                                        || coalesce(pg_get_expr(polwithcheck, polrelid), '')) > 0
    );
  if n <> 8 then
    raise exception
      'ASSERTION FAILED: expected 0047''s 8 document policies intact, found %', n;
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING — do not trust the assertions alone.
--
-- Everything above proves the POLICIES look right. Only attempting the delete
-- as a technician proves a technician is refused:
--
--     psql "$SUPABASE_DB_URL" -f supabase/tests/0049_storage_delete_scoping_test.sql
--
-- Run it BEFORE and AFTER. Before, the "technician deletes another job's ..."
-- rows must read HOLE OPEN. If they do not, the test is not reaching the hole
-- and its silence afterwards means nothing — which is precisely how
-- tests/rls/financial-tables.test.ts rotted, asserting toHaveLength(0) against
-- tables it never seeded.
--
-- Then re-run scripts/check-storage-path-scoping.mjs: the counts must be
-- unchanged, since this migration touches no objects.
--
-- ---------------------------------------------------------------------------
-- REVERT, PER SECTION
-- ---------------------------------------------------------------------------
--   6. drop policy "only office/admin may delete a job" on jobs;
--   5. drop trigger jobs_assignment_office_only on jobs;
--   4. drop policy "job photo rows are deletable only on your own job" on job_photos;
--   3. drop the eight storage policies and re-create 0037's + baseline's three
--      per bucket (this reopens S4 — it is the emergency exit, not a rollback
--      to a good state).
--   1. drop function user_can_manage_job(text);   -- last, sections 3-4 use it
--
-- ---------------------------------------------------------------------------
-- OPEN DECISIONS — these need a human, and are NOT settled by this migration
-- ---------------------------------------------------------------------------
-- A. Should a technician still delete a photo after the job is signed off?
--    Raised by 0047:366-368 and still unanswered. Today they can, if assigned.
--    Adding `and j.status <> 'completed'` to the helper is a one-line change if
--    the answer is no.
--
-- B. The second-technician-helping-out asymmetry. A technician can open ANY job
--    from the mobile Search tab and upload photos to it, but after this change
--    can only delete on jobs assigned to them — so they cannot remove their own
--    mistaken upload on a mate's job. The obvious fix, "or you uploaded it",
--    is NOT safe yet: job_photos.uploaded_by is writable under the same blanket
--    policy, so an attacker would simply claim authorship first. It needs
--    uploaded_by write-protected before it can be offered.
--
-- C. INSERT stays open on both buckets, so a technician can still plant an
--    object under another job's prefix. Reversible, unlike deletion, and
--    narrowing it would worsen (B). Left open deliberately.
--
-- D. Should a customer SIGNATURE be deletable by anyone at all? This treats
--    <jobId>/signature_*.png like any other photo — office/admin and the
--    assignee may delete it. There is no bucket versioning, and it is the
--    sign-off record. Admin-only for that key shape is a defensible
--    alternative. A compliance question, not a code question.
--
-- E. Is "822 of 827 jobs unassigned" the operating model, or a gap? It decides
--    what this migration actually IS. If assignment stays unused, the business
--    is approving an effectively office/admin-only delete policy — which is
--    fine, but should be approved knowingly rather than described as
--    "technicians keep deleting their own photos", because today that set is
--    6 objects. If assignment is about to be used routinely, the blast radius
--    grows and (A) becomes urgent.
--
-- F. Should deletion be permanent at all? There is no bucket versioning and no
--    backup. If the answer is that photo deletion should be recoverable, this
--    migration is the wrong shape and a deleted_at column is the right one.
--
-- ---------------------------------------------------------------------------
-- FOLLOW-UPS, NOT IN THIS MIGRATION
-- ---------------------------------------------------------------------------
-- 1. 0047's assertion (d) hard-codes "expected job-photos to still have its 3
--    original policies". Replaying the migration tree in order is fine — 0047
--    runs before this — but re-running 0047 ALONE after this will now fail.
--
-- 2. job-audio holds ZERO objects while jobs.voice_report_* columns are written
--    and the transcribe route downloads from that bucket. Either no voice
--    report has ever been stored, or they are being removed. Worth finding out.
--
-- 3. THE ORPHANS. 6 objects hang off job ids with no jobs row, and there is no
--    product surface through which office/admin can reach them — only the
--    service role or the dashboard. Nothing cleans them up.
--
-- 4. mobile/lib/data/outbox/processor.ts:164,187 default the bucket to
--    'job-photos' when an operation payload omits one. Outbox rows are durable
--    SQLite replayed by later builds, so an op enqueued without a bucket lands
--    a foreign id as the first path segment — a silent misfile AND an object
--    this policy can never match. A missing bucket should throw.
-- ============================================================================
