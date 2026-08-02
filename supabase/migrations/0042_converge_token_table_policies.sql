-- =============================================
-- CONVERGE OAUTH TOKEN-TABLE POLICIES (supersedes the 0034 fix)
--
-- WHY THIS EXISTS AS A NEW MIGRATION
-- 0034 was corrected IN PLACE on 2026-07-30 after a pg_policies check found it
-- had never taken effect. That correction cannot help on its own: the migration
-- ledger already records 0034 as applied, so `supabase db push` will not re-run
-- it. The edited file would sit in the repo looking like a fix while production
-- stayed exposed — the same silent-failure shape as the original defect.
--
-- WHAT WENT WRONG ORIGINALLY
-- 0034 tried to remove the permissive policy by NAME. The policy created
-- out-of-band in production was named differently, so `drop policy if exists`
-- matched nothing and did nothing — no error, no warning. Postgres OR-es
-- permissive policies together, so one missed drop leaves the table wide open.
-- Any authenticated user, a technician holding the anon key included, could read
-- the org's Xero OAuth access and refresh tokens.
--
-- WHY THIS ONE CANNOT FAIL THE SAME WAY
--   1. It drops policies by ENUMERATING pg_policy, not by guessing names. It
--      cannot miss one, whatever it is called.
--   2. It ASSERTS the end state and raises. If the table does not finish with
--      RLS enabled and exactly the intended policy, this migration fails loudly
--      instead of reporting success.
--
-- Idempotent and safe to re-run.
--
-- Reuses is_office_or_admin(uid) from migration 0027.
-- =============================================

-- ---------------------------------------------------------------------------
-- xero_tokens — the table with the confirmed leak
-- ---------------------------------------------------------------------------
alter table xero_tokens enable row level security;

do $$
declare
  pol record;
begin
  -- Drop EVERY existing policy, whatever it is named. Guessing names is what
  -- failed before.
  for pol in
    select polname from pg_policy where polrelid = 'public.xero_tokens'::regclass
  loop
    execute format('drop policy %I on public.xero_tokens', pol.polname);
  end loop;
end $$;

create policy "Office/admin can manage xero tokens" on xero_tokens for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Post-condition. A migration that silently achieves nothing is what put the
-- org's accounting credentials at risk, so this one refuses to report success
-- unless the end state is actually correct.
-- ---------------------------------------------------------------------------
do $$
declare
  -- The exact normalised form Postgres renders for the policy we just created.
  -- Comparing against this rather than substring-matching on
  -- '%is_office_or_admin%' matters: `USING (is_office_or_admin(auth.uid()) OR
  -- true)` CONTAINS that substring and grants everyone. A substring test would
  -- wave it through — which is the same species of near-miss that produced this
  -- incident, so the assertion is exact.
  expected text := 'is_office_or_admin(auth.uid())';
  rls_on boolean;
  n_permissive int;
  n_restrictive int;
  actual_qual text;
  actual_check text;
begin
  select relrowsecurity into rls_on
    from pg_class where oid = 'public.xero_tokens'::regclass;

  if not rls_on then
    raise exception 'xero_tokens: row level security is OFF after migration 0042';
  end if;

  -- PERMISSIVE and RESTRICTIVE policies combine differently (OR versus AND), so
  -- counting them together says nothing useful. Count them apart.
  select count(*) filter (where polpermissive),
         count(*) filter (where not polpermissive)
    into n_permissive, n_restrictive
    from pg_policy where polrelid = 'public.xero_tokens'::regclass;

  if n_permissive <> 1 then
    raise exception
      'xero_tokens: expected exactly 1 PERMISSIVE policy after 0042, found % (permissive policies are OR-ed; more than one is how the original leak survived)',
      n_permissive;
  end if;

  if n_restrictive <> 0 then
    raise exception
      'xero_tokens: found % RESTRICTIVE policy/policies, which were not expected here', n_restrictive;
  end if;

  select regexp_replace(coalesce(pg_get_expr(polqual, polrelid), ''), '\s+', '', 'g'),
         regexp_replace(coalesce(pg_get_expr(polwithcheck, polrelid), ''), '\s+', '', 'g')
    into actual_qual, actual_check
    from pg_policy
   where polrelid = 'public.xero_tokens'::regclass and polpermissive;

  if actual_qual <> regexp_replace(expected, '\s+', '', 'g') then
    raise exception 'xero_tokens: USING clause is "%", expected "%"', actual_qual, expected;
  end if;

  -- USING governs reads; WITH CHECK governs writes. Asserting only the former
  -- would let a policy that reads correctly still accept writes it should not.
  if actual_check <> regexp_replace(expected, '\s+', '', 'g') then
    raise exception 'xero_tokens: WITH CHECK clause is "%", expected "%"', actual_check, expected;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- google_tokens — DETECT ONLY, do not silently change
--
-- 0027/0028 were meant to lock this table the same way. Whether that actually
-- took effect in production has never been verified, and it is the same class
-- of risk. This block does NOT rewrite the policies: the Google Calendar
-- integration is live, and quietly changing its access rules during a security
-- migration is how you trade one incident for another. It raises instead, so a
-- drifted state is surfaced to a human rather than assumed away.
-- ---------------------------------------------------------------------------
do $$
declare
  rls_on boolean;
  permissive_policy text;
begin
  if to_regclass('public.google_tokens') is null then
    raise notice 'google_tokens does not exist — nothing to check';
    return;
  end if;

  select relrowsecurity into rls_on
    from pg_class where oid = 'public.google_tokens'::regclass;

  if not rls_on then
    raise exception 'google_tokens: RLS is OFF — any authenticated user can read Google OAuth tokens. Lock it before shipping.';
  end if;

  -- Same exactness as above: a policy can mention is_office_or_admin and still
  -- grant everyone via OR, so anything that is not exactly the expected gate is
  -- reported for a human to look at.
  select polname into permissive_policy
    from pg_policy
   where polrelid = 'public.google_tokens'::regclass
     and polpermissive
     and regexp_replace(coalesce(pg_get_expr(polqual, polrelid), ''), '\s+', '', 'g')
         <> 'is_office_or_admin(auth.uid())'
   limit 1;

  if permissive_policy is not null then
    raise exception 'google_tokens: policy "%" does not gate on is_office_or_admin — same defect class as the xero_tokens leak', permissive_policy;
  end if;
end $$;
