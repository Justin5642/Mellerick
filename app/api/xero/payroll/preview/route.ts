import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { reportError } from "@/lib/monitoring";
import { PayrollAccessError, buildPreview, defaultSince, fetchPayroll } from "@/lib/xero-payroll-import";

// Staff → Import from Xero, step 1: what Xero Payroll has next to what the app
// has. Reads only. Admin-only: this is payroll. See lib/xero-payroll-import.ts.
//
//   ?since=YYYY-MM-DD   leave ending on or after this date (default: 1 July of
//                       last financial year, so the true-cost figures get a
//                       full year of leave)
//   ?pair=<xeroEmployeeId>:<staffId>   repeatable — the admin's own pairings
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const today = dateKeyInBusinessTZ(new Date());
  const sinceParam = request.nextUrl.searchParams.get("since");
  const since = sinceParam && DATE.test(sinceParam) ? sinceParam : defaultSince(today);
  const manual: Record<string, string> = {};
  for (const p of request.nextUrl.searchParams.getAll("pair")) {
    const [eid, sid] = p.split(":");
    if (eid && sid && UUID.test(sid)) manual[eid] = sid;
  }

  try {
    const snap = await fetchPayroll(since, today);
    return NextResponse.json(await buildPreview(await callerClient(request), snap, since, manual));
  } catch (err) {
    if (err instanceof PayrollAccessError) return NextResponse.json({ error: err.reason, reconnect: true }, { status: 409 });
    console.error("xero payroll preview error:", err);
    reportError(err, { route: "api/xero/payroll/preview" });
    return NextResponse.json({ error: "Couldn't read payroll from Xero. Try again in a minute." }, { status: 502 });
  }
}
