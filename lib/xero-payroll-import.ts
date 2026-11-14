// Staff → "Import from Xero" (migration 0101 — draft, not applied yet).
//
//   preview  read Xero Payroll + the app, pair people up, and show each
//            person's current value next to Xero's. Writes nothing.
//   apply    re-read Xero (the browser only says WHICH people and fields; the
//            values always come from Xero, never from the page) and write only
//            what the admin ticked.
//
// On demand only. Nothing here is scheduled (Justin, 15 Nov 2026).
//
// `db` is the admin's own session: staff_cost_profiles and staff_leave are
// admin-only by RLS (0014), and the routes check the admin role first.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getRefreshedXero } from "@/lib/xero";
import {
  isCurrentEmployee,
  leaveFromXero,
  matchStaff,
  payFromXero,
  type ImportedLeave,
  type MatchHow,
  type XeroEarningsRate,
  type XeroEmployee,
  type XeroLeaveApplication,
  type XeroLeaveType,
  type XeroPay,
} from "@/lib/xero-payroll";

/** Default leave window: 1 July of LAST financial year, so true-cost figures get a full year. */
export function defaultSince(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return `${(m >= 7 ? y : y - 1) - 1}-07-01`;
}

export const PAYROLL_SCOPES = ["payroll.employees.read", "payroll.settings.read"] as const;

/** Xero hasn't granted payroll access. `reason` is our own wording, safe to show. */
export class PayrollAccessError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/** The scopes inside a Xero access token (a JWT). Reads the claim only; verifies nothing. */
function tokenScopes(accessToken: string | undefined): string[] {
  try {
    const payload = JSON.parse(Buffer.from((accessToken ?? "").split(".")[1] ?? "", "base64url").toString("utf8"));
    const scope = payload.scope;
    return Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(" ") : [];
  } catch {
    return [];
  }
}

export interface PayrollSnapshot {
  employees: XeroEmployee[];
  earningsRates: XeroEarningsRate[];
  leaveTypes: XeroLeaveType[];
  leave: ImportedLeave[];
}

const PAGE = 100;
const MAX_PAGES = 20;

/** Everything the import needs from Xero, for current employees, leave ending on or after `since`. */
export async function fetchPayroll(since: string, today: string): Promise<PayrollSnapshot> {
  const { xero, tenantId } = await getRefreshedXero();
  const granted = tokenScopes(xero.readTokenSet().access_token);
  const missing = PAYROLL_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length) {
    throw new PayrollAccessError(
      "Xero hasn't been given access to payroll yet. In Settings, reconnect Xero and approve the payroll access, then try again."
    );
  }

  const call = async <T,>(what: string, fn: () => Promise<{ body: T }>): Promise<T> => {
    try {
      return (await fn()).body;
    } catch (e: any) {
      const status = e?.response?.statusCode ?? e?.response?.status;
      if (status === 401 || status === 403) {
        throw new PayrollAccessError(`Xero refused access to ${what}. Reconnect Xero in Settings and approve the payroll access.`);
      }
      throw new Error(`Couldn't read ${what} from Xero${status ? ` (HTTP ${status})` : ""}.`);
    }
  };

  const listed: XeroEmployee[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await call("employees", () => xero.payrollAUApi.getEmployees(tenantId, undefined, undefined, undefined, page) as any);
    const batch = ((body as any).employees ?? []) as XeroEmployee[];
    listed.push(...batch);
    if (batch.length < PAGE) break;
  }
  const current = listed.filter((e) => e.employeeID && isCurrentEmployee(e, today));

  // The list leaves out pay templates; each employee is one more call. A few at
  // a time keeps well under Xero's 60-calls-a-minute limit for a small team.
  const employees: XeroEmployee[] = [];
  for (let i = 0; i < current.length; i += 4) {
    const chunk = await Promise.all(
      current.slice(i, i + 4).map((e) =>
        call(`${e.firstName} ${e.lastName}'s pay template`, () => xero.payrollAUApi.getEmployee(tenantId, e.employeeID!) as any)
      )
    );
    for (const body of chunk) employees.push(...(((body as any).employees ?? []) as XeroEmployee[]));
  }

  const items = await call("pay items", () => xero.payrollAUApi.getPayItems(tenantId) as any);
  const earningsRates = ((items as any).payItems?.earningsRates ?? []) as XeroEarningsRate[];
  const leaveTypes = ((items as any).payItems?.leaveTypes ?? []) as XeroLeaveType[];

  const applications: XeroLeaveApplication[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await call("leave", () => xero.payrollAUApi.getLeaveApplications(tenantId, undefined, undefined, undefined, page) as any);
    const batch = ((body as any).leaveApplications ?? []) as XeroLeaveApplication[];
    applications.push(...batch);
    if (batch.length < PAGE) break;
  }
  const currentIds = new Set(employees.map((e) => e.employeeID));
  const leave = applications
    .map((a) => leaveFromXero(a, leaveTypes, since))
    .filter((l): l is ImportedLeave => !!l && currentIds.has(l.xeroEmployeeId));

  return { employees, earningsRates, leaveTypes, leave };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export const PAY_FIELDS = ["hourly_rate", "super_rate", "target_hours_per_week", "leave_loading_rate"] as const;
