-- Two-way Google Calendar sync: store an incremental sync token so we can
-- pull only what changed (drag/resize/delete done directly in Google
-- Calendar) since the last poll, instead of re-scanning the whole calendar.
alter table google_tokens add column if not exists calendar_sync_token text;
alter table google_tokens add column if not exists calendar_last_synced_at timestamptz;

comment on column google_tokens.calendar_sync_token is
  'Google Calendar events.list syncToken — used for incremental pulls of external calendar edits back into jobs.';
comment on column google_tokens.calendar_last_synced_at is
  'Timestamp of the last successful pull-sync run (cron or manual), shown in Settings.';
