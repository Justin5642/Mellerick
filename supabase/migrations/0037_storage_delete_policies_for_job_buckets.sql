-- =============================================
-- STORAGE DELETE POLICIES FOR job-photos AND job-audio
--
-- STATUS: PROPOSED (mobile/full-parity branch). NOT applied. The shared
-- `supabase/` schema and the live database are Jason's — he reviews and applies.
-- Do NOT auto-apply. See mobile/DECISIONS-FOR-AVI.md D12 / Q8.
--
-- THE LEAK: 0000_baseline.sql:327-333 created the private `job-photos` bucket
-- with only INSERT and SELECT policies on storage.objects, and
-- 0006_add_voice_reports.sql:26-32 did the same for `job-audio`. Storage deletes
-- are RLS-filtered per object, so with no DELETE policy
-- `supabase.storage.from('job-photos').remove([...])` is a SILENT NO-OP in BOTH
-- apps: the job_photos / voice-report row is deleted, but the underlying file
-- stays in the bucket forever. Every deleted photo and voice recording has been
-- accumulating as an orphaned object, billed as storage and still readable by any
-- authenticated user who knows the path.
--
-- Note `equipment-documents` (0023:78-80) ALREADY has the delete policy — this
-- migration simply brings the two older buckets up to that same standard.
--
-- Why `auth.role() = 'authenticated'` and not something tighter: it mirrors the
-- existing INSERT/SELECT policies on these buckets exactly (and 0023's DELETE),
-- so this changes ONLY the delete capability, introducing no new read surface.
-- These buckets hold job photos and voice notes — not money — and both apps
-- already authorize the *row* delete before ever calling storage.remove. If you
-- want per-object ownership scoping, that's a separate, larger change (the object
-- path would need to encode the owner).
--
-- After applying: the mobile outbox's best-effort `removeObject`
-- (mobile/lib/data/outbox/processor.ts, gateway.supabase.ts) starts actually
-- removing the object instead of being silently denied — no client change needed.
-- Consider a one-off cleanup of pre-existing orphans (objects with no matching
-- job_photos.storage_path), which this migration deliberately does NOT do.
-- =============================================

drop policy if exists "Authenticated users can delete job photos" on storage.objects;
create policy "Authenticated users can delete job photos"
  on storage.objects for delete
  using (bucket_id = 'job-photos' and auth.role() = 'authenticated');

drop policy if exists "Authenticated users can delete job audio" on storage.objects;
create policy "Authenticated users can delete job audio"
  on storage.objects for delete
  using (bucket_id = 'job-audio' and auth.role() = 'authenticated');
