-- Soft-delete ("archive") for customer sites — resolves Q17.
-- jobs.site_id and quotes.site_id reference sites with NO ACTION, so a site
-- that has ever had a job or quote can't be hard-deleted. Archiving hides the
-- site from lists and pickers while every existing job/quote keeps its link.
-- STATUS: ✅ APPLIED IN PRODUCTION (2026-10-08, via SQL editor; ledger row
-- 0063 inserted by hand). PowerSync sync streams must also select is_active.
alter table sites add column if not exists is_active boolean not null default true;
