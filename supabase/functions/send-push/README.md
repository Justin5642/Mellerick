# send-push — Edge Function (PROPOSED, MP9 push server-half)

Completes the push loop: the mobile client registers a token (`mobile/lib/push/`,
D75) into `device_tokens` (migration `0036`, PROPOSED); this function dispatches a
push to a user's devices via the Expo Push API. **PROPOSED for Jason** — it deploys
to the Supabase project and needs push credentials; not deployed here.

- `pushSender.ts` — pure dispatch logic (batching ≤100, ok/error/DeviceNotRegistered
  handling, never throws). **Unit-tested** in `tests/unit/push-sender.test.ts`
  (7 tests, run by the web `vitest` suite).
- `index.ts` — thin Deno wrapper: authorize (internal secret for the trigger path,
  or an office/admin Bearer JWT), read the target user's `device_tokens` with the
  service-role key, send, and prune `DeviceNotRegistered` tokens.

## To enable (Jason + accounts)
1. Configure Expo push credentials for the EAS project (APNs key / FCM) — see
   `expo credentials` / EAS docs. Expo delivers via its push service using the
   ExponentPushToken the client already registers.
2. Apply migration `0036_device_tokens.sql`.
3. Set function secrets: `supabase secrets set PUSH_INTERNAL_SECRET=<random>` (the
   service-role key + URL are injected by the platform).
4. Deploy: `supabase functions deploy send-push`.
5. Wire a **trigger** (pick one):
   - **DB trigger** on `jobs` (when `assigned_to` changes) → `pg_net`/webhook →
     this function with `x-internal-secret`, `{ userId: NEW.assigned_to,
     notification: { title: 'New job', body: '#'||NEW.job_number||' '||NEW.title,
     data: { jobId: NEW.id } } }`. (Recommended — server-authoritative.)
   - Or call it from the web/mobile after an assignment, forwarding the caller's
     office/admin Bearer token.

## Notifications worth sending (backlog, business decision)
Job assigned / rescheduled to a technician; a variation approved/rejected; an
approval awaiting an admin. The client already routes taps via the notification
`data` payload (`configureForegroundNotifications` in `mobile/lib/push/`).
