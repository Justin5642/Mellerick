// Staff → "Import from Xero" (migration 0101).
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
  balancesFromXero,
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
import { cannotAddReason, loadExistingByEmail } from "@/lib/xero-staff-create";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * xero-node throws either an object with `response` or, for some failures, a
 * JSON string of one. Pull out the HTTP status and Retry-After (seconds).
 */
export function xeroErrorInfo(e: unknown): { status: number | undefined; retryAfter: number | undefined } {
  let err: any = e;
  if (typeof e === "string") {
    try {
      err = JSON.parse(e);
    } catch {
      return { status: undefined, retryAfter: undefined };
    }
  }
  const res = err?.response ?? {};
  const raw = res.statusCode ?? res.status ?? err?.statusCode ?? err?.status;
  const status = typeof raw === "number" ? raw : Number.isFinite(Number(raw)) && raw !== null && raw !== undefined && raw !== "" ? Number(raw) : undefined;
  const headers = res.headers ?? {};
  const ra = Number(headers["retry-after"] ?? headers["Retry-After"]);
  return { status, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined };
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

  // Xero allows 60 calls a minute per organisation, and a preview is one call
  // per employee plus a few. Running it a few times in a row (preview, import,
  // preview again) hit that on 15 Nov 2026 ("Couldn't read leave from
  // Xero."), so a 429 — or a hiccup with no status — waits and tries again.
  const call = async <T,>(what: string, fn: () => Promise<{ body: T }>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return (await fn()).body;
      } catch (e: any) {
        const { status, retryAfter } = xeroErrorInfo(e);
        if (status === 401 || status === 403) {
          throw new PayrollAccessError(`Xero refused access to ${what}. Reconnect Xero in Settings and approve the payroll access.`);
        }
        const retryable = status === 429 || status === undefined || status >= 500;
        if (retryable && attempt < 4) {
          await sleep(Math.min(20, retryAfter ?? 2 ** attempt) * 1000);
          continue;
        }
        console.error(`xero payroll: reading ${what} failed`, { status, attempt, detail: String(e?.message ?? e?.body?.Message ?? e).slice(0, 300) });
        throw new Error(
          status === 429
            ? `Xero is busy (too many requests in the last minute). Wait a minute, then reload.`
            : `Couldn't read ${what} from Xero${status ? ` (HTTP ${status})` : ""}.`
        );
      }
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
  /** Leave left, per Xero leave type (0104). `current` is what the app has from the last import. */
  balances: { xeroLeaveTypeId: string; name: string; current: number | null; xero: number }[];
  /** True when any balance differs from the app's (or the app has none yet). */
  balancesChange: boolean;
}

export interface Preview {
  rows: PreviewRow[];
  /** `cannotAdd` says why "Add to app" isn't offered (no email, already in the app…); null when it is. */
  unmatchedEmployees: { xeroEmployeeId: string; name: string; email: string | null; cannotAdd: string | null }[];
  unmatchedStaff: { staffId: string; name: string }[];
  since: string;
}

