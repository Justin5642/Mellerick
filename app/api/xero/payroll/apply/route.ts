import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { reportError } from "@/lib/monitoring";
import { PAY_FIELDS, PayrollAccessError, applyImport, fetchPayroll, type Selection } from "@/lib/xero-payroll-import";

// Staff → Import from Xero, step 2: write what the admin ticked. The values are
// read from Xero again here — the request only names people and fields.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { since?: unknown; selections?: unknown } | null;
  const since = typeof body?.since === "string" && DATE.test(body.since) ? body.since : null;
  const raw = Array.isArray(body?.selections) ? body!.selections : null;
  if (!since || !raw || raw.length === 0 || raw.length > 200) {
    return NextResponse.json({ error: "Nothing selected to import." }, { status: 400 });
  }
  const selections: Selection[] = [];
  for (const r of raw as any[]) {
    if (!r || typeof r.staffId !== "string" || !UUID.test(r.staffId) || typeof r.xeroEmployeeId !== "string" || !r.xeroEmployeeId) {
      return NextResponse.json({ error: "The selection was malformed — reload the page." }, { status: 400 });
    }
    selections.push({
      staffId: r.staffId,
      xeroEmployeeId: r.xeroEmployeeId,
      fields: (Array.isArray(r.fields) ? r.fields : []).filter((f: unknown) => (PAY_FIELDS as readonly unknown[]).includes(f)),
      leave: r.leave === true,
    });
  }

  try {
    const snap = await fetchPayroll(since, dateKeyInBusinessTZ(new Date()));
    return NextResponse.json(await applyImport(await callerClient(request), snap, selections, guard.userId));
  } catch (err) {
    if (err instanceof PayrollAccessError) return NextResponse.json({ error: err.reason, reconnect: true }, { status: 409 });
    console.error("xero payroll apply error:", err);
    reportError(err, { route: "api/xero/payroll/apply" });
    return NextResponse.json({ error: "Couldn't complete the import. Nothing after the error was saved — reload and check." }, { status: 502 });
  }
}
