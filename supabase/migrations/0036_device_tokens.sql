-- PROPOSED (not applied) — flagged for Jason's review, like 0035.
-- Backs the mobile push-notification registration (MP9): each device stores its
-- Expo push token so the backend can target it. The mobile client upserts here
-- after sign-in (see mobile/lib/push/*); the app degrades gracefully if this
-- table does not yet exist, so applying it is what "turns push on" server-side.

create table if not exists device_tokens (
  token text primary key,                    -- the Expo push token (unique per install)
  user_id uuid not null references profiles(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  updated_at timestamptz not null default now()
);

create index if not exists device_tokens_user_id_idx on device_tokens(user_id);

alter table device_tokens enable row level security;

-- A user may register / see / update / remove only their OWN device tokens.
-- The server-side sender uses the service-role key (bypasses RLS) to read tokens
-- when dispatching a push — never the anon/user client.
drop policy if exists "own device tokens" on device_tokens;
create policy "own device tokens" on device_tokens
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

comment on table device_tokens is
  'Expo push tokens per device for MP9 push notifications. Written by the mobile app after sign-in; read by the backend push sender via the service-role key. RLS restricts each authenticated user to their own rows.';
