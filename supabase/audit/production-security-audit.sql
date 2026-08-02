-- =============================================
-- PRODUCTION SECURITY AUDIT — run against the LIVE database
--
-- WHY THIS EXISTS
-- Three defects in this project shared one cause: what the source says and what
-- the database actually contains had diverged, and nothing checked. Twice it was
-- a missing column; once it was a permissive policy that left the org's Xero
-- OAuth tokens readable by every authenticated user, including technicians.
--
-- None of them were catchable by the test suite, because ~430 tests mock
-- Supabase and `npm run test:rls` boots a LOCAL stack rebuilt from these same
-- migrations — so it agrees with them by construction. Only a query against the
-- real database can find this class of defect.
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> paste this file -> Run.
--   Read-only. Safe on production. Takes under a second.
--
-- HOW TO READ IT
--   Every row returned is a FINDING. No rows returned = clean.
--   Findings are ordered most severe first.
--
-- WHEN TO RUN IT
--   After every migration applied to production, and before each release.
-- =============================================

with

-- Tables whose contents must never reach a technician: money, credentials, and
-- whatever reveals pricing or cost.
sensitive_tables(tbl, reason) as (
  values
    ('xero_tokens',            'Xero OAuth access + refresh tokens'),
    ('google_tokens',          'Google OAuth tokens'),
    ('invoices',               'money'),
    ('invoice_items',          'money'),
    ('quotes',                 'money'),
    ('quote_items',            'money'),
    ('pricing_items',          'money'),
    ('inventory',              'unit_cost / unit_sell'),
    ('job_expenses',           'money'),
    ('purchase_orders',        'money'),
    ('po_cost_centers',        'money'),
    ('cost_center_templates',  'money'),
    ('equipment',              'purchase + running cost'),
    ('equipment_expenses',     'money'),
    ('job_items',              'money')
),

existing as (
  select s.tbl, s.reason, c.oid, c.relrowsecurity
    from sensitive_tables s
    join pg_class c on c.oid = to_regclass('public.' || s.tbl)
   where c.oid is not null
),

-- FINDING 1: RLS switched off entirely. Nothing else matters if this is true.
rls_off as (
  select 1 as severity,
         'RLS DISABLED' as finding,
         tbl as object_name,
         reason || ' — table is readable by every authenticated user' as detail
    from existing
   where not relrowsecurity
),

-- FINDING 2: a PERMISSIVE policy that does not gate on role. This is the exact
-- shape of the xero_tokens leak: a permissive policy using
-- auth.role() = 'authenticated', OR-ed alongside the intended one, silently
-- defeating it.
--
-- Note this deliberately does NOT substring-match on 'is_office_or_admin'. A
-- policy can name that function and still grant everyone —
-- `USING (is_office_or_admin(auth.uid()) OR true)` contains the substring. Only
-- an exact match on the expected expression is meaningful. Restrictive policies
-- are excluded because they AND-combine and cannot widen access.
--
-- WITH CHECK is examined as well as USING: the first governs reads, the second
-- governs writes, and a policy can be correct on one and wrong on the other.
ungated_policy as (
  select 2 as severity,
         'UNGATED POLICY' as finding,
         e.tbl || ' :: ' || p.polname as object_name,
         'USING (' || coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') ||
           ') WITH CHECK (' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-') ||
           ') is not exactly is_office_or_admin(auth.uid()) — ' || e.reason as detail
    from existing e
    join pg_policy p on p.polrelid = e.oid
   where p.polpermissive
     and (
       regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), 'true'), '\s+', '', 'g')
         <> 'is_office_or_admin(auth.uid())'
       or (
         p.polwithcheck is not null
         and regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\s+', '', 'g')
             <> 'is_office_or_admin(auth.uid())'
       )
     )
),

-- FINDING 3: a sensitive table with RLS on but no policy at all. Postgres denies
-- by default here, so it is not an exposure — but it usually means the app is
-- silently broken for office/admin, which tends to get "fixed" by someone adding
-- a permissive policy in a hurry. Worth surfacing early.
no_policy as (
  select 3 as severity,
         'NO POLICY' as finding,
         tbl as object_name,
         reason || ' — RLS on but no policy; office/admin cannot read it either' as detail
    from existing e
   where relrowsecurity
     and not exists (select 1 from pg_policy p where p.polrelid = e.oid)
),

-- FINDING 4: every table in public carrying an auth.role()-style blanket policy.
-- This generalises the specific bug: it is the pattern to hunt for, not just the
-- one table it happened to bite.
blanket_policy as (
  select 4 as severity,
         'BLANKET AUTHENTICATED POLICY' as finding,
         c.relname || ' :: ' || p.polname as object_name,
         'USING (' || coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') ||
           ') grants every authenticated user — review whether that is intended' as detail
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and coalesce(pg_get_expr(p.polqual, p.polrelid), 'true') like '%auth.role()%'
),

-- FINDING 5: sensitive tables published to PowerSync. Replication bypasses RLS
-- entirely, so publication membership is a second, independent exposure surface.
-- Membership alone is not a leak (the sync rules select columns), but a money
-- table in the publication means the sync rules are the ONLY barrier between a
-- technician and that data.
published_sensitive as (
  select 5 as severity,
         'SENSITIVE TABLE PUBLISHED' as finding,
         e.tbl as object_name,
         e.reason || ' — in the powersync publication; sync-streams.yaml column ' ||
           'selection is the only barrier, RLS does not apply to replication' as detail
    from existing e
    join pg_publication_rel pr on pr.prrelid = e.oid
    join pg_publication pub on pub.oid = pr.prpubid
   where pub.pubname like '%powersync%'
),

-- FINDING 6: SECURITY DEFINER functions. These run as their owner and bypass the
-- caller's RLS. Each one is a deliberate hole and should be justified.
sec_definer as (
  select 6 as severity,
         'SECURITY DEFINER FUNCTION' as finding,
         p.proname as object_name,
         'runs as owner, bypasses caller RLS — confirm it authorises internally' as detail
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and p.proname not in ('is_office_or_admin')  -- the intended gate helper
)

select finding, object_name, detail
  from (
    select * from rls_off
    union all select * from ungated_policy
    union all select * from no_policy
    union all select * from blanket_policy
    union all select * from published_sensitive
    union all select * from sec_definer
  ) f
 order by severity, object_name;

-- =============================================
-- EXPECTED RESULT ONCE MIGRATION 0042 IS APPLIED
--
--   * No 'RLS DISABLED' rows.
--   * No 'UNGATED POLICY' rows.
--   * No 'BLANKET AUTHENTICATED POLICY' rows on xero_tokens or google_tokens.
--   * 'SENSITIVE TABLE PUBLISHED' rows are EXPECTED for the office/admin tables
--     the mobile app legitimately syncs — that is by design, and the
--     column-level protection lives in mobile/powersync/sync-streams.yaml
--     (enforced by tests/unit/sync-streams-contract.test.ts). Confirm the list
--     matches what you expect, rather than assuming it.
--   * 'SECURITY DEFINER FUNCTION' rows should each be individually justified.
--
-- If 'UNGATED POLICY' returns a row for xero_tokens, migration 0042 has NOT been
-- applied and the OAuth tokens are still exposed.
-- =============================================
