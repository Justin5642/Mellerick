# Push notifications: turning on "you've been assigned a job"

What sends a notification: a new row in `job_assignments` made by a real
person (office/admin on the web, or the mobile office screens). The trigger in
`supabase/migrations/0077_job_assignment_push.sql` queues an HTTP call to the
`send-push` edge function, which looks up the technician's `device_tokens` and
sends through Expo. Tapping the notification opens the job (mobile build 15+;
earlier builds just open the app).

Nothing is sent for: import scripts and the SQL editor, completed or cancelled
jobs, assigning yourself, or re-saving a crew that already includes the person.

## One-time setup, in this order

Run from the repo root. Use the pinned CLI (`supabase@2.109.1`); see HANDOVER for
why. The secret is generated and stored in the same command so it is never
printed or pasted anywhere.

1. **Create the shared secret and store it in both places** (the function's
   environment, and Supabase Vault for the trigger):

   ```bash
   S=$(openssl rand -hex 32) && \
   npx supabase@2.109.1 secrets set PUSH_INTERNAL_SECRET="$S" && \
   npx supabase@2.109.1 db query --linked "select vault.create_secret('$S', 'push_internal_secret');" && \
   unset S
   ```

2. **Store the function URL in Vault:**

   ```bash
   npx supabase@2.109.1 db query --linked "select vault.create_secret('https://ntdohrsujnyuqyeirqva.supabase.co/functions/v1/send-push', 'push_function_url');"
   ```

3. **Redeploy the function with the gateway JWT check off.** The function does
   its own auth (internal secret, or an active office/admin JWT). With the
   gateway check on, the trigger's call is rejected before it reaches the code.

   ```bash
   npx supabase@2.109.1 functions deploy send-push --no-verify-jwt
   ```

4. **Apply migration 0077** (SQL editor or `db query --linked -f`), then run
   `supabase/tests/0077_job_assignment_push_test.sql`. It queues requests and
   rolls them back, so it never sends a real notification. Then record it:

   ```sql
   insert into supabase_migrations.schema_migrations (version, name)
   values ('0077', 'job_assignment_push') on conflict (version) do nothing;
   ```

5. **Try it:** have an office/admin user assign a technician whose phone has the
   app installed and notifications allowed. Assigning yourself sends nothing.

## When it does not arrive

- `select * from net._http_response order by created desc limit 5;` shows what
  the function answered (401 = secret mismatch or the gateway JWT check is
  still on; 200 with `sent: 0` = that person has no registered device).
- `select user_id, platform, updated_at from device_tokens;` — a phone appears
  here after its user signs in and allows notifications.
- The phone must allow notifications for the app (iOS Settings → Notifications).
