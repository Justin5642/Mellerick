-- Restores the `jobs.ready_to_invoice` column that BOTH apps already depend on
-- and that has never existed in the database.
--
-- HOW THIS WAS FOUND (2026-07-28): an open-question sweep flagged the column as
-- "prod drift"; querying the live database settled it —
--   select ready_to_invoice from jobs;
--   ERROR: 42703: column "ready_to_invoice" does not exist
-- and it appears in no migration in this tree.
--
-- WHAT IT BREAKS TODAY (production, both platforms):
--   web  app/dashboard/approvals/page.tsx:130,173   approve + send-back writes
--   web  app/dashboard/invoices/new/page.tsx:343    clearing the flag on invoice
--   web  components/job/job-signature.tsx:122       sign-off write
--   web  app/dashboard/invoices/page.tsx:16         the Ready-to-Invoice QUEUE read
--   mob  lib/data/repositories/signature.ts:79      sign-off  (dead-letters)
--   mob  lib/data/repositories/approvals.ts:55,68   approve + send-back
--   mob  lib/data/repositories/finance.ts:112       clearing the flag on invoice
--   mob  lib/data/reads/finance.ts:165,443          the same queue read
--
-- Postgres rejects an UPDATE/SELECT naming an unknown column outright, so these
-- are hard failures, not silent no-ops: the web surfaces an error and the mobile
-- outbox dead-letters the operation.
--
-- WHY ADD RATHER THAN REMOVE: both codebases treat the flag as the queue's
-- source of truth, and the web's invoice queue is built on it. Removing it would
-- mean redesigning that workflow on both platforms; adding the column restores
-- the behaviour every call site already assumes.
--
-- SAFETY: additive, nullable-with-default, no rewrite of existing semantics. A
-- backfill is deliberately NOT included — no historical signal exists to
-- reconstruct which completed jobs were awaiting invoicing, and guessing would
-- put phantom jobs in the office's queue. Existing rows start false; the flag
-- becomes accurate from the next sign-off onward.

alter table jobs
  add column if not exists ready_to_invoice boolean not null default false;

comment on column jobs.ready_to_invoice is
  'Set true when a job is signed off and awaiting invoicing; cleared once an invoice exists. Drives the office Ready-to-Invoice queue on web and mobile.';

-- The office/admin invoice queue filters on this constantly; an index keeps that
-- cheap as the jobs table grows (partial: only the true rows are ever queried).
create index if not exists jobs_ready_to_invoice_idx
  on jobs (ready_to_invoice)
  where ready_to_invoice;
