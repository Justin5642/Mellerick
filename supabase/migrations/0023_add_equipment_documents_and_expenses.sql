-- =============================================
-- VEHICLE/EQUIPMENT DOCUMENTS + REAL EXPENSE & SERVICE HISTORY
-- Run this once in the Supabase SQL editor.
--
-- Purpose: migration 0016 only tracks *estimated* annual costs for a
-- vehicle (depreciation, insurance, rego, fuel -- used for the $/hour
-- job-costing figure). There was nowhere to keep the actual paperwork
-- (registration papers, insurance certificate, roadworthy, service
-- invoices) or a real dated log of what's actually been spent on a
-- specific vehicle (services, repairs, tyres, rego/insurance renewals).
-- This gives each vehicle its own "folder" the same way a job already has
-- job_documents + job_expenses.
--
-- Mirrors the job_documents / job_expenses shape and the job-documents
-- storage bucket pattern (private bucket, authenticated users can
-- upload/view/delete) so the existing upload/download/delete UI code can
-- be reused almost unchanged for equipment.
-- =============================================

create table if not exists equipment_documents (
  id uuid default uuid_generate_v4() primary key,
  equipment_id uuid references equipment(id) on delete cascade not null,
  uploaded_by uuid references profiles(id),
  storage_path text not null,
  file_name text not null,
  file_size bigint,
  file_type text,
  created_at timestamptz default now()
);

alter table equipment_documents enable row level security;
create index if not exists equipment_documents_equipment_id_idx on equipment_documents(equipment_id);
create policy "Authenticated users can manage equipment documents" on equipment_documents for all using (auth.role() = 'authenticated');

comment on table equipment_documents is
  'Files attached to a specific vehicle/piece of equipment -- registration papers, insurance certificate, roadworthy/compliance certs, service invoices. Stored in the equipment-documents bucket (private, path prefixed by equipment_id).';

create table if not exists equipment_expenses (
  id uuid default uuid_generate_v4() primary key,
  equipment_id uuid references equipment(id) on delete cascade not null,
  category text not null default 'service'
    check (category in ('service', 'repair', 'fuel', 'tyres', 'registration', 'insurance', 'other')),
  supplier_name text,
  description text,
  invoice_number text,
  expense_date date not null default current_date,
  amount numeric(10,2) not null default 0,
  gst_amount numeric(10,2) not null default 0,
  receipt_storage_path text,
  logged_by uuid references profiles(id),
  created_at timestamptz default now()
);

alter table equipment_expenses enable row level security;
create index if not exists equipment_expenses_equipment_id_idx on equipment_expenses(equipment_id);
create index if not exists equipment_expenses_expense_date_idx on equipment_expenses(expense_date);
create policy "Authenticated users can manage equipment expenses" on equipment_expenses for all using (auth.role() = 'authenticated');

comment on table equipment_expenses is
  'Actual dated spend against a specific vehicle/equipment item -- servicing, repairs, tyres, fuel, rego and insurance renewals -- as distinct from equipment.* which holds estimated annual figures used for the $/hour job-costing calculation. This is the real service/expense history for the item.';
comment on column equipment_expenses.category is 'service = routine servicing, repair = unplanned fix, tyres, fuel, registration = rego renewal payment, insurance = premium payment, other.';

-- =============================================
-- STORAGE BUCKET FOR EQUIPMENT DOCUMENTS (+ EXPENSE RECEIPTS)
-- =============================================
insert into storage.buckets (id, name, public)
values ('equipment-documents', 'equipment-documents', false)
on conflict (id) do nothing;

create policy "Authenticated users can upload equipment documents"
  on storage.objects for insert
  with check (bucket_id = 'equipment-documents' and auth.role() = 'authenticated');

create policy "Authenticated users can view equipment documents"
  on storage.objects for select
  using (bucket_id = 'equipment-documents' and auth.role() = 'authenticated');

create policy "Authenticated users can delete equipment documents"
  on storage.objects for delete
  using (bucket_id = 'equipment-documents' and auth.role() = 'authenticated');
