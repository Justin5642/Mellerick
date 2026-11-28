-- ============================================================================
-- Supplier credit notes against a supplier PO.
--
-- STATUS: applied 2026-11-28 (gate test passed). Was: paste this file into the Supabase SQL
-- editor, then supabase/tests/0125_vendor_order_credits_test.sql, and trust
-- only its final "0125 PASSED" row. Then change this line to applied, add the
-- ledger row ('0125','vendor_order_credits') and regenerate types. No
-- PowerSync redeploy: nothing here is in any stream.
--
-- WHY (Justin, 28 Nov 2026): the Gmail import (0124) sent every supplier
-- credit note to "needs review" for hand entry. A credit note that quotes one
-- of our PO-… numbers whose order already has its invoice is now offered to
-- the office as "Credit note for PO-1234 — $X" with one click, Apply credit
-- to PO. Never applied by itself: the office confirms.
--
-- WHERE IT IS KEPT. vendor_orders holds ONE invoice (number, date, amount,
-- GST, file). A credit must not overwrite that, nor be lost in it, so each
-- credit is its own row here, under its order. The Job Ledger nets an order's
-- credits off that order's cost (lib/job-ledger.ts), and the PO tab lists
-- them under the order. Credits are NOT sent to Xero by the app: the office
-- enters the credit note in Xero (the screen says so).
--
-- WHAT THIS ADDS
--   vendor_order_credits — one row per supplier credit note:
--     vendor_order_id  the order it credits (deleting the order deletes them)
--     gmail_invoice_id the emailed file it came from (0124), unique when set,
--                      so applying the same email twice adds one credit
--     credit_number, credit_date, amount_ex_gst (> 0), gst_amount (>= 0)
--     file_path        the copy filed on the job (job-documents,
--                      {job}/expense-receipt-{PO}-credit-…, so 0047's
--                      money-file rule hides it from technicians)
--     entered_by       forced to the caller by the guard trigger
--     created_at
--   Guard trigger: the order must exist, not be cancelled and already have
--   its invoice; the order's credits together may not exceed its invoice
--   amount; the same credit number twice on one order is refused.
--   MONEY → office/admin only: ONE FOR ALL policy on is_office_or_admin().
--   Granted explicitly to authenticated + service_role (0088: this project
--   does not expose new tables by itself), revoked from anon. In no
--   publication / PowerSync stream.
--
-- Idempotent. No temp tables (the SQL editor doesn't keep them between
-- statements — see 0117). Ends by asserting the end state.
-- ============================================================================