async function loadAppSide(db: SupabaseClient) {
  const [profilesRes, costRes, leaveRes, balRes] = await Promise.all([
    db.from("profiles").select("id, full_name, email").eq("is_active", true).order("full_name"),
    db.from("staff_cost_profiles").select("staff_id, hourly_rate, super_rate, target_hours_per_week, leave_loading_rate, xero_employee_id"),
    db.from("staff_leave").select("xero_leave_application_id").not("xero_leave_application_id", "is", null),
    db.from("staff_leave_balances").select("staff_id, xero_leave_type_id, hours"),
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
  // Leave balances are optional: before 0104 is applied the table does not
  // exist, and pay and leave must still import. Balances are then left out.
  const balancesAvailable = !balRes.error;
  if (balRes.error) console.error("xero payroll: leave balances unavailable:", balRes.error.message);
  const balances = new Map<string, number>();
  for (const b of (balRes.data ?? []) as any[]) balances.set(`${b.staff_id}|${b.xero_leave_type_id}`, Number(b.hours));
  return { staff, costByStaff, imported, balances, balancesAvailable };
}

const sameNumber = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.005;

export async function buildPreview(db: SupabaseClient, snap: PayrollSnapshot, since: string, manual: Record<string, string> = {}): Promise<Preview> {
  const [{ staff, costByStaff, imported, balances, balancesAvailable }, existing] = await Promise.all([loadAppSide(db), loadExistingByEmail(db)]);

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
    const bal = balancesAvailable ? balancesFromXero(employee, snap.leaveTypes) : { balances: [], notes: [] };
    const balRows = bal.balances.map((b) => {
      const key = `${s.id}|${b.xeroLeaveTypeId}`;
      return { xeroLeaveTypeId: b.xeroLeaveTypeId, name: b.name, current: balances.has(key) ? balances.get(key)! : null, xero: b.hours };
    });
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
      notes: [...pay.notes, ...bal.notes],
      balances: balRows,
      balancesChange: balRows.some((b) => !sameNumber(b.current, b.xero)),
      leave: {
        newCount: fresh.length,
        newHours: Math.round(fresh.reduce((t, l) => t + l.hours, 0) * 100) / 100,
        alreadyImported: theirLeave.length - fresh.length,
      },
    };
  });

  return {
    rows: rows.sort((a, b) => a.staffName.localeCompare(b.staffName)),
    unmatchedEmployees: auto.unmatchedEmployees.map((e) => ({
      xeroEmployeeId: e.employeeID!,
      name: `${e.firstName} ${e.lastName}`.trim(),
      email: e.email ?? null,
      cannotAdd: cannotAddReason(e, existing),
    })),
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
  /** Replace their leave balances with Xero's (0104). */
  balances?: boolean;
}

export interface ApplyResult {
  people: number;
  fieldsUpdated: number;
  leaveAdded: number;
  balancesUpdated: number;
  failures: { staffName: string; error: string }[];
}

export async function applyImport(db: SupabaseClient, snap: PayrollSnapshot, selections: Selection[], adminId: string): Promise<ApplyResult> {
  const { staff, imported, balancesAvailable } = await loadAppSide(db);
  const result: ApplyResult = { people: 0, fieldsUpdated: 0, leaveAdded: 0, balancesUpdated: 0, failures: [] };
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
    if (sel.balances && balancesAvailable) {
      // A balance is a snapshot: replace the person's set with Xero's, so a
      // leave type removed in Xero doesn't linger here.
      const { balances } = balancesFromXero(employee, snap.leaveTypes);
      const today = new Date().toISOString().slice(0, 10);
      const up = balances.length
        ? await db.from("staff_leave_balances").upsert(
            balances.map((b) => ({
              staff_id: sel.staffId,
              xero_leave_type_id: b.xeroLeaveTypeId,
              leave_name: b.name,
              leave_type: b.leaveType,
              hours: b.hours,
              as_of: today,
              imported_by: adminId,
              updated_at: new Date().toISOString(),
            })),
            { onConflict: "staff_id,xero_leave_type_id" }
          )
        : { error: null };
      const keep = balances.map((b) => b.xeroLeaveTypeId);
      let stale = db.from("staff_leave_balances").delete().eq("staff_id", sel.staffId);
      if (keep.length) stale = stale.not("xero_leave_type_id", "in", `(${keep.map((k) => `"${k.replace(/"/g, "")}"`).join(",")})`);
      const del = up.error ? { error: null } : await stale;
      if (up.error || del.error) {
        result.failures.push({ staffName: name, error: `Their leave balances weren't saved (${(up.error ?? del.error)!.message}).` });
      } else {
        result.balancesUpdated += balances.length;
      }
    }

    result.people += 1;
  }
  return result;
}
