-- ============================================================================
-- Approved hours reach the invoice; completed jobs always come back for approval.
--
-- STATUS: DRAFT — NOT APPLIED. Gate test:
-- supabase/tests/0098_hours_to_invoice_test.sql
--
-- WHY (bug report, 14 Nov 2026 — Garden World, job #505, and #2542): a
-- technician clocked hours, corrected them, and the job was approved, but the
-- invoice had no hours on it. Two separate faults:
--
--   1. Approval builds the invoice from job_items only. Hours used to reach
--      job_items as auto "Labour" lines (lib/labour-billing-sync.ts), but that
--      was switched off company-wide in 0086 (31 Oct 2026). Since then nothing
--      carried time_entries onto an invoice at all. #2542 was approved today,
--      found no line items, created no invoice, and its 8.9h stayed behind.
--
--   2. Nothing ever puts a job back to admin_status = 'pending' when it is
--      completed. 'pending' is only the column DEFAULT on insert, and 0074
--      forbids technicians from changing admin_status. So:
--        * the ~500 Simpro-imported jobs (inserted as 'approved') skip the
--          Approvals screen when a technician reuses and completes one — that
--          is what happened to Garden World (#505);
--        * a job SENT BACK ('rejected') and then completed again stays
--          'rejected' and never reappears for approval (#2539 today).
--
-- WHAT THIS ADDS
--   * time_entries.invoice_id — the invoice these hours are billed on. Set
--     only by apply_invoice_hours() below. Null = not billed yet, which is
--     what the invoice screen and the Approvals screen show as hours to bill.
--     Linked to the INVOICE, not a line: the invoice edit screen replaces
--     every line on save (lib/replace-line-items.ts), so line ids do not last.
--   * invoice_items.source — 'hours' on lines built from time entries, so a
--     re-apply replaces exactly those lines. The edit screen carries it through.
--   * apply_invoice_hours(invoice, lines) — one transaction: drop this
--     invoice's previous hours lines, insert the new ones, link the entries,
--     recompute the invoice totals from the lines that landed. Office/admin only.
--   * Billed entries locked: the 0074 lock (technicians cannot change a billed
--     entry) also counts time_entries.invoice_id, and only office/admin may
--     set or change invoice_id.
--   * A job completed by a signed-in user goes back to admin_status 'pending'.
--     Service-role writes (the Simpro import scripts) are left alone, so
--     history is not re-queued.
--
-- DATA: puts #505 and #2542 back in the Approvals queue (Justin, 14 Nov 2026:
-- "leave both, I'll fix" — their entries overlap 10:32am–1:00pm and he will
-- correct them before approving). Matched by id AND by still being approved
-- with no invoice, so it is a no-op anywhere else, including CI.
-- ============================================================================

-- 1. Columns ------------------------------------------------------------------

alter table time_entries
  add column if not exists invoice_id uuid references invoices(id) on delete set null;

comment on column time_entries.invoice_id is
  'Invoice these hours are billed on (0098). Set only by apply_invoice_hours(). Null = not billed yet. Cleared if the invoice is deleted.';

create index if not exists time_entries_invoice_id_idx
  on time_entries (invoice_id) where invoice_id is not null;
create index if not exists time_entries_unbilled_work_idx
  on time_entries (job_id) where invoice_id is null and entry_type = 'work';

alter table invoice_items
  add column if not exists source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoice_items_source_check') then
    alter table invoice_items add constraint invoice_items_source_check
      check (source is null or source in ('hours'));
  end if;
end;
$$;

comment on column invoice_items.source is
  'Where the line came from (0098). ''hours'' = built from time entries by apply_invoice_hours(); null = typed or picked by hand.';

-- time_entries uses column-level SELECT grants (0045/0046): a new column is
-- invisible to the apps until this runs.
select reapply_time_entries_grants();

-- 2. Billed entries: technicians cannot change them, and cannot bill them -----

create or replace function enforce_and_audit_time_entry_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  is_user boolean := auth.role() is not distinct from 'authenticated';
begin
  -- Billed entries: only office/admin. Billed = an auto Labour line points at
  -- it (job_items.time_entry_id, 0024) or it is on an invoice (0098).
  if is_user
     and not is_office_or_admin(auth.uid())
     and (old.invoice_id is not null
          or exists (select 1 from job_items where time_entry_id = old.id)) then
    raise exception 'this time entry has been billed — ask the office to change it'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new is not distinct from old then
      return new;
    end if;
    if is_user and (new.clock_in is distinct from old.clock_in
                    or new.clock_out is distinct from old.clock_out
                    or new.hours is distinct from old.hours) then
      new.edited_by := auth.uid();
      new.edited_at := now();
    end if;
    insert into time_entry_changes (time_entry_id, operation, changed_by, old_row, new_row)
    values (old.id, 'UPDATE', auth.uid(), to_jsonb(old) - 'rate_override', to_jsonb(new) - 'rate_override');
    return new;
  end if;

  insert into time_entry_changes (time_entry_id, operation, changed_by, old_row, new_row)
  values (old.id, 'DELETE', auth.uid(), to_jsonb(old) - 'rate_override', null);
  return old;
end;
$$;

create or replace function enforce_time_entry_invoice_link()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;
  if is_office_or_admin(auth.uid()) then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.invoice_id is not null)
     or (tg_op = 'UPDATE' and new.invoice_id is distinct from old.invoice_id) then
    raise exception 'only the office can put hours on an invoice'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists time_entries_invoice_link_office_only on time_entries;
create trigger time_entries_invoice_link_office_only
  before insert or update on time_entries
  for each row execute function enforce_time_entry_invoice_link();

-- 3. Bill hours onto an invoice, in one transaction ---------------------------
--
-- p_lines: [{ "name", "description", "quantity", "unit_price", "entry_ids": [uuid] }]
-- The app groups the entries (cost centre x technician) and prices them; this
-- function makes the write atomic and refuses anything that would bill the
-- same hours twice or bill another job's hours. An empty array un-bills.

create or replace function apply_invoice_hours(p_invoice_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inv record;
  line jsonb;
  ids uuid[];
  n int;
  n_lines int := 0;
  n_linked int := 0;
  qty numeric;
  price numeric;
  v_sub numeric;
  v_tax numeric;
begin
  if not is_office_or_admin(auth.uid()) then
    raise exception 'only office or admin can bill hours' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines must be a list' using errcode = '22023';
  end if;

  select id, job_id, status into inv from invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0002';
  end if;
  if inv.job_id is null then
    raise exception 'this invoice is not linked to a job, so it has no hours to bill' using errcode = '22023';
  end if;
  if inv.status in ('paid', 'cancelled') then
    raise exception 'this invoice is %, so its lines can no longer change', inv.status using errcode = '22023';
  end if;

  delete from invoice_items where invoice_id = p_invoice_id and source = 'hours';
  update time_entries set invoice_id = null where invoice_id = p_invoice_id;

  for line in select value from jsonb_array_elements(p_lines) loop
    select coalesce(array_agg(x::uuid), '{}') into ids from jsonb_array_elements_text(coalesce(line->'entry_ids', '[]'::jsonb)) as x;
    if cardinality(ids) = 0 then
      raise exception 'every hours line needs at least one time entry' using errcode = '22023';
    end if;

    qty := (line->>'quantity')::numeric;
    price := (line->>'unit_price')::numeric;
    if qty is null or qty <= 0 or price is null or price < 0 or coalesce(btrim(line->>'name'), '') = '' then
      raise exception 'each hours line needs a name, hours above zero and a rate of zero or more' using errcode = '22023';
    end if;

    select count(*) into n
    from time_entries
    where id = any(ids)
      and job_id = inv.job_id
      and entry_type = 'work'
      and clock_out is not null
      and invoice_id is null;
    if n <> cardinality(ids) then
      raise exception 'some of these hours are not on this job, are still clocked on, or are already on another invoice — reload and try again'
        using errcode = '22023';
    end if;

    insert into invoice_items (invoice_id, name, description, quantity, unit_price, source)
    values (p_invoice_id, btrim(line->>'name'), nullif(btrim(coalesce(line->>'description', '')), ''), qty, price, 'hours');

    update time_entries set invoice_id = p_invoice_id where id = any(ids);
    get diagnostics n = row_count;
    n_linked := n_linked + n;
    n_lines := n_lines + 1;
  end loop;

  -- Same rounding as lib/replace-line-items.ts moneyTotals(): each line to the
  -- cent, then GST on the subtotal.
  select coalesce(sum(round(coalesce(quantity, 1) * unit_price, 2)), 0) into v_sub
  from invoice_items where invoice_id = p_invoice_id;
  v_tax := round(v_sub * 0.1, 2);
  update invoices set subtotal = v_sub, tax_amount = v_tax, total = v_sub + v_tax where id = p_invoice_id;

  return jsonb_build_object(
    'lines', n_lines,
    'entries', n_linked,
    'subtotal', v_sub,
    'tax', v_tax,
    'total', v_sub + v_tax
  );
end;
$$;

revoke execute on function apply_invoice_hours(uuid, jsonb) from public, anon;
grant execute on function apply_invoice_hours(uuid, jsonb) to authenticated;
revoke execute on function enforce_time_entry_invoice_link() from public, anon, authenticated;
revoke execute on function enforce_and_audit_time_entry_change() from public, anon, authenticated;

-- 4. Completing a job sends it (back) to Approvals -----------------------------
--
-- Named so it fires AFTER jobs_office_columns (0074): BEFORE triggers run in
-- name order, and that guard must see the technician's own write, not this
-- function's change to admin_status, or every completion would be refused.

create or replace function requeue_job_for_approval_on_complete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;
  if new.status = 'completed'
     and old.status is distinct from 'completed'
     and new.admin_status is distinct from 'pending' then
    new.admin_status := 'pending';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_requeue_on_complete on jobs;
create trigger jobs_requeue_on_complete
  before update of status on jobs
  for each row execute function requeue_job_for_approval_on_complete();

revoke execute on function requeue_job_for_approval_on_complete() from public, anon, authenticated;

-- 5. Data: #505 Garden World and #2542 back to Approvals ------------------------

update jobs
set admin_status = 'pending'
where id in ('65aa454a-2839-48d2-9061-8c215607c9c2', '1e49b146-445c-424a-941d-39fcd99c3453')
  and status = 'completed'
  and admin_status = 'approved'
  and not exists (select 1 from invoices i where i.job_id = jobs.id);

notify pgrst, 'reload schema';
