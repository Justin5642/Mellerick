import { NextRequest, NextResponse } from "next/server";
import { getGoogleConsentUrl } from "@/lib/google";
import { requireAdmin } from "@/lib/api/guards";

// Starts the Google Calendar OAuth connect flow. Admin-only: connecting a
// calendar decides which Google account jobs sync to, so only an admin may
// initiate it (the callback re-checks — see callback/route.ts).
export async function GET(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  return NextResponse.redirect(getGoogleConsentUrl());
}
