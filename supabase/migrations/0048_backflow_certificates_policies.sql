-- ============================================================================
-- backflow-certificates has NO storage policies, so signature upload fails.
--
-- STATUS: APPLIED AND VERIFIED IN PRODUCTION (2026-08-05).
--
-- Verified after applying, by impersonation, including the negative control —
-- "upload works" and "upload works AND ONLY for signatures" are different
-- claims and only the second one is the guarantee:
--
--   technician uploads a SIGNATURE     ALLOWED
--   technician forges a CERTIFICATE    DENIED    (path-scoped to signatures/)
--   technician reads the bucket        0
--   office reads the bucket            2
--
-- This is the OPPOSITE of 0047. That migration closed a leak. This one repairs a
-- live DENIAL: RLS is enabled on storage.objects and not one policy names this
-- bucket, so every non-service-role operation on it is refused.
--
-- MEASURED AGAINST PRODUCTION, 2026-08-05 (impersonation, rolled back):
--
--     objects in bucket (as postgres)   1
--     technician SEES                   0
--     office SEES                       0
--     technician UPLOAD                 DENIED
--
-- Note the office row. This is not a technician-vs-office problem — the bucket
-- is invisible to EVERY signed-in user. Only the service-role key can touch it.
--
-- WHAT IS ACTUALLY BROKEN. Two client paths upload a signature under the user's
-- own session, and both are refused today:
--
--   web    app/dashboard/backflow/[id]/test/new/page.tsx:189
--          upload(`${deviceId}/signatures/${Date.now()}.png`)
--          -> the error is caught and shown as a toast: "Failed to save
--             signature — continuing without it". The test is then submitted
--             WITHOUT the signature, which is the compliance artifact.
--
--   mobile lib/data/repositories/backflow.ts
--          attachmentPathField: "signature_storage_path", uploaded by the
--          attachment queue under the technician's session.
--
-- Everything else on this bucket runs under the SERVICE-ROLE key and is
-- unaffected by RLS either way:
--   api/backflow/tests/[id]/submit/route.ts:84   download(signature)
--   api/backflow/tests/[id]/submit/route.ts:106  upload(certificate pdf)
--   api/backflow/tests/[id]/certificate/route.ts createSignedUrl(certificate)
--
-- So the fix needs to grant exactly one thing to clients — the ability to WRITE
-- a signature — and nothing more.
--
-- WHY READ STAYS CLOSED. No client code reads this bucket; every read is
-- server-side under the service-role key. Granting SELECT would widen the
-- surface for no caller. A certificate is a compliance document naming a
-- customer and a site, so the default of "nobody reads it directly" is correct
-- and is left in place deliberately rather than by omission — which is exactly
-- the distinction this file exists to record, because the previous omission was
-- indistinguishable from a decision.
--
-- WHY TECHNICIANS CAN WRITE. Backflow testing IS the technician's job: the
-- mobile app has a Backflow tab, and the signature is captured on site at the
-- moment of the test. Restricting the write to office/admin would break the
-- feature for the only role that uses it.
--
-- PATH SCOPING. Signatures go to `{deviceId}/signatures/{timestamp}.png` and
-- certificates to `{deviceId}/{testId}_{timestamp}.pdf`. The INSERT policy below
-- permits ONLY the signatures/ prefix, so a client cannot forge a certificate
-- PDF into the path the water authority's copy is served from. The certificate
-- is written by the service-role key, which bypasses this policy entirely.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Signature upload — authenticated, restricted to the signatures/ prefix.
-- ---------------------------------------------------------------------------
drop policy if exists "backflow signatures are uploadable by authenticated users" on storage.objects;
create policy "backflow signatures are uploadable by authenticated users"
  on storage.objects for insert
  with check (
    bucket_id = 'backflow-certificates'
    and auth.role() = 'authenticated'
    -- Second path segment must be exactly `signatures`. Certificates live at
    -- `{deviceId}/{file}.pdf` (no second segment), so they cannot be written
    -- through this policy.
    and split_part(name, '/', 2) = 'signatures'
  );

-- ---------------------------------------------------------------------------
-- 2. Office/admin may read and manage the whole bucket.
--
-- Not required by any current code path — every server read uses the
-- service-role key — but a compliance bucket that literally nobody with a login
-- can inspect is an operational trap: the first time someone needs to check
-- whether a certificate was produced, they have no way to look.
-- ---------------------------------------------------------------------------
drop policy if exists "backflow certificates are office/admin readable" on storage.objects;
create policy "backflow certificates are office/admin readable"
  on storage.objects for select
  using (
    bucket_id = 'backflow-certificates'
    and (select is_office_or_admin(auth.uid()))
  );

drop policy if exists "backflow certificates are office/admin deletable" on storage.objects;
create policy "backflow certificates are office/admin deletable"
  on storage.objects for delete
  using (
    bucket_id = 'backflow-certificates'
    and (select is_office_or_admin(auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 3. Assert the end state.
--
-- A storage migration that silently achieves nothing is worse than none: it
-- closes the ticket while the upload keeps failing, which is how this bucket
-- ended up with zero policies and a caught error message in the first place.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
  from pg_policies
  where schemaname = 'storage'
    and (qual like '%backflow-certificates%' or with_check like '%backflow-certificates%');
  if n <> 3 then
    raise exception 'ASSERTION FAILED: expected 3 backflow-certificates policies, found %', n;
  end if;

  -- The INSERT policy must actually constrain the prefix. Without this, a
  -- reviewer reading only the policy NAME would believe the scoping exists.
  select count(*) into n
  from pg_policies
  where schemaname = 'storage'
    and policyname = 'backflow signatures are uploadable by authenticated users'
    and with_check like '%signatures%';
  if n <> 1 then
    raise exception 'ASSERTION FAILED: the signature INSERT policy does not restrict the path prefix';
  end if;

  -- 0047's policies must survive: this migration touches one bucket only.
  --
  -- Counts qual OR with_check, and EXCLUDES this migration's own policies.
  -- The first draft counted `qual` alone and asserted `>= 8`. That was wrong
  -- twice over: an INSERT policy stores its expression in `with_check`, not
  -- `qual`, so 0047's true 8 read as 6 — and the assertion still passed the
  -- dry run only because the two policies THIS migration adds are themselves
  -- qual-matching, pushing 6 back up to 8 inside the transaction.
  --
  -- So it would have gone green while measuring the wrong thing, which is the
  -- one failure mode a self-asserting migration exists to prevent.
  select count(*) into n
  from pg_policies
  where schemaname = 'storage'
    and (qual like '%is_office_or_admin%' or with_check like '%is_office_or_admin%')
    and policyname not like 'backflow %';
  if n <> 8 then
    raise exception
      'ASSERTION FAILED: expected 0047''s 8 role-scoped storage policies, found %', n;
  end if;
end;
$$;