export type PayField = (typeof PAY_FIELDS)[number];

const payValue = (pay: XeroPay, f: PayField): number | null =>
  f === "hourly_rate" ? pay.hourlyRate : f === "super_rate" ? pay.superRate : f === "target_hours_per_week" ? pay.hoursPerWeek : pay.leaveLoadingRate;

export interface PreviewRow {
  staffId: string;
  staffName: string;
  xeroEmployeeId: string;
  xeroName: string;
  how: MatchHow | "manual";
  fields: { field: PayField; current: number | null; xero: number | null; changes: boolean }[];
  basis: string;
  notes: string[];
  leave: { newCount: number; newHours: number; alreadyImported: number };
}

export interface Preview {
  rows: PreviewRow[];
  unmatchedEmployees: { xeroEmployeeId: string; name: string; email: string | null }[];
  unmatchedStaff: { staffId: string; name: string }[];
  since: string;
}

async function loadAppSide(db: SupabaseClient) {
  const [profilesRes, costRes, leaveRes] = await Promise.all([
    db.from("profiles").select("id, full_name, email").eq("is_active", true).order("full_name"),
    db.from("staff_cost_profiles").select("staff_id, hourly_rate, super_rate, target_hours_per_week, leave_loading_rate, xero_employee_id"),
    db.from("staff_leave").select("xero_leave_application_id").not("xero_leave_application_id", "is", null),
  ]);
  for (const [r, what] of [[profilesRes, "staff"], [costRes, "staff cost profiles"], [leaveRes, "staff leave"]] as const) {
    if (r.error) throw new Error(`Couldn't read ${what} (${r.error.message}).`);
  }
  const costByStaff = new Map(((costRes.data ?? []) as any[]).map((c) => [c.staff_id as string, c]));
  const imported = new Set(((leaveRes.data ?? []) as any[]).map((l) => l.xero_leave_application_id as string));
  const staff = ((profilesRes.data ?? []) as any[]).map((p) => ({
    id: p.id as string,
    full_name: p.full_name as string | null,
    email: p.email as string | null,
    xero_employee_id: (costByStaff.get(p.id)?.xero_employee_id ?? null) as string | null,
  }));
  return { staff, costByStaff, imported };
}

const sameNumber = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.005;

