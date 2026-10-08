-- Tags a job_notes row with where it originated. Currently the only value
-- written is 'schedule' (set when a note is entered in the Schedule Job
-- dialog/modal, on web or mobile), so the technician-facing job screen can
-- surface the scheduling note above the general notes feed instead of it
-- sitting unlabeled in the middle of the general log. Null means an ordinary
-- manually-added note — the overwhelming majority of existing rows.
alter table job_notes add column source text;
