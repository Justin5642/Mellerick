import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireCronSecret } from "@/lib/api/guards";
import { connectedGmail, defaultReader, GmailHttpError, GmailTablesMissing, importGmailInvoices } from "@/lib/gmail-invoices";
import { reportError } from "@/lib/monitoring";

// Supplier invoices from the accounts Gmail label (0124, drafted). Hourly (vercel.json)
// with the cron secret; POST is an admin's "Check now" on Supplier POs. Both
// run the same import with the service role — the caller is authorised above
// it, and nothing a request carries is used. Read-only toward Gmail; never
// sends anything to Xero.

// Each file is read by Claude (often 10–30 s); the import stops starting new
// emails after ~200 s and the rest wait for the next run.
export const maxDuration = 300;

async function run(route: string) {
  try {
    const gmail = await connectedGmail();
    const result = await importGmailInvoices({ db: createAdminClient(), gmail, read: defaultReader() });
    return NextResponse.json(result);
  } catch (err: unknown) {
    if (err instanceof GmailTablesMissing) {
      return NextResponse.json({ skipped: true, reason: "Gmail invoice import isn't switched on yet" });
    }
    console.error("Gmail invoice import error:", err instanceof GmailHttpError ? err.message : "unexpected error");
    reportError(err instanceof GmailHttpError ? new Error(err.message) : err, { route, integration: "gmail" });
    return NextResponse.json({ error: "Checking Gmail for supplier invoices failed. Try again later." }, { status: 500 });
  }
}

// Cron, hourly.
export async function GET(request: NextRequest) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;
  return run("api/gmail/poll-invoices");
}

// "Check now" (admin).
export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;
  return run("api/gmail/poll-invoices");
}
