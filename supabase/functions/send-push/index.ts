// Supabase Edge Function (Deno) — send a push to a user's devices. PROPOSED for
// Justin's review/deploy (like the RLS drafts): it deploys to the Supabase project
// and needs the Expo push credentials configured. Thin wrapper around the
// unit-tested pushSender.ts.
//
// Invocation (two supported callers):
//   1. A Postgres trigger / DB webhook on jobs (assigned_to change) via pg_net,
//      passing the internal secret in `x-internal-secret`.
//   2. An authenticated office/admin action, forwarding the caller's Bearer JWT
//      (verified below); technicians are rejected (they don't dispatch pushes).
//
// Body: { userId: string, notification: { title, body, data? } }
// Reads the target user's device_tokens with the service-role key, sends via
// Expo, and prunes any DeviceNotRegistered tokens.

// @ts-nocheck  (Deno runtime; not typechecked by the app's Node tsc — see tsconfig exclude)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendExpoPush, type PushNotification } from "./pushSender.ts";

/**
 * Constant-time string comparison, for Deno.
 *
 * The Node twin is lib/constant-time.ts; an edge function cannot import from
 * lib/, so the property is restated rather than shared. Keep them in step.
 *
 * XORs every byte and accumulates, so the loop always runs to the end — no
 * early return, no data-dependent branch. Empty input is refused on both sides:
 * two empty strings are byte-identical, and an unset secret must not be
 * satisfied by an absent header.
 */
function timingSafeEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;

  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const internalSecret = Deno.env.get("PUSH_INTERNAL_SECRET");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // AuthZ: either the internal secret (trigger path) OR an office/admin caller.
  //
  // Compared in constant time. `===` on a secret short-circuits at the first
  // differing byte, so the time taken leaks how much of it the caller got right.
  // Written out here rather than imported: this is a Deno edge function and
  // cannot reach lib/constant-time.ts, which is the Node twin of this.
  const providedSecret = req.headers.get("x-internal-secret");
  let authorized = !!internalSecret && timingSafeEquals(providedSecret, internalSecret);
  if (!authorized) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Not authenticated" }, 401);
    const { data: userData } = await admin.auth.getUser(token);
    if (!userData.user) return json({ error: "Not authenticated" }, 401);
    const { data: profile } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
    if (!profile || (profile.role !== "office" && profile.role !== "admin")) return json({ error: "Forbidden" }, 403);
    authorized = true;
  }

  const { userId, notification } = (await req.json().catch(() => ({}))) as {
    userId?: string;
    notification?: PushNotification;
  };
  if (!userId || !notification?.title || !notification?.body) return json({ error: "userId + notification{title,body} required" }, 400);

  const { data: rows } = await admin.from("device_tokens").select("token").eq("user_id", userId);
  const tokens = (rows ?? []).map((r: { token: string }) => r.token);

  const result = await sendExpoPush(fetch, tokens, notification);

  // Prune tokens Expo reported as no longer registered.
  if (result.invalidTokens.length > 0) {
    await admin.from("device_tokens").delete().in("token", result.invalidTokens);
  }

  return json(result, 200);
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
