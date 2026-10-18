import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportFailure } from "@/lib/monitoring";

// Per-user rate limit for the paid AI routes, counted in Postgres so every
// serverless instance shares one count. The in-memory Map in
// app/api/geocode/route.ts is per instance — a cold start or a second
// concurrent instance hands out a fresh allowance — which is fine for a free
// geocoder and not for a Claude call that costs money each time.
//
// Backed by consume_rate_limit() from migration 0076 (applied 2026-10-18). If
// the RPC is ever missing or erroring, this FAILS OPEN: the request is allowed and the gap is logged (and reported to
// Sentry once per instance). Failing closed would turn "the migration has not
// been applied" into "AI polish and plate scanning are down for everyone",
// which is a worse outcome than the cost exposure the limiter exists to cap.
// The same applies to any other limiter error (database unreachable): the
// limiter is a cost guard, not an access control.

export type RateLimit = { bucket: string; max: number; windowSeconds: number };

// Generous for a person, tight for a script. A tech scanning plates at a
// big site does a handful an hour; a polish per note, a few dozen a day.
export const SCAN_DATA_PLATE_LIMIT: RateLimit = { bucket: "scan-data-plate", max: 20, windowSeconds: 600 };
export const POLISH_NOTE_LIMIT: RateLimit = { bucket: "polish-note", max: 60, windowSeconds: 600 };

let reportedUnavailable = false;

/** true = allowed. Never throws. */
export async function consumeRateLimit(userId: string, limit: RateLimit): Promise<boolean> {
  try {
    const { data, error } = await createAdminClient().rpc("consume_rate_limit", {
      p_user_id: userId,
      p_bucket: limit.bucket,
      p_max: limit.max,
      p_window_seconds: limit.windowSeconds,
    });
    if (error) throw error;
    return data !== false;
  } catch (err) {
    const detail = err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
    console.error(`rate limiter unavailable (${limit.bucket}) — allowing request. Is migration 0076 applied?`, detail);
    if (!reportedUnavailable) {
      reportedUnavailable = true;
      reportFailure("rate limiter unavailable — failing open", { route: "lib/api/rate-limit", bucket: limit.bucket });
    }
    return true;
  }
}

export function rateLimitedResponse(): NextResponse {
  return NextResponse.json({ error: "Too many requests — wait a few minutes and try again." }, { status: 429 });
}