create table if not exists vendor_order_credits (
  id uuid primary key default gen_random_uuid(),
  vendor_order_id uuid not null references vendor_orders(id) on delete cascade,
  gmail_invoice_id uuid references gmail_supplier_invoices(id) on delete set null,
  credit_number text check (credit_number is null or char_length(credit_number) <= 100),
  credit_date date,
  amount_ex_gst numeric(12,2) not null check (amount_ex_gst > 0),
  gst_amount numeric(12,2) not null default 0 check (gst_amount >= 0),
  file_path text check (file_path is null or char_length(file_path) <= 500),
  entered_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists vendor_order_credits_order_idx on vendor_order_credits (vendor_order_id);
create unique index if not exists vendor_order_credits_gmail_uidx
  on vendor_order_credits (gmail_invoice_id) where gmail_invoice_id is not null;

-- ---------------------------------------------------------------- guard
create or replace function vendor_order_credits_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  o record;
  others numeric;
begin
  -- Who entered it is the caller, never what the client sent (the service
  -- role has no auth.uid() and keeps what it set).
  if tg_op = 'INSERT' then
    new.entered_by := coalesce(auth.uid(), new.entered_by);
  else
    new.entered_by := old.entered_by;
  end if;

  select id, status, invoice_number, amount into o from vendor_orders where id = new.vendor_order_id;
  if not found then
    raise exception 'That supplier PO was not found.' using errcode = '23514';
  end if;
  if o.status = 'cancelled' then
    raise exception 'That supplier PO was cancelled.' using errcode = '23514';
  end if;
  if o.invoice_number is null then
    raise exception 'That supplier PO has no invoice yet to credit.' using errcode = '23514';
  end if;

  select coalesce(sum(amount_ex_gst), 0) into others
    from vendor_order_credits
   where vendor_order_id = new.vendor_order_id and id <> new.id;
  if others + new.amount_ex_gst > coalesce(o.amount, 0) then
    raise exception 'The credits on that supplier PO would be more than its invoice.' using errcode = '23514';
  end if;

  if new.credit_number is not null and exists (
       select 1 from vendor_order_credits
        where vendor_order_id = new.vendor_order_id and id <> new.id
          and lower(btrim(credit_number)) = lower(btrim(new.credit_number))) then
    raise exception 'That credit note is already on that supplier PO.' using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists vendor_order_credits_guard on vendor_order_credits;
create trigger vendor_order_credits_guard
  before insert or update on vendor_order_credits
  for each row execute function vendor_order_credits_guard();

-- ---------------------------------------------------------------- RLS
alter table vendor_order_credits enable row level security;

-- Every policy goes (by enumeration, never by guessed name), then the one
-- office/admin policy.
do $$
declare p record;
begin
  for p in select polname from pg_policy where polrelid = 'public.vendor_order_credits'::regclass loop
    execute format('drop policy %I on public.vendor_order_credits', p.polname);
  end loop;
end;
$$;
create policy "Office/admin manage supplier credits" on vendor_order_credits for all
  to authenticated
  using (is_office_or_admin(auth.uid())) with check (is_office_or_admin(auth.uid()));

revoke all on vendor_order_credits from anon, public;
grant select, insert, update, delete on vendor_order_credits to authenticated;
grant all on vendor_order_credits to service_role;

comment on table vendor_order_credits is
  'Supplier credit notes against a supplier PO (0125). Netted off the order''s cost in the job ledger. Carries amounts: office/admin only. Not sent to Xero by the app.';
comment on column vendor_order_credits.gmail_invoice_id is
  'The emailed file (gmail_supplier_invoices, 0124) the credit came from; unique, so applying it twice adds one credit.';

-- ---------------------------------------------------------------- end state
do $$
declare
  n int;
  q text;
  c text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.vendor_order_credits'::regclass) then
    raise exception '0125: RLS is off on vendor_order_credits';
  end if;
  select count(*) into n from pg_policy where polrelid = 'public.vendor_order_credits'::regclass;
  if n <> 1 then raise exception '0125: vendor_order_credits has % policies, expected 1', n; end if;
  select pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid) into q, c
    from pg_policy where polrelid = 'public.vendor_order_credits'::regclass;
  if q is null or q not like '%is_office_or_admin%' or c is null or c not like '%is_office_or_admin%'
     or (select polcmd from pg_policy where polrelid = 'public.vendor_order_credits'::regclass) <> '*'
     or not (select polpermissive from pg_policy where polrelid = 'public.vendor_order_credits'::regclass) then
    raise exception '0125: the vendor_order_credits policy is not the office/admin FOR ALL policy';
  end if;

  if has_table_privilege('anon', 'public.vendor_order_credits', 'select')
     or has_table_privilege('anon', 'public.vendor_order_credits', 'insert')
     or has_table_privilege('anon', 'public.vendor_order_credits', 'update')
     or has_table_privilege('anon', 'public.vendor_order_credits', 'delete') then
    raise exception '0125: anon can reach vendor_order_credits';
  end if;
  if not (has_table_privilege('authenticated', 'public.vendor_order_credits', 'select')
          and has_table_privilege('authenticated', 'public.vendor_order_credits', 'insert')
          and has_table_privilege('authenticated', 'public.vendor_order_credits', 'delete')
          and has_table_privilege('service_role', 'public.vendor_order_credits', 'insert')) then
    raise exception '0125: a grant the app needs is missing';
  end if;

  if exists (select 1 from pg_publication_tables where tablename = 'vendor_order_credits') then
    raise exception '0125: vendor_order_credits is in a publication';
  end if;

  if not exists (select 1 from pg_trigger where tgname = 'vendor_order_credits_guard'
                  and tgrelid = 'public.vendor_order_credits'::regclass and tgenabled <> 'D') then
    raise exception '0125: the guard trigger is missing';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'vendor_order_credits_gmail_uidx'
                  and indexdef like 'CREATE UNIQUE INDEX%(gmail_invoice_id)%') then
    raise exception '0125: gmail_invoice_id is not unique';
  end if;
  -- The money sweep finds money columns by name: the amount must stay named so.
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'vendor_order_credits' and column_name = 'amount_ex_gst') then
    raise exception '0125: amount_ex_gst missing';
  end if;
end;
$$;

notify pgrst, 'reload schema';

select '0125 applied' as result;
