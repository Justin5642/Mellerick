-- ============================================================================
-- REGRESSION TEST for 0093 — docket photos linked to supplier POs.
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/0093_docket_photos_test.sql
--   or paste the whole file into the Supabase SQL editor.
--
-- ONE DO BLOCK, SELF-UNDOING — see the 0073 test's header.
-- ============================================================================

do $$
declare
  res text[] := '{}';   -- 'scenario|expected|actual'
  j uuid;
  cc uuid;
  vo uuid := gen_random_uuid();
  ph uuid := gen_random_uuid();
  line text;
  parts text[];
  failures text := '';
  n_fail int := 0;
begin
  begin
    res := res || format('signed-in can read job_photos.vendor_order_id|t|%s',
      has_column_privilege('authenticated', 'public.job_photos', 'vendor_order_id', 'select'));
    res := res || format('signed-in can write job_photos.vendor_order_id|t|%s',
      has_column_privilege('authenticated', 'public.job_photos', 'vendor_order_id', 'insert'));

    select p.job_id, c.id into j, cc
    from po_cost_centers c join purchase_orders p on p.id = c.purchase_order_id
    limit 1;
    if j is null then
      raise exception 'fixture missing: need a job with a cost centre';
    end if;
    insert into vendor_orders (id, job_id, cost_center_id, vendor_name, status)
      values (vo, j, cc, 'Test Supplier 0093', 'ordered');
    insert into job_photos (id, job_id, storage_path, photo_type, vendor_order_id)
      values (ph, j, j || '/' || ph || '.jpg', 'general', vo);
    res := res || format('docket links to its PO|t|%s', (select vendor_order_id = vo from job_photos where id = ph));

    delete from vendor_orders where id = vo;
    res := res || format('deleting the PO keeps the photo|1|%s', (select count(*) from job_photos where id = ph));
    res := res || format('and unlinks it|t|%s', (select vendor_order_id is null from job_photos where id = ph));

    raise exception using errcode = 'ZX001', message = 'undo test changes';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if coalesce(array_length(res, 1), 0) = 0 then
    raise exception 'test recorded no scenarios';
  end if;
  foreach line in array res loop
    parts := string_to_array(line, '|');
    if parts[2] is distinct from parts[3] then
      n_fail := n_fail + 1;
      failures := failures || format(E'\n  - %s: expected %s, got %s', parts[1], parts[2], parts[3]);
    end if;
  end loop;
  if n_fail > 0 then
    raise exception E'% of % scenario(s) FAILED — docket photos:%',
      n_fail, array_length(res, 1), failures;
  end if;
  raise notice 'all % scenarios passed', array_length(res, 1);
end;
$$;
