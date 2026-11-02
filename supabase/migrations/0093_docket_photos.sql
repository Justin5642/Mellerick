-- ============================================================================
-- Delivery docket photos, linked to the supplier PO they belong to.
--
-- STATUS: DRAFT, not applied yet.
--
-- WHY (Justin, 2 Nov 2026): most orders are phoned through or bought at the
-- counter, not itemised in the app. When the goods turn up the crew take a
-- photo of the docket instead, so the office can match it to the supplier's
-- invoice. The photo is an ordinary job photo (same bucket, same offline
-- upload, same RLS) that also names its PO.
--
--   job_photos.vendor_order_id   the PO this docket is for; null = an
--                                ordinary job photo. A PO deleted by the
--                                office leaves the photo on the job.
--
-- No grant needed: job_photos has no column-level grants, and the FK check
-- does not need the technician to be able to read vendor_orders (office-only
-- by RLS, 0061) — the PO id comes from /api/jobs/[id]/supplier-orders.
-- ============================================================================

alter table job_photos
  add column if not exists vendor_order_id uuid references vendor_orders(id) on delete set null;
create index if not exists job_photos_vendor_order_id_idx
  on job_photos (vendor_order_id) where vendor_order_id is not null;

comment on column job_photos.vendor_order_id is
  'The supplier PO this photo is the delivery docket for (0093). Null = an ordinary job photo.';

notify pgrst, 'reload schema';
