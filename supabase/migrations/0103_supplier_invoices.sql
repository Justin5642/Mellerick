-- ============================================================================
-- Supplier invoices: drop the day's PDFs in, the app reads them.
--
-- STATUS: DRAFT — NOT APPLIED. Gate test supabase/tests/0103_supplier_invoices_test.sql.
--
-- WHY (Justin, 15 Nov 2026): supplier invoices arrive at admin@ in batches,
-- one email with several PDFs. Instead of connecting the app to that inbox,
-- the office drags the batch onto Supplier POs → Supplier invoices each
-- afternoon. The app reads each PDF (Claude), and matching then puts each
-- invoice on its job: on the PO it quotes (PO-1001…), else as a job expense.
--
-- WHAT IT ADDS
--   bucket supplier-invoices   private; office/admin only. The PDFs are not
--       tied to a job when they arrive, so they can't live in job-documents.
--   supplier_invoices          one row per invoice READ from a file. A PDF
--       holding several invoices gives several rows (same storage_path,
--       index_in_file 0, 1, …). A statement gives one row of kind 'statement'.
--     status   reading → read | failed; read → costed | dismissed.
--              'costed' is set by matching (next migration/PR), not here.
--     file_sha256 + index_in_file unique: dropping the same file twice reads
--              it once.
--     duplicate_of: set when the same supplier + invoice number was already
--              read from a DIFFERENT file (a re-sent invoice) — shown, never
--              costed twice.
--   Office/admin only, like vendor_orders and job_expenses (0035/0061).
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('supplier-invoices', 'supplier-invoices', false)
on conflict (id) do nothing;

drop policy if exists "Office can upload supplier invoices" on storage.objects;
create policy "Office can upload supplier invoices"
  on storage.objects for insert
  with check (bucket_id = 'supplier-invoices' and is_office_or_admin(auth.uid()));

drop policy if exists "Office can view supplier invoices" on storage.objects;
create policy "Office can view supplier invoices"
  on storage.objects for select
  using (bucket_id = 'supplier-invoices' and is_office_or_admin(auth.uid()));

drop policy if exists "Office can delete supplier invoices" on storage.objects;
create policy "Office can delete supplier invoices"
  on storage.objects for delete
  using (bucket_id = 'supplier-invoices' and is_office_or_admin(auth.uid()));

create table if not exists supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  file_name text not null,
  file_sha256 text not null,
  index_in_file integer not null default 0 check (index_in_file >= 0),
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now(),

  status text not null default 'reading'
    check (status in ('reading', 'read', 'failed', 'costed', 'dismissed')),
  read_error text,

  doc_kind text check (doc_kind in ('invoice', 'credit_note', 'statement', 'other')),
  supplier_name text,
  supplier_abn text,
  invoice_number text,
  invoice_date date,
  amount_ex_gst numeric(12,2),
  gst_amount numeric(12,2),
  total numeric(12,2),
  -- What the invoice quotes, as printed: order numbers, job numbers, site.
  po_refs text[] not null default '{}',
  job_refs text[] not null default '{}',
  site_text text,
  -- The reader's full answer, kept for checking a wrong match later.
  extracted jsonb,

  duplicate_of uuid references supplier_invoices(id) on delete set null,

  -- Filled by matching (next PR). Kept here so this table is the record.
  vendor_order_id uuid references vendor_orders(id) on delete set null,
  job_id uuid references jobs(id) on delete set null,
  job_expense_id uuid references job_expenses(id) on delete set null,
  costed_by uuid references profiles(id),
  costed_at timestamptz
);

create unique index if not exists supplier_invoices_file_part_uidx
  on supplier_invoices (file_sha256, index_in_file);
create index if not exists supplier_invoices_status_idx
  on supplier_invoices (status, created_at desc);
create index if not exists supplier_invoices_number_idx
  on supplier_invoices (lower(invoice_number)) where invoice_number is not null;

alter table supplier_invoices enable row level security;
drop policy if exists "Office/admin manage supplier invoices" on supplier_invoices;
create policy "Office/admin manage supplier invoices" on supplier_invoices for all
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

comment on table supplier_invoices is
  'Supplier invoices read from PDFs the office uploads (0103). One row per invoice found in a file. Office/admin only.';
comment on column supplier_invoices.duplicate_of is
  'The earlier row with the same supplier and invoice number from a different file (0103). Never costed twice.';

notify pgrst, 'reload schema';
