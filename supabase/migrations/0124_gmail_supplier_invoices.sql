-- ============================================================================
-- Supplier invoices from Gmail, filed against the job automatically.
--
-- STATUS: applied 2026-11-27 (gate test passed). Was: paste this file into the Supabase SQL editor,
-- then supabase/tests/0124_gmail_supplier_invoices_test.sql, and trust only
-- its final "0124 PASSED" row. Then change this line to applied, add the
-- ledger row ('0124','gmail_supplier_invoices') and regenerate types. No
-- PowerSync redeploy: nothing here is in any stream.
--
-- WHY (Justin, 27 Nov 2026): supplier bills reach the accounts mailbox and
-- are typed in by hand. He puts them in a Gmail LABEL ("Supplier invoices" by
-- default); the app reads new ones every hour (lib/gmail-invoices.ts), reads
-- each PDF / photo with Claude, and when it quotes one of our supplier POs
-- (PO-1234, vendor_orders.po_number) it puts the invoice on that PO for the
-- office to CHECK before "Send to Xero". Nothing is ever pushed to Xero by
-- itself. Anything it can't place goes to a review queue on Supplier POs.
--
-- WHAT THIS ADDS
--   1. gmail_supplier_invoices — one row per attachment of each email in the
--      label (an email with nothing readable gets one row, part_id '-', so it
--      is not looked at again and the office sees it). (gmail_message_id,
--      part_id) is unique: that is what makes the hourly import idempotent.
--      part_id is the attachment's MIME part id — Gmail's own attachmentId is
--      NOT stable between fetches, so it can't be the key.
--      status: new → matched (placed on a PO) | needs_review → dismissed.
--      Carries the amounts the reader saw → MONEY → office/admin only:
--      ONE FOR ALL policy on is_office_or_admin(). Granted explicitly to
--      authenticated + service_role (0088: this project does not expose new
--      tables by itself), revoked from anon. In no PowerSync stream.
--   2. gmail_invoice_settings — one row: the label name (office/admin may
--      change it — the only column they may write), whether the Google
--      connection allows reading mail, and the last run's state (written by
--      the service role only). Office/admin read.
--   3. vendor_orders.invoice_needs_check — true while an invoice on the PO
--      was filled in from an email and nobody has checked it yet. The PO tab
--      shows "from email — check"; /api/xero/push-vendor-order refuses to make
--      the bill until it is false. vendor_orders is granted at table level
--      (no column grants — 0061), so the column needs no grant; asserted.
--
-- Idempotent. No temp tables (the SQL editor doesn't keep them between
-- statements — see 0117). Ends by asserting the end state.
-- ============================================================================