export async function buildPreview(db: SupabaseClient, snap: PayrollSnapshot, since: string, manual: Record<string, string> = {}): Promise<Preview> {
  const { staff, costByStaff, imported } = await loadAppSide(db);

  // Admin-made pairings (xeroEmployeeId -> staffId) go first, then automatic matching on the rest.
  const manualPairs = Object.entries(manual).filter(
    ([eid, sid]) => snap.employees.some((e) => e.employeeID === eid) && staff.some((s) => s.id === sid)
  );
  const pairedE = new Set(manualPairs.map(([e]) => e));
  const pairedS = new Set(manualPairs.map(([, s]) => s));
  const auto = matchStaff(
    snap.employees.filter((e) => !pairedE.has(e.employeeID!)),
    staff.filter((s) => !pairedS.has(s.id))
  );
  const pairs = [
    ...manualPairs.map(([eid, sid]) => ({ employee: snap.employees.find((e) => e.employeeID === eid)!, staff: staff.find((s) => s.id === sid)!, how: "manual" as const })),
    ...auto.matches,
  ];

  const rows: PreviewRow[] = pairs.map(({ employee, staff: s, how }) => {
    const pay = payFromXero(employee, snap.earningsRates, snap.leaveTypes);
    const cur = costByStaff.get(s.id);
    const theirLeave = snap.leave.filter((l) => l.xeroEmployeeId === employee.employeeID);
    const fresh = theirLeave.filter((l) => !imported.has(l.xeroLeaveApplicationId));
    return {
      staffId: s.id,
      staffName: s.full_name ?? "Unnamed",
      xeroEmployeeId: employee.employeeID!,
      xeroName: `${employee.firstName} ${employee.lastName}`.trim(),
      how,
      fields: PAY_FIELDS.map((f) => {
        const current = cur && cur[f] != null ? Number(cur[f]) : null;
        const xero = payValue(pay, f);
        return { field: f, current, xero, changes: xero !== null && !sameNumber(current, xero) };
      }),
      basis: pay.basis,
      notes: pay.notes,
      leave: {
        newCount: fresh.length,
        newHours: Math.round(fresh.reduce((t, l) => t + l.hours, 0) * 100) / 100,
        alreadyImported: theirLeave.length - fresh.length,
      },
    };
  });

  return {
    rows: rows.sort((a, b) => a.staffName.localeCompare(b.staffName)),
    unmatchedEmployees: auto.unmatchedEmployees.map((e) => ({ xeroEmployeeId: e.employeeID!, name: `${e.firstName} ${e.lastName}`.trim(), email: e.email ?? null })),
    unmatchedStaff: auto.unmatchedStaff.map((s) => ({ staffId: s.id, name: s.full_name ?? "Unnamed" })),
    since,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface Selection {
  staffId: string;
  xeroEmployeeId: string;
  fields: PayField[];
  leave: boolean;
}

export interface ApplyResult {
  people: number;
  fieldsUpdated: number;
  leaveAdded: number;
  failures: { staffName: string; error: string }[];
}

export async function applyImport(db: SupabaseClient, snap: PayrollSnapshot, selections: Selection[], adminId: string): Promise<ApplyResult> {
  const { staff, imported } = await loadAppSide(db);
  const result: ApplyResult = { people: 0, fieldsUpdated: 0, leaveAdded: 0, failures: [] };
  const seenE = new Set<string>();
  const seenS = new Set<string>();

  for (const sel of selections) {
    const person = staff.find((s) => s.id === sel.staffId);
    const employee = snap.employees.find((e) => e.employeeID === sel.xeroEmployeeId);
    const name = person?.full_name ?? "Unknown person";
    if (!person || !employee) {
      result.failures.push({ staffName: name, error: "No longer in the app or no longer a current employee in Xero — reload the preview." });
      continue;
    }
    if (seenE.has(sel.xeroEmployeeId) || seenS.has(sel.staffId)) {
      result.failures.push({ staffName: name, error: "Paired twice in this import — each person can only be one Xero employee." });
      continue;
    }
    seenE.add(sel.xeroEmployeeId);
    seenS.add(sel.staffId);

    const pay = payFromXero(employee, snap.earningsRates, snap.leaveTypes);
    const values: Record<string, number> = {};
    for (const f of sel.fields.filter((f) => (PAY_FIELDS as readonly string[]).includes(f))) {
      const v = payValue(pay, f);
      if (v !== null) values[f] = v;
    }

    // The Xero employee may have been linked to someone else before (a wrong
    // automatic match, now corrected): move the link rather than fail on it.
    const unlink = await db
      .from("staff_cost_profiles")
      .update({ xero_employee_id: null })
      .eq("xero_employee_id", sel.xeroEmployeeId)
      .neq("staff_id", sel.staffId);
    if (unlink.error) {
      result.failures.push({ staffName: name, error: `Couldn't update the Xero link (${unlink.error.message}).` });
      continue;
    }

    const { error: upErr } = await db
      .from("staff_cost_profiles")
      .upsert(
        { staff_id: sel.staffId, xero_employee_id: sel.xeroEmployeeId, ...values, updated_by: adminId, updated_at: new Date().toISOString() },
        { onConflict: "staff_id" }
      );
    if (upErr) {
      result.failures.push({ staffName: name, error: `Pay details not saved (${upErr.message}).` });
      continue;
    }
    result.fieldsUpdated += Object.keys(values).length;

    if (sel.leave) {
      const fresh = snap.leave.filter((l) => l.xeroEmployeeId === sel.xeroEmployeeId && !imported.has(l.xeroLeaveApplicationId));
      if (fresh.length) {
        const { error: leaveErr, count } = await db.from("staff_leave").insert(
          fresh.map((l) => ({
            staff_id: sel.staffId,
            leave_type: l.leaveType,
            start_date: l.start,
            end_date: l.end,
            hours: l.hours,
            notes: l.title ? `From Xero: ${l.title}` : "From Xero",
            created_by: adminId,
            xero_leave_application_id: l.xeroLeaveApplicationId,
          })),
          { count: "exact" }
        );
        if (leaveErr) {
          result.failures.push({
            staffName: name,
            error:
              leaveErr.code === "23505"
                ? "Some of their leave was imported by someone else just now — reload the preview."
                : `Pay details saved, but their leave wasn't (${leaveErr.message}).`,
          });
        } else {
          result.leaveAdded += count ?? fresh.length;
          fresh.forEach((l) => imported.add(l.xeroLeaveApplicationId));
        }
      }
    }
    result.people += 1;
  }
  return result;
}
