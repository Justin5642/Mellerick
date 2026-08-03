-- ============================================================================
-- profiles.role IS A PRIVILEGED COLUMN — enforce it
--
-- Found 2026-08-04 by an adversarially-verified audit, then confirmed against
-- production before writing this.
--
-- THE HOLE. Every money control in this system reads ONE column:
--
--   • RLS            — is_office_or_admin(auth.uid()) reads profiles.role
--   • PowerSync      — office_* streams JOIN profiles WHERE role IN office/admin
--   • the mobile UI  — MoneyText / RoleGate resolve through profile.role
--   • the web API    — requireAdmin / requireOfficeOrAdmin read the same row
--
-- and nothing was treating that column as privileged. Two independent paths let
-- it be set by the very people it is meant to restrain:
--
-- 1. SELF-PROMOTION VIA THE UPDATE POLICY. `Users can update own profile` was
--    created as:
--        for update using (auth.uid() = id)
--    with NO `with check`. Postgres then reuses the USING expression for the NEW
--    row — and `auth.uid() = id` is still true after the role changes. So any
--    authenticated technician, holding the anon key that ships inside the app,
--    could PATCH /rest/v1/profiles?id=eq.<their own uuid> with {"role":"admin"}
--    and clear all four layers at once. Verified against production: the policy
--    really does report WITH CHECK = none.
--
--    This is the threat model 0038 already wrote down — "a technician holds the
--    anon key and can query PostgREST directly, regardless of what the app's UI
--    shows" — applied to the column that decides what the anon key may see.
--
-- 2. SIGNUP METADATA. handle_new_user() built the profile from
--    `coalesce(new.raw_user_meta_data->>'role', 'technician')`, and
--    raw_user_meta_data is verbatim client-supplied `options.data` from signUp.
--    Where public signup is enabled, that is an admin account for anyone who
--    asks.
--
-- WHY A TRIGGER RATHER THAN A BETTER POLICY. RLS cannot restrict a single
-- COLUMN, and a `with check` that compares against the row's previous role has
-- to re-read the table mid-statement, which is subtle enough to get wrong
-- quietly. A BEFORE UPDATE trigger states the rule once, in one place, and keeps
-- holding even if someone later rewrites the policy.
--
-- WHAT MUST KEEP WORKING — both verified against the live database first:
--   • app/api/staff/invite/route.ts  — admin-gated, service-role client,
--     inviteUserByEmail with data:{ full_name, role }
--   • app/api/staff/update/route.ts  — admin-gated, service-role client,
--     updates profiles.role directly
--   Both use the SERVICE ROLE, where auth.uid() is NULL — so is_admin() alone
--   would have blocked staff onboarding entirely. That is why service_role is
--   named explicitly below.
--
--   6 of the 7 live users have auth.users.invited_at set; the 1 that does not is
--   the original owner account, which predates the invite flow. Since this
--   trigger only fires on NEW inserts, that account is unaffected.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New accounts may not choose their own role.
-- ---------------------------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, full_name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
    new.email,
    case
      -- An INVITED user was created by an admin through the service-role invite
      -- endpoint, which is itself admin-gated, so the role in that metadata was
      -- chosen by an administrator and is trustworthy.
      when new.invited_at is not null
        then coalesce(new.raw_user_meta_data->>'role', 'technician')
      -- Anyone else supplied their own metadata. Ignore it entirely: a
      -- self-registered account is a technician, and an admin can promote it
      -- afterwards through the staff screen.
      else 'technician'
    end
  );
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Changing a role is an administrative act.
-- ---------------------------------------------------------------------------
create or replace function prevent_unauthorised_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    -- service_role covers the two admin-gated API routes, which authorise the
    -- caller themselves before writing. is_admin() covers an admin acting
    -- directly through PostgREST with their own JWT.
    if coalesce(auth.role(), '') <> 'service_role' and not is_admin(auth.uid()) then
      raise exception
        'profiles.role is administrator-only (attempted % -> %)', old.role, new.role
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_role_is_privileged on profiles;
create trigger profiles_role_is_privileged
  before update on profiles
  for each row
  execute function prevent_unauthorised_role_change();

-- Defence in depth: state the check explicitly rather than leaning on Postgres
-- reusing USING. This does not by itself stop a role change — the trigger does
-- that — but it removes the silent implicit behaviour that hid the hole.
drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- 3. Assert the end state. A security migration that can silently achieve
--    nothing is worse than no migration, because it closes the ticket.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n
  from pg_trigger
  where tgrelid = 'public.profiles'::regclass
    and tgname = 'profiles_role_is_privileged'
    and not tgisinternal;
  if n <> 1 then
    raise exception 'ASSERTION FAILED: profiles_role_is_privileged trigger not installed (found %)', n;
  end if;

  select count(*) into n
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'profiles'
    and p.polname = 'Users can update own profile'
    and p.polwithcheck is not null;
  if n <> 1 then
    raise exception 'ASSERTION FAILED: update policy still has no explicit WITH CHECK';
  end if;

  -- The invite path must still be able to create a non-technician.
  if position('invited_at' in pg_get_functiondef('public.handle_new_user'::regproc)) = 0 then
    raise exception 'ASSERTION FAILED: handle_new_user does not gate on invited_at';
  end if;
end;
$$;
