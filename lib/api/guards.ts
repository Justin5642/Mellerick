import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { timingSafeEquals } from "@/lib/constant-time";

// Shared server-side authentication/authorization for API route handlers.
// Centralizes the two things every mutating route needs: (1) resolve the
// caller's identity from either a mobile Bearer token OR a web session cookie
// (the app has both clients), and (2) check their role. Previously each route
// hand-rolled this (or skipped it), which is exactly how the unguarded/
// authenticated-but-unauthorized routes slipped in.

export type Role = "admin" | "office" | "technician";

type GuardOk = { ok: true; userId: string; role: Role | null };
type GuardFail = { ok: false; response: NextResponse };
export type GuardResult = GuardOk | GuardFail;

function unauthenticated(): GuardFail {
  return { ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
}

function forbidden(): GuardFail {
  return { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
}

// Resolve the caller's user id from a Bearer token (mobile) or the session
// cookie (web). Returns null if neither yields a valid user.
export async function getCallerId(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (token) {
    const anon = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data, error } = await anon.auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  }

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// Reads the caller's profile via the service-role client. Safe because the
// caller identity is already established; reading their own row bypasses the
// RLS recursion issues that motivated the is_office_or_admin() SQL helper.
// A deactivated profile (is_active = false) comes back as null — the same as
// no profile — so every guard below refuses it. NULL is_active has always
// meant active (column default true).
async function getActiveCallerRole(userId: string): Promise<{ found: boolean; role: Role | null }> {
  const admin = createAdminClient();
  const { data } = await admin.from("profiles").select("role, is_active").eq("id", userId).single();
  if (!data || data.is_active === false) return { found: false, role: null };
  return { found: true, role: (data.role as Role | undefined) ?? null };
}

// Require any authenticated, active user. role is left null — use
// requireRole when the decision depends on the role.
export async function requireUser(request: NextRequest): Promise<GuardResult> {
  const userId = await getCallerId(request);
  if (!userId) return unauthenticated();
  const { found } = await getActiveCallerRole(userId);
  if (!found) return forbidden();
  return { ok: true, userId, role: null };
}

// Require an authenticated, active user whose role is in `allowed`.
export async function requireRole(request: NextRequest, allowed: Role[]): Promise<GuardResult> {
  const userId = await getCallerId(request);
  if (!userId) return unauthenticated();
  const { role } = await getActiveCallerRole(userId);
  if (!role || !allowed.includes(role)) return forbidden();
  return { ok: true, userId, role };
}

export function requireAdmin(request: NextRequest): Promise<GuardResult> {
  return requireRole(request, ["admin"]);
}

export function requireOfficeOrAdmin(request: NextRequest): Promise<GuardResult> {
  return requireRole(request, ["admin", "office"]);
}

// Cron-secret gate for scheduled routes. Fails CLOSED: a missing CRON_SECRET
// returns 500, never an open endpoint (see the poll-invoices/poll-calendar
// comment about the old `if (cronSecret)` footgun).
export function requireCronSecret(request: NextRequest): { ok: true } | GuardFail {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return { ok: false, response: NextResponse.json({ error: "Server misconfigured" }, { status: 500 }) };
  }
  // Constant-time: `!==` on a secret short-circuits at the first differing
  // byte, so the time taken leaks how much of it the caller got right.
  if (!timingSafeEquals(request.headers.get("authorization"), `Bearer ${cronSecret}`)) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { ok: true };
}
