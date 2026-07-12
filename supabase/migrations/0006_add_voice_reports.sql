-- =============================================
-- JOB COMPLETION VOICE REPORTS
-- Run this once in the Supabase SQL editor.
--
-- Purpose: implements CRM spec item "Job Completion and Voice Report".
-- A tech can record a short voice report on job completion; it's
-- uploaded to the (already-created) private "job-audio" Storage bucket
-- and transcribed server-side via OpenAI's Whisper API
-- (app/api/jobs/[id]/transcribe-voice-report). One report per job,
-- same single-record pattern as overtime_reason.
-- =============================================

alter table jobs add column if not exists voice_report_storage_path text;
alter table jobs add column if not exists voice_report_transcript text;
alter table jobs add column if not exists voice_report_recorded_by uuid references profiles(id);
alter table jobs add column if not exists voice_report_recorded_at timestamptz;

comment on column jobs.voice_report_storage_path is
  'Path within the private job-audio Storage bucket for this job''s completion voice report recording.';
comment on column jobs.voice_report_transcript is
  'AI-generated transcript (OpenAI Whisper) of the completion voice report, for office review without needing to listen to the audio.';

-- Storage RLS for the job-audio bucket (bucket itself already created via
-- scripts/create-job-audio-bucket.mjs, since buckets aren't manageable via
-- plain SQL migrations the same way tables are).
create policy "Authenticated users can upload job audio"
  on storage.objects for insert
  with check (bucket_id = 'job-audio' and auth.role() = 'authenticated');

create policy "Authenticated users can view job audio"
  on storage.objects for select
  using (bucket_id = 'job-audio' and auth.role() = 'authenticated');
