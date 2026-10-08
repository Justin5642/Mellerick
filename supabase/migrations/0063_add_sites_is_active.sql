-- Soft-delete ("archive") for customer sites — resolves Q17.
-- jobs.site_id and quotes.site_id reference sites with NO ACTION, so a site
-- that has ever had a job or quote can't be hard-deleted. Archiving hides the
-- site from lists and pickers while every existing job/quote keeps its link.
-- STATUS: DRAFT — NOT APPLIED. Apply to production BEFORE merging the app code
-- that reads this column, then redeploy PowerSync sync streams.
alter table sites add column if not exists is_active boolean not null default true;
