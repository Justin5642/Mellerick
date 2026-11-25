-- ============================================================================
-- Customer billing address (on invoices and quotes) and job document folders.
--
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-11-25, via SQL editor; gate test passed; confirmed by a read-only check). An earlier note said "applied 2026-11-21" — that was wrong.
-- Ledger row, if not yet recorded:
--   insert into supabase_migrations.schema_migrations (version,name)
--   values ('0114','customer_address_doc_folders') on conflict do nothing;
-- Safe to merge the app before this is applied: every reader retries without
-- the new columns on 42703 / PGRST204, the customer forms hide or drop the
-- address, and the Documents tab lists everything under "Other".
--
-- WHY (Justin's notebook list, 20 Nov 2026):
--   * "Customer address on invoices." customers had no address at all, so an
--     invoice or quote named the business and nothing else.
--       customers.billing_address  text, multi-line, at most 500 characters.
--     Printed under the billed name on invoice and quote PDFs and shown on
--     their detail pages. Blank = no address (the job's site is NOT used).
--   * "Document folders." A job's documents were one long list.
--       job_documents.folder  'site_documents' | 'drainage' | 'plumbing' |
--                             'soil', or NULL = "Other" (every legacy row).
--     Who may set it is unchanged: the 0065 / 0074 policies on job_documents
--     (office-only documents stay office/admin; crew only on jobs they can
--     manage).
--
-- NO MONEY: neither column name matches the money sweep's regex (asserted).
-- No new table, so no new grant: customers and job_documents are granted at
-- table level, which covers a new column (asserted below).
-- PowerSync: job_documents is in no stream; customers' streams list their
-- columns and do NOT gain billing_address (the phone reads it online), so
-- no sync-rule redeploy is needed.
-- ============================================================================

alter table customers add column if not exists billing_address text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.customers'::regclass
       and conname = 'customers_billing_address_length'
  ) then
    alter table customers
      add constraint customers_billing_address_length
      check (billing_address is null or char_length(billing_address) <= 500);
  end if;
end $$;

comment on column customers.billing_address is
  'Postal/billing address printed under the billed name on invoices and quotes (multi-line, <= 500 chars). 0114.';

alter table job_documents add column if not exists folder text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.job_documents'::regclass
       and conname = 'job_documents_folder_check'
  ) then
    alter table job_documents
      add constraint job_documents_folder_check
      check (folder is null or folder in ('site_documents', 'drainage', 'plumbing', 'soil'));
  end if;
end $$;

comment on column job_documents.folder is
  'Documents tab folder: site_documents | drainage | plumbing | soil; NULL = Other. 0114.';

-- ---------------------------------------------------------------------------
-- End state, asserted (a paste that silently did nothing must fail loudly).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'customers' and column_name = 'billing_address'
  ) then
    raise exception '0114: customers.billing_address is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'job_documents' and column_name = 'folder'
  ) then
    raise exception '0114: job_documents.folder is missing';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.customers'::regclass and conname = 'customers_billing_address_length') then
    raise exception '0114: the billing address length check is missing';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.job_documents'::regclass and conname = 'job_documents_folder_check') then
    raise exception '0114: the folder check is missing';
  end if;
  -- Signed-in users can read and write the new columns (RLS still decides rows).
  if not has_column_privilege('authenticated', 'public.customers', 'billing_address', 'SELECT')
     or not has_column_privilege('authenticated', 'public.customers', 'billing_address', 'UPDATE') then
    raise exception '0114: authenticated cannot read/update customers.billing_address';
  end if;
  if not has_column_privilege('authenticated', 'public.job_documents', 'folder', 'SELECT')
     or not has_column_privilege('authenticated', 'public.job_documents', 'folder', 'UPDATE') then
    raise exception '0114: authenticated cannot read/update job_documents.folder';
  end if;
  -- Neither column is money-named (money_boundary_sweep.sql's regex).
  if exists (
    select 1 from (values ('billing_address'), ('folder')) v(c)
     where v.c ~* ('(rate|cost|price|amount|total|sell|margin|markup|hourly|salary|wage|charge'
                || '|fee|value|balance|paid|owing|gst|deposit|discount|surcharge|levy'
                || '|insurance|maintenance|registration|annual|subtotal|invoice_total)')
  ) then
    raise exception '0114: a new column is money-named';
  end if;
end $$;
