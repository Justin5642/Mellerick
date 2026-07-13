-- Adds audit columns to time_entries so manual corrections (edited by a
-- tech when auto clock-in/out fails to fire, or fires incorrectly) are
-- distinguishable from live auto-clock/manual-clock entries. This keeps the
-- payroll/efficiency reporting (staff_cost_profiles) trustworthy by making
-- it visible in the UI when a row has been hand-adjusted, and by whom.

alter table time_entries add column if not exists edited_by uuid references profiles(id);
alter table time_entries add column if not exists edited_at timestamptz;

comment on column time_entries.edited_by is
  'Profile of the staff member who last manually created or corrected this entry (edit/backdate flow), null if the row has only ever been set by the live clock-in/clock-out or auto-clock (geofence) flow.';
comment on column time_entries.edited_at is
  'Timestamp of the last manual create/edit via the edit/backdate flow, null if never manually touched.';
