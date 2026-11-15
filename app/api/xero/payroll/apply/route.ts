import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { reportError } from "@/lib/monitoring";
import { PAY_FIELDS, PayrollAccessError, applyImport, fetchPayroll, type Selection } from "@/lib/xero-payroll-import";
import { createAdminClient } from "@/lib/supabase/admin";
import { NEW_STAFF_ROLES, createStaffAccounts, loadExistingByEmail, planStaffCreates, type StaffCreate } from "@/lib/xero-staff-create";

// Staff → Import from Xero, step 2: write what the admin ticked. The values are
// read from Xero again here — the request only names people and fields.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Xero reads may wait and retry when Xero says "slow down" (lib/xero-payroll-import.ts).
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(request);
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { since?: unknown; selections?: unknown; creates?: unknown } | null;
  const since = typeof body?.since === "string" && DATE.test(body.since) ? body.since : null;
  const raw = Array.isArray(body?.selections) ? body!.selections : [];
  const rawCreates = Array.isArray(body?.creates) ? body!.creates : [];
  if (!since || raw.length + rawCreates.length === 0 || raw.length > 200 || rawCreates.length > 100) {
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
      balances: r.balances === true,
    });
  }

  // Xero employees to add to the app (made quietly — no invite email; see
  // lib/xero-staff-create.ts). Their pay, leave and balances import with them.
  const creates: StaffCreate[] = [];
  for (const c of rawCreates as any[]) {
    const role = NEW_STAFF_ROLES.find((r) => r === c?.role);
    if (!c || typeof c.xeroEmployeeId !== "string" || !c.xeroEmployeeId || !role) {
      return NextResponse.json({ error: "The selection was malformed — reload the page." }, { status: 400 });
    }
    creates.push({ xeroEmployeeId: c.xeroEmployeeId, role });
  }

  try {
    const snap = await fetchPayroll(since, dateKeyInBusinessTZ(new Date()));
    let created: { staffId: string; xeroEmployeeId: string; name: string }[] = [];
    const createFailures: { staffName: string; error: string }[] = [];
    if (creates.length) {
      const admin = createAdminClient();
      const plan = planStaffCreates(snap.employees, await loadExistingByEmail(admin), creates);
      createFailures.push(...plan.failures);
      const made = await createStaffAccounts(admin, plan.planned);
      created = made.created;
      createFailures.push(...made.failures);
      for (const c of created) {
        selections.push({ staffId: c.staffId, xeroEmployeeId: c.xeroEmployeeId, fields: [...PAY_FIELDS], leave: true, balances: true });
      }
    }
    const result = selections.length
      ? await applyImport(await callerClient(request), snap, selections, guard.userId)
      : { people: 0, fieldsUpdated: 0, leaveAdded: 0, balancesUpdated: 0, failures: [] };
    return NextResponse.json({ ...result, added: created.map((c) => c.name), failures: [...createFailures, ...result.failures] });
  } catch (err) {
    if (err instanceof PayrollAccessError) return NextResponse.json({ error: err.reason, reconnect: true }, { status: 409 });
    console.error("xero payroll apply error:", err);
    reportError(err, { route: "api/xero/payroll/apply" });
    return NextResponse.json({ error: "Couldn't complete the import. Nothing after the error was saved — reload and check." }, { status: 502 });
  }
}
