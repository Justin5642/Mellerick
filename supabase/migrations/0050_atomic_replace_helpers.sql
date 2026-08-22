-- ============================================================================
-- Two replace-a-set operations that application code cannot make atomic.
--
-- STATUS: ✅ APPLIED AND VERIFIED IN PRODUCTION (2026-08-22). Both functions
-- exist, neither is SECURITY DEFINER (self-asserted at apply time). Nothing
-- calls them yet — repointing lib/replace-line-items.ts and
-- lib/oauth-token-store.ts at .rpc() is a separate, follow-up change.
-- Recorded in supabase_migrations.schema_migrations.
--
-- ---------------------------------------------------------------------------
-- WHY THIS EXISTS
-- ---------------------------------------------------------------------------
-- Two defects were fixed in application code, and both fixes carry a note
-- saying the real answer is a transaction:
--
--   lib/replace-line-items.ts   invoices/[id]/edit and quotes/[id]/edit used to
--                               delete every line item and re-insert, unchecked.
--                               A refused insert destroyed the lines of an
--                               invoice a customer may already have received.
--   lib/oauth-token-store.ts    both OAuth callbacks deleted the existing token
--                               row before inserting the new one, unchecked, so
--                               a failed insert destroyed a working connection
--                               and reported "connected".
--
-- Both now insert FIRST and retire the old rows second, compensating by
-- deleting their own insert if the retire fails. That removes the data-loss
-- window and is the strongest thing available over PostgREST, which has no
-- multi-statement transaction.
--
-- What it cannot remove is the window where BOTH sets exist. For line items
-- that briefly doubles a document's totals; for tokens it breaks every reader,
-- because lib/xero.ts:78 and lib/google.ts:40 both use `.single()`, which errors
-- on 2 rows exactly as it does on 0.
--
-- A function runs inside one transaction. These two make the compensating logic
-- unnecessary, and both call sites collapse to a single `.rpc()`.
--
-- ---------------------------------------------------------------------------
-- AFTER APPLYING
-- ---------------------------------------------------------------------------
-- These are additive: nothing calls them until the client is changed, so
-- applying this migration alone changes no behaviour. Then, in a separate
-- change:
--
--   lib/replace-line-items.ts  -> supabase.rpc("replace_line_items", {...})
--   lib/oauth-token-store.ts   -> supabase.rpc("replace_xero_tokens", {...})
--
-- and both modules reduce to a thin wrapper. Keep their tests: the contract
-- being asserted (never destroy without a confirmed replacement) is the same.
--
-- SECURITY DEFINER is deliberately NOT used. These must run as the caller so
-- RLS still applies — a technician calling replace_line_items must be refused
-- exactly as they are today. The functions exist for atomicity, not privilege.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Replace an invoice's or quote's line items, atomically.
--
--    Takes the new items as jsonb so one function serves both tables without a
--    composite type per document kind.
-- ---------------------------------------------------------------------------
create or replace function replace_line_items(
  p_table    text,
  p_parent_id uuid,
  p_items    jsonb
)
returns integer
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  inserted integer;
begin
  -- Refuse an empty set rather than treating it as "empty the document". The
  -- old client code skipped its insert when nothing was valid and left a
  -- document with no lines — which both send routes then refuse to send, after
  -- the data was already gone.
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'refusing to leave % % with no line items', p_table, p_parent_id
      using errcode = 'check_violation';
  end if;

  if p_table not in ('invoice_items', 'quote_items') then
    raise exception 'replace_line_items does not manage %', p_table
      using errcode = 'invalid_parameter_value';
  end if;

  -- One statement each, one transaction, no window in which the document has
  -- neither set or both. The delete comes first here precisely BECAUSE it is
  -- transactional: if the insert below fails, the delete is rolled back with it.
  if p_table = 'invoice_items' then
    delete from invoice_items where invoice_id = p_parent_id;
    insert into invoice_items (invoice_id, name, description, quantity, unit_price)
    select p_parent_id,
           item->>'name',
           nullif(item->>'description', ''),
           coalesce((item->>'quantity')::numeric, 1),
           (item->>'unit_price')::numeric
      from jsonb_array_elements(p_items) as item;
  else
    delete from quote_items where quote_id = p_parent_id;
    insert into quote_items (quote_id, name, description, quantity, unit_price)
    select p_parent_id,
           item->>'name',
           nullif(item->>'description', ''),
           coalesce((item->>'quantity')::numeric, 1),
           (item->>'unit_price')::numeric
      from jsonb_array_elements(p_items) as item;
  end if;

  get diagnostics inserted = row_count;

  -- RLS can filter an INSERT to zero rows without raising. Rolling back on that
  -- is the whole point: the alternative is a document silently emptied.
  if inserted = 0 then
    raise exception 'no line items were written for % % — refused by RLS?', p_table, p_parent_id
      using errcode = 'insufficient_privilege';
  end if;

  return inserted;