-- 1. ----------------------------------------------------------------- imports
create table if not exists gmail_supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id text not null check (char_length(gmail_message_id) between 1 and 200),
  part_id text not null check (char_length(part_id) between 1 and 100),
  file_name text check (file_name is null or char_length(file_name) <= 300),
  mime_type text check (mime_type is null or char_length(mime_type) <= 100),
  received_at timestamptz,
  sender text check (sender is null or char_length(sender) <= 500),
  subject text check (subject is null or char_length(subject) <= 1000),
  -- The original file, in the office-only supplier-invoices bucket (0103).
  storage_path text check (storage_path is null or char_length(storage_path) <= 500),
  -- The copy filed on the job (job-documents, {job}/expense-receipt-{PO}-…,
  -- so 0047's money-file rule hides it from technicians).
  job_document_path text check (job_document_path is null or char_length(job_document_path) <= 500),

  status text not null default 'new'
    check (status in ('new', 'matched', 'needs_review', 'dismissed')),
  review_reason text check (review_reason is null or char_length(review_reason) <= 500),
  error text check (error is null or char_length(error) <= 500),

  -- What the reader saw (lib/supplier-invoice-read.ts), after validation.
  doc_kind text check (doc_kind is null or doc_kind in ('invoice', 'credit_note', 'statement', 'other')),
  supplier_name text check (supplier_name is null or char_length(supplier_name) <= 500),
  invoice_number text check (invoice_number is null or char_length(invoice_number) <= 100),
  invoice_date date,
  amount_ex_gst numeric(12,2),
  gst_amount numeric(12,2),
  total numeric(12,2),
  po_refs text[] not null default '{}',
  job_refs text[] not null default '{}',

  vendor_order_id uuid references vendor_orders(id) on delete set null,
  job_id uuid references jobs(id) on delete set null,
  handled_by uuid references profiles(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists gmail_supplier_invoices_message_part_uidx
  on gmail_supplier_invoices (gmail_message_id, part_id);
create index if not exists gmail_supplier_invoices_status_idx
  on gmail_supplier_invoices (status, created_at desc);
create index if not exists gmail_supplier_invoices_vendor_order_idx
  on gmail_supplier_invoices (vendor_order_id) where vendor_order_id is not null;

alter table gmail_supplier_invoices enable row level security;

-- Every permissive policy goes (by enumeration, never by guessed name), then
-- the one office/admin policy.
do $$
declare p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.gmail_supplier_invoices'::regclass loop
    execute format('drop policy %I on public.gmail_supplier_invoices', p.polname);
  end loop;
end;
$$;
create policy "Office/admin manage emailed supplier invoices" on gmail_supplier_invoices for all
  to authenticated
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

revoke all on gmail_supplier_invoices from anon, public;
grant select, insert, update, delete on gmail_supplier_invoices to authenticated;
grant all on gmail_supplier_invoices to service_role;

comment on table gmail_supplier_invoices is
  'Supplier invoices imported from the accounts Gmail label (0124). One row per attachment. Carries amounts: office/admin only.';
comment on column gmail_supplier_invoices.part_id is
  'The attachment''s MIME part id (stable). Gmail''s attachmentId changes between fetches, so it is not the key (0124).';

-- 2. ----------------------------------------------------------------- settings
create table if not exists gmail_invoice_settings (
  id boolean primary key default true check (id),
  label_name text not null default 'Supplier invoices'
    check (char_length(btrim(label_name)) between 1 and 100),
  gmail_allowed boolean,                 -- null = not known yet
  last_poll_at timestamptz,
  last_ok_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_message_at timestamptz,           -- the import's resume point
  last_imported integer,
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id) on delete set null
);
insert into gmail_invoice_settings (id) values (true) on conflict (id) do nothing;

alter table gmail_invoice_settings enable row level security;
do $$
declare p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.gmail_invoice_settings'::regclass loop
    execute format('drop policy %I on public.gmail_invoice_settings', p.polname);
  end loop;
end;
$$;
create policy "Office/admin read and set the Gmail label" on gmail_invoice_settings for all
  to authenticated
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

revoke all on gmail_invoice_settings from anon, public, authenticated;
grant select on gmail_invoice_settings to authenticated;
-- The label is the only thing a person sets; the run state is the service role's.
grant update (label_name, updated_at, updated_by) on gmail_invoice_settings to authenticated;
grant all on gmail_invoice_settings to service_role;

comment on table gmail_invoice_settings is
  'One row: the Gmail label supplier invoices are read from, and the hourly import''s state (0124). Office/admin read; only label_name is theirs to set.';

-- 3. ----------------------------------------------------------------- vendor_orders
alter table vendor_orders add column if not exists invoice_needs_check boolean not null default false;
comment on column vendor_orders.invoice_needs_check is
  'True while the invoice on this PO was filled in from an email (0124) and the office has not checked it. Send to Xero waits for it.';

-- 4. ----------------------------------------------------------------- end state
do $$
declare
  n int;
  q text;
  c text;
begin
  -- RLS on, exactly one policy, office/admin both ways.
  if not (select relrowsecurity from pg_class where oid = 'public.gmail_supplier_invoices'::regclass) then
    raise exception '0124: RLS is off on gmail_supplier_invoices';
  end if;
  select count(*) into n from pg_policy where polrelid = 'public.gmail_supplier_invoices'::regclass;
  if n <> 1 then raise exception '0124: gmail_supplier_invoices has % policies, expected 1', n; end if;
  select pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) into q, c
    from pg_policy where polrelid = 'public.gmail_supplier_invoices'::regclass;
  if q is null or q not like '%is_office_or_admin%' or c is null or c not like '%is_office_or_admin%'
     or (select polcmd from pg_policy where polrelid = 'public.gmail_supplier_invoices'::regclass) <> '*'
     or not (select polpermissive from pg_policy where polrelid = 'public.gmail_supplier_invoices'::regclass) then
    raise exception '0124: the gmail_supplier_invoices policy is not the office/admin FOR ALL policy';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.gmail_invoice_settings'::regclass) then
    raise exception '0124: RLS is off on gmail_invoice_settings';
  end if;
  select count(*) into n from pg_policy where polrelid = 'public.gmail_invoice_settings'::regclass;
  if n <> 1 then raise exception '0124: gmail_invoice_settings has % policies, expected 1', n; end if;
  select pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) into q, c
    from pg_policy where polrelid = 'public.gmail_invoice_settings'::regclass;
  if q not like '%is_office_or_admin%' or c not like '%is_office_or_admin%' then
    raise exception '0124: the gmail_invoice_settings policy is not office/admin';
  end if;
  if not exists (select 1 from gmail_invoice_settings where id) then
    raise exception '0124: the settings row is missing';
  end if;

  -- Grants: anon nothing; authenticated as intended; service_role everything.
  if has_table_privilege('anon', 'public.gmail_supplier_invoices', 'select')
     or has_table_privilege('anon', 'public.gmail_supplier_invoices', 'insert')
     or has_table_privilege('anon', 'public.gmail_invoice_settings', 'select')
     or has_table_privilege('anon', 'public.gmail_invoice_settings', 'update') then
    raise exception '0124: anon can reach the Gmail invoice tables';
  end if;
  if not (has_table_privilege('authenticated', 'public.gmail_supplier_invoices', 'select')
          and has_table_privilege('authenticated', 'public.gmail_supplier_invoices', 'update')
          and has_table_privilege('service_role', 'public.gmail_supplier_invoices', 'insert')
          and has_table_privilege('service_role', 'public.gmail_invoice_settings', 'update')
          and has_table_privilege('authenticated', 'public.gmail_invoice_settings', 'select')
          and has_column_privilege('authenticated', 'public.gmail_invoice_settings', 'label_name', 'update')) then
    raise exception '0124: a grant the app needs is missing';
  end if;
  if has_table_privilege('authenticated', 'public.gmail_invoice_settings', 'insert')
     or has_table_privilege('authenticated', 'public.gmail_invoice_settings', 'delete')
     or has_column_privilege('authenticated', 'public.gmail_invoice_settings', 'last_error', 'update')
     or has_column_privilege('authenticated', 'public.gmail_invoice_settings', 'gmail_allowed', 'update')
     or has_column_privilege('authenticated', 'public.gmail_invoice_settings', 'last_message_at', 'update') then
    raise exception '0124: signed-in users can write the Gmail import''s own state';
  end if;

  -- In no PowerSync publication.
  if exists (select 1 from pg_publication_tables
              where tablename in ('gmail_supplier_invoices', 'gmail_invoice_settings')) then
    raise exception '0124: a Gmail invoice table is in a publication';
  end if;

  -- The one uniqueness the import relies on.
  if not exists (select 1 from pg_indexes where indexname = 'gmail_supplier_invoices_message_part_uidx'
                  and indexdef like 'CREATE UNIQUE INDEX%(gmail_message_id, part_id)%') then
    raise exception '0124: (gmail_message_id, part_id) is not unique';
  end if;

  -- vendor_orders.invoice_needs_check, usable by the office.
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'vendor_orders' and column_name = 'invoice_needs_check'
                  and data_type = 'boolean' and is_nullable = 'NO') then
    raise exception '0124: vendor_orders.invoice_needs_check missing';
  end if;
  if not (has_column_privilege('authenticated', 'public.vendor_orders', 'invoice_needs_check', 'select')
          and has_column_privilege('authenticated', 'public.vendor_orders', 'invoice_needs_check', 'update')) then
    raise exception '0124: vendor_orders.invoice_needs_check is not granted to authenticated';
  end if;
end;
$$;

notify pgrst, 'reload schema';

select '0124 applied' as result;
