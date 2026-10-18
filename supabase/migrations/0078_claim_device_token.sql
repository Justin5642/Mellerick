-- ============================================================================
-- Hand a phone's push token to whoever is signed in on it now.
--
-- STATUS: DRAFT — NOT APPLIED. Safe to apply at any time: the mobile app calls
-- claim_device_token() when it exists and falls back to its old upsert when it
-- does not. Then run supabase/tests/0078_claim_device_token_test.sql.
--
-- WHY
-- device_tokens is keyed on the Expo push token, one per app install, and 0036
-- lets a user touch only rows they own. On a shared or handed-down phone the
-- next person's sign-in upserts the same token — an UPDATE of a row someone
-- else owns — and RLS refuses it. So their phone never registered, and if the
-- previous person's row was still there (signed out offline, or on a build
-- from before sign-out removed it), the new person's job notifications went to
-- the previous person instead. With pushes live since 0077 that is a real
-- misdelivery, not a theoretical one.
--
-- The function re-keys the row to the caller. Only someone holding the token
-- can claim it, and the token exists only on that phone (Expo issues it to the
-- install), which is the same trust Expo's own delivery relies on. Deactivated
-- staff cannot claim (0073).
-- ============================================================================

create or replace function claim_device_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = auth.uid() and coalesce(is_active, true)) then
    raise exception 'account is not active' using errcode = '42501';
  end if;
  if p_token is null
     or not (p_token like 'ExponentPushToken[%]' or p_token like 'ExpoPushToken[%]') then
    raise exception 'not an Expo push token' using errcode = '22023';
  end if;

  insert into device_tokens (token, user_id, platform)
  values (p_token, auth.uid(), p_platform)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform;
end;
$$;

revoke execute on function claim_device_token(text, text) from public, anon;
grant execute on function claim_device_token(text, text) to authenticated;

do $$
begin
  if not has_function_privilege('authenticated', 'public.claim_device_token(text, text)', 'execute') then
    raise exception 'ASSERTION FAILED: authenticated cannot call claim_device_token';
  end if;
  if has_function_privilege('anon', 'public.claim_device_token(text, text)', 'execute') then
    raise exception 'ASSERTION FAILED: anon can call claim_device_token';
  end if;
end;
$$;
