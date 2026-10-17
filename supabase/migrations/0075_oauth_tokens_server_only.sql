-- ============================================================================
-- Xero and Google OAuth tokens: server-only.
--
-- STATUS: DRAFT — NOT APPLIED. Deploy the app change FIRST (it moves every
-- token read/write to the service role), then apply this alone and run
-- supabase/tests/0075_oauth_tokens_server_only_test.sql. Applying this before
-- the deploy breaks Xero push, the Xero/Google callbacks and calendar sync.
--
-- WHY
-- 0042 lets office/admin read and write the whole token row with their own
-- JWT. Any office account — or any XSS on the dashboard — could therefore run
--   supabase.from("xero_tokens").select("refresh_token, tenant_id")
-- from the browser console and walk away with full API access to the
-- business's accounting ledger, or overwrite the row to point the integration
-- at a different Xero org. That also defeats requireAdmin on xero/auth,
-- xero/callback and push-invoice.
--
-- WHAT
-- The RLS policies stay exactly as 0042 left them (its exact-text assertion
-- is not disturbed). What changes is the GRANT underneath them:
--   * signed-in users keep SELECT on the non-secret columns only — the
--     Settings page, the invoice page and the mobile Settings screen read
--     tenant_name / google_email / sync timestamps / account codes / id;
--   * every write, and every read of access_token / refresh_token /
--     calendar_sync_token, goes through the service role
--     (lib/xero.ts, lib/google.ts tokenClient(); the callback, disconnect and
--     account-code routes, each already admin- or office-gated).
-- calendar_sync_token is withheld too: it is not a credential on its own, but
-- nothing client-side needs it.
-- ============================================================================

revoke all on xero_tokens, google_tokens from anon, public;
revoke all on xero_tokens, google_tokens from authenticated;

grant select (id, tenant_id, tenant_name, token_expiry, created_at, updated_at,
              default_expense_account_code, default_sales_account_code,
              xero_invoice_last_synced_at)
  on xero_tokens to authenticated;

grant select (id, google_email, token_expiry, created_at, updated_at,
              calendar_last_synced_at)
  on google_tokens to authenticated;

do $$
declare
  c text;
begin
  foreach c in array array['access_token', 'refresh_token'] loop
    if has_column_privilege('authenticated', 'public.xero_tokens', c, 'select')
       or has_column_privilege('authenticated', 'public.google_tokens', c, 'select') then
      raise exception 'ASSERTION FAILED: authenticated can still read %', c;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'public.google_tokens', 'calendar_sync_token', 'select') then
    raise exception 'ASSERTION FAILED: authenticated can still read calendar_sync_token';
  end if;
  if has_table_privilege('authenticated', 'public.xero_tokens', 'insert')
     or has_table_privilege('authenticated', 'public.xero_tokens', 'update')
     or has_table_privilege('authenticated', 'public.xero_tokens', 'delete')
     or has_table_privilege('authenticated', 'public.google_tokens', 'insert')
     or has_table_privilege('authenticated', 'public.google_tokens', 'update')
     or has_table_privilege('authenticated', 'public.google_tokens', 'delete') then
    raise exception 'ASSERTION FAILED: authenticated can still write a token table';
  end if;
  if not has_column_privilege('authenticated', 'public.xero_tokens', 'tenant_name', 'select')
     or not has_column_privilege('authenticated', 'public.google_tokens', 'google_email', 'select') then
    raise exception 'ASSERTION FAILED: Settings can no longer show the connection status';
  end if;
  if not has_table_privilege('service_role', 'public.xero_tokens', 'select')
     or not has_table_privilege('service_role', 'public.google_tokens', 'update') then
    raise exception 'ASSERTION FAILED: service_role lost access to the token tables';
  end if;
end;
$$;
