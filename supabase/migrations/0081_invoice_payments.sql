-- ============================================================================
-- Record payments against invoices that are not in Xero.
--
-- STATUS: DRAFT — NOT APPLIED. Apply, then run
-- supabase/tests/0081_invoice_payments_test.sql.
--
-- WHY
-- Payment tracking was built around Xero: an invoice pushed to Xero is marked
-- paid by the app's poll once Xero has it reconciled (lib/xero.ts). An invoice
-- that never went to Xero, or a cash payment, had no way to be recorded at all
-- — the invoice sat on "sent" for ever, and "what's owed to us" was a guess
-- (Justin, 19 Oct 2026).
--
-- THE RULES
--   * A payment is an amount, the day it was received, how (bank transfer,
--     cash, card, cheque, other), and an optional reference. Office/admin only:
--     this is money, like invoices themselves (0027).
--   * invoices.amount_paid = the sum of its payments. When that reaches the
--     total the invoice is "paid" (paid_at = the last payment's day); taking a
--     payment away puts a manually-paid invoice back to "sent", or "overdue"
--     when its due date has passed.
--   * An invoice IN XERO (xero_invoice_id set) refuses manual payments. Xero
--     is the record there; recording the same money twice is exactly the
--     double count this exists to avoid. The app's Xero poll keeps those
--     invoices' amount_paid and status current instead.
-- ============================================================================

create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  paid_on date not null default current_date,
  method text not null default 'bank_transfer'
    check (method in ('bank_transfer', 'cash', 'card', 'cheque', 'other')),
  reference text,
  notes text,
  recorded_by uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists invoice_payments_invoice_idx on invoice_payments (invoice_id, paid_on);

alter table invoice_payments enable row level security;

drop policy if exists "invoice payments: office/admin" on invoice_payments;
create policy "invoice payments: office/admin" on invoice_payments for all to authenticated
  using ((select is_office_or_admin(auth.uid())))
  with check ((select is_office_or_admin(auth.uid())));

revoke all on invoice_payments from anon;

-- Xero invoices take no manual payments.
create or replace function invoice_payments_refuse_xero()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from invoices where id = new.invoice_id and xero_invoice_id is not null) then
    raise exception 'This invoice is in Xero — record the payment in Xero; the app picks it up from there.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists invoice_payments_refuse_xero on invoice_payments;
create trigger invoice_payments_refuse_xero
  before insert or update on invoice_payments
  for each row execute function invoice_payments_refuse_xero();

-- Keep the invoice's amount_paid / status / paid_at in step with its payments.
create or replace function invoice_payments_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice uuid := coalesce(new.invoice_id, old.invoice_id);
  v_paid numeric(10,2);
  v_last date;
  inv record;
begin
  select * into inv from invoices where id = v_invoice;
  if not found or inv.xero_invoice_id is not null then
    return null;
  end if;

  select coalesce(sum(amount), 0), max(paid_on) into v_paid, v_last
    from invoice_payments where invoice_id = v_invoice;

  if inv.total is not null and v_paid >= inv.total and v_paid > 0 then
    update invoices
       set amount_paid = v_paid, status = 'paid', paid_at = v_last::timestamptz
     where id = v_invoice;
  else
    update invoices
       set amount_paid = v_paid,
           paid_at = null,
           status = case
             when inv.status <> 'paid' then inv.status
             when inv.due_date is not null and inv.due_date < current_date then 'overdue'
             else 'sent'
           end
     where id = v_invoice;
  end if;
  return null;
end;
$$;

drop trigger if exists invoice_payments_apply on invoice_payments;
create trigger invoice_payments_apply
  after insert or update or delete on invoice_payments
  for each row execute function invoice_payments_apply();

revoke execute on function invoice_payments_refuse_xero() from public, anon, authenticated;
revoke execute on function invoice_payments_apply() from public, anon, authenticated;

do $$
begin
  if has_table_privilege('anon', 'public.invoice_payments', 'select') then
    raise exception 'ASSERTION FAILED: anon can read invoice_payments';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal
        and tgname in ('invoice_payments_refuse_xero', 'invoice_payments_apply')) <> 2 then
    raise exception 'ASSERTION FAILED: invoice payment triggers missing';
  end if;
end;
$$;