end;
$$;

comment on function replace_line_items(text, uuid, jsonb) is
  'Replace every line item of an invoice or quote in ONE transaction. Exists '
  'because PostgREST cannot span statements, which forced '
  'lib/replace-line-items.ts into an insert-first-then-compensate dance that '
  'briefly doubles a document''s totals. NOT security definer: RLS must still '
  'apply to the caller.';

revoke execute on function replace_line_items(text, uuid, jsonb) from public;
grant execute on function replace_line_items(text, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Replace the single OAuth token row, atomically.
--
--    One function per table rather than a dynamic one: these hold credentials,
--    and a text parameter naming the table is an injection surface nobody needs.
-- ---------------------------------------------------------------------------
create or replace function replace_xero_tokens(
  p_access_token  text,
  p_refresh_token text,
  p_token_expiry  timestamptz,
  p_tenant_id     text,
  p_tenant_name   text
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  delete from xero_tokens;
  insert into xero_tokens (access_token, refresh_token, token_expiry, tenant_id, tenant_name)
  values (p_access_token, p_refresh_token, p_token_expiry, p_tenant_id, p_tenant_name);
  -- No row-count guard needed: an RLS-refused insert inside a transaction that
  -- already deleted leaves both rolled back, which is exactly the property the
  -- application-code version had to simulate.
end;
$$;

create or replace function replace_google_tokens(
  p_access_token  text,
  p_refresh_token text,
  p_token_expiry  timestamptz,
  p_google_email  text
)
returns void
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  delete from google_tokens;
  insert into google_tokens (access_token, refresh_token, token_expiry, google_email)
  values (p_access_token, p_refresh_token, p_token_expiry, p_google_email);
end;
$$;

comment on function replace_xero_tokens(text, text, timestamptz, text, text) is
  'Swap the single xero_tokens row in ONE transaction. The callback used to '
  'delete then insert with neither result checked, so a failed insert destroyed '
  'a working connection and still redirected ?xero=connected. Readers use '
  '.single(), which errors on 0 rows AND on 2, so the count must never leave 1.';

revoke execute on function replace_xero_tokens(text, text, timestamptz, text, text) from public;
revoke execute on function replace_google_tokens(text, text, timestamptz, text) from public;
grant execute on function replace_xero_tokens(text, text, timestamptz, text, text) to authenticated;
grant execute on function replace_google_tokens(text, text, timestamptz, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Assert the end state.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('replace_line_items', 'replace_xero_tokens', 'replace_google_tokens');
  if n <> 3 then
    raise exception 'ASSERTION FAILED: expected 3 replace helpers, found %', n;
  end if;

  -- None of them may be SECURITY DEFINER. If one becomes definer it runs as the
  -- owner and RLS stops applying — a technician could then replace an invoice's
  -- line items through a function that exists only to make the write atomic.
  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in ('replace_line_items', 'replace_xero_tokens', 'replace_google_tokens')
    and p.prosecdef;
  if n <> 0 then
    raise exception 'ASSERTION FAILED: % replace helper(s) are SECURITY DEFINER — RLS would stop applying', n;
  end if;
end;
$$;

-- ============================================================================
-- VERIFY AFTER APPLYING
--
--   1. Nothing calls these yet, so behaviour must be unchanged. Edit an invoice
--      and confirm it still saves through lib/replace-line-items.ts.
--   2. Then, as a SEPARATE change, repoint the two modules at .rpc() and
--      re-run their tests — the contract is the same, only the mechanism
--      changes.
--   3. Impersonate a technician and call replace_line_items on an invoice.
--      It must be refused by RLS. If it succeeds, something made it definer.
-- ============================================================================
