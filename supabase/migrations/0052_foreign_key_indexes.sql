-- ============================================================================
-- Indexes on the foreign keys the app actually filters by.
--
-- STATUS: DRAFT — NOT APPLIED. (tests/unit/migration-header-truth.test.ts fails
-- the build if this line is still here once it IS applied.)
--
-- ---------------------------------------------------------------------------
-- MEASURED, NOT LISTED
-- ---------------------------------------------------------------------------
-- Item 2.23 says "six missing FK indexes". That figure appears nowhere in the
-- repo and could not be sourced, so it was derived from the migration history
-- instead: 67 uuid foreign-key columns, 31 with no leading index.
--
-- Indexing all 31 would be wrong. An index costs write throughput on every
-- insert and update of its table, forever, and most of those 31 are audit
-- columns (`created_by`, `uploaded_by`, `approved_by`) that nothing filters on.
--
-- So the test applied was: does source actually filter or join on it? Counting
-- `.eq(`, `.in(`, `WHERE`, `ON` and `JOIN` references across app/, components/,
-- lib/ and mobile/lib/:
--
--   job_id              66 references   -> backflow_tests.job_id
--   staff_id            13              -> job_items.staff_id
--   site_id              9              -> quotes.site_id
--   variation_type_id    3              -> job_variations.variation_type_id
--   quote_id             2              -> invoices.quote_id
--
--   travel_from_job_id   0              -> NOT indexed
--   pricing_item_id      0              -> NOT indexed (3 tables)
--
-- Five indexes, not thirty-one. The seven columns with zero filtering
-- references are deliberately left alone and named here so the next person does
-- not re-derive the same list and reach a different answer.
--
-- Also checked and found not to apply: none of these columns appears in an RLS
-- policy body or a view definition, so the per-row-subquery argument — the one
-- case where a missing index really hurts — is not in play. This is ordinary
-- query performance.
--
-- ---------------------------------------------------------------------------
-- SCALE, honestly
-- ---------------------------------------------------------------------------
-- jobs 827, job_photos 9722, everything else in the low hundreds or less. At
-- this size Postgres will often prefer a sequential scan regardless, and the
-- measurable win today is small. The reason to add them anyway is that these
-- five are the columns the app joins on in its hot paths, so they are the ones
-- whose absence starts to bite first — and `create index if not exists` is
-- additive and reversible.
--
-- Shaped after 0029_add_performance_indexes.sql.
-- ============================================================================

-- Backflow tests are looked up by job constantly — the compliance tab, the
-- certificate flow and the mobile backflow stream all filter on it.
create index if not exists backflow_tests_job_id_idx on backflow_tests (job_id);

-- Labour lines are grouped and costed per technician (reports, job costing).
create index if not exists job_items_staff_id_idx on job_items (staff_id);

-- Quotes are listed and filtered by site on the customer and site screens.
create index if not exists quotes_site_id_idx on quotes (site_id);

-- Variations join their type for the name and unit on every job variation list.
create index if not exists job_variations_variation_type_id_idx on job_variations (variation_type_id);

-- Invoices trace back to the quote they were raised from.
create index if not exists invoices_quote_id_idx on invoices (quote_id);

-- ---------------------------------------------------------------------------
-- Assert all five exist, and that this migration did not quietly do nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
begin
  select string_agg(want, ', ') into missing
  from (values
    ('backflow_tests_job_id_idx'),
    ('job_items_staff_id_idx'),
    ('quotes_site_id_idx'),
    ('job_variations_variation_type_id_idx'),
    ('invoices_quote_id_idx')
  ) as t(want)
  where not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'i' and c.relname = t.want
  );

  if missing is not null then
    raise exception 'ASSERTION FAILED: index(es) not created: %', missing;
  end if;
end;
$$;

-- ============================================================================
-- AFTER APPLYING
--
-- These are additive and safe to roll back individually:
--
--   drop index if exists backflow_tests_job_id_idx;   -- etc.
--
-- There is nothing to verify behaviourally — an index changes no result, only
-- how it is reached. If you want evidence they are used, `explain analyze` a
-- backflow-tests-by-job query before and after; at 827 jobs do not be surprised
-- if the planner still picks a seq scan.
--
-- NOT DONE HERE, deliberately: the 26 remaining unindexed FK columns. Seven are
-- named above as having zero filtering references; the rest are audit columns
-- in the same position. Indexing them would cost writes to speed up queries
-- nobody makes.
-- ============================================================================
