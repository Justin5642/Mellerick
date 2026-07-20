import { NextRequest, NextResponse } from "next/server";
import { getXeroClient } from "@/lib/xero";
import { requireAdmin } from "@/lib/api/guards";

// Starts the Xero OAuth connect flow. Admin-only: connecting Xero decides which
// Xero org the business's invoices push to, so only an admin may initiate it
// (and the callback re-checks — see callback/route.ts).
export async function GET(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const xero = getXeroClient();
  const url = await xero.buildConsentUrl();
  return NextResponse.redirect(url);
}
