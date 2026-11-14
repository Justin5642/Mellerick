// Turning Xero Payroll (AU) data into the app's staff cost profile and leave
// (migration 0101 — draft, not applied yet).
//
// Pure: no network, no database. lib/xero-payroll-import.ts fetches from Xero
// and writes; this decides what each value IS, so it can be tested against
// the shapes Xero actually returns.
//
// What Xero cannot tell us, and so is never touched by an import: workers
// comp % (it's the insurance policy), fixed annual on-costs (phone, PPE,
// training), trade level and charge-out rate (app-only settings).

/** Current Super Guarantee rate, used when Xero says "statutory" without a %. From 1 July 2025. */
export const STATUTORY_SUPER_RATE = 12;

// The subset of Xero's Payroll AU models this reads. Field names as xero-node
// returns them (camelCase).
export interface XeroEarningsLine {
  earningsRateID: string;
  calculationType?: string; // USEEARNINGSRATE | ENTEREARNINGSRATE | ANNUALSALARY
  annualSalary?: number;
  numberOfUnitsPerWeek?: number;
  ratePerUnit?: number;
  normalNumberOfUnits?: number;
}
export interface XeroSuperLine {
  contributionType?: string; // SGC | SALARYSACRIFICE | EMPLOYERADDITIONAL | EMPLOYEE
  calculationType?: string; // FIXEDAMOUNT | PERCENTAGEOFEARNINGS | STATUTORY
  percentage?: number;
}
export interface XeroLeaveLine {
  leaveTypeID: string;
}
export interface XeroEmployee {
  employeeID?: string;
  firstName: string;
  lastName: string;
  email?: string;
  status?: string; // ACTIVE | TERMINATED
  terminationDate?: string;
  ordinaryEarningsRateID?: string;
  payTemplate?: {
    earningsLines?: XeroEarningsLine[];
    superLines?: XeroSuperLine[];
    leaveLines?: XeroLeaveLine[];
  };
}
export interface XeroEarningsRate {
  earningsRateID?: string;
  name?: string;
  earningsType?: string; // ORDINARYTIMEEARNINGS | OVERTIMEEARNINGS | ...
  ratePerUnit?: string | number;
}
export interface XeroLeaveType {
  leaveTypeID?: string;
  name?: string;
  leaveLoadingRate?: number;
  leaveCategoryCode?: string;
  isPaidLeave?: boolean;
}
export interface XeroLeaveApplication {
  leaveApplicationID?: string;
  employeeID?: string;
  leaveTypeID?: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  leavePeriods?: { numberOfUnits?: number; leavePeriodStatus?: string }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const positive = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
};

/**
 * Xero AU payroll dates come either as ISO strings or as Microsoft JSON dates
 * ("/Date(1730419200000+0000)/"). Returns YYYY-MM-DD, or null.
 */
export function xeroDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  const ms = /\/Date\((-?\d+)/.exec(value);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return iso ? iso[1] : null;
}

// ---------------------------------------------------------------------------
// Pay: hourly rate, hours per week, super, leave loading
// ---------------------------------------------------------------------------

export interface XeroPay {
  hourlyRate: number | null;
  hoursPerWeek: number | null;
  superRate: number | null;
  leaveLoadingRate: number | null;
  /** How the hourly rate was found, shown to the admin. */
  basis: string;
  /** Things the admin should know before applying. */
  notes: string[];
}

export function payFromXero(employee: XeroEmployee, earningsRates: XeroEarningsRate[], leaveTypes: XeroLeaveType[]): XeroPay {
  const notes: string[] = [];
  const rateById = new Map(earningsRates.map((r) => [r.earningsRateID, r]));
  const lines = employee.payTemplate?.earningsLines ?? [];

  // The ordinary-time line: the employee's ordinary earnings rate, else the
  // first line whose rate is ordinary-time earnings.
  const ordinary =
    lines.find((l) => l.earningsRateID === employee.ordinaryEarningsRateID) ??
    lines.find((l) => rateById.get(l.earningsRateID)?.earningsType === "ORDINARYTIMEEARNINGS");

  let hourlyRate: number | null = null;
  let hoursPerWeek: number | null = null;
  let basis = "No ordinary earnings line in their Xero pay template";

  if (ordinary) {
    hoursPerWeek = positive(ordinary.numberOfUnitsPerWeek);
    const rateName = rateById.get(ordinary.earningsRateID)?.name ?? "ordinary earnings";
    switch (ordinary.calculationType) {
      case "ANNUALSALARY": {
        const salary = positive(ordinary.annualSalary);
        if (salary && hoursPerWeek) {
          hourlyRate = round2(salary / (hoursPerWeek * 52));
          basis = `Salary $${salary.toLocaleString("en-AU")} ÷ (${hoursPerWeek}h × 52)`;
        } else {
          basis = "Salaried, but Xero has no salary or weekly hours to divide it by";
        }
        break;
      }
      case "ENTEREARNINGSRATE":
        hourlyRate = positive(ordinary.ratePerUnit);
        basis = `${rateName} — rate on their pay template`;
        break;
      default: {
        // USEEARNINGSRATE (or unspecified): the pay item's own rate.
        hourlyRate = positive(ordinary.ratePerUnit) ?? positive(rateById.get(ordinary.earningsRateID)?.ratePerUnit);
        basis = `${rateName} — pay item rate`;
      }
    }
    if (hourlyRate === null && ordinary.calculationType !== "ANNUALSALARY") notes.push("Xero has no rate on their ordinary earnings line.");
  }

  // Super: the SGC line. A percentage if Xero gives one; "statutory" means the
  // current SG rate.
  const sgc = (employee.payTemplate?.superLines ?? []).find((s) => s.contributionType === "SGC");
  let superRate: number | null = null;
  if (sgc?.calculationType === "PERCENTAGEOFEARNINGS" && positive(sgc.percentage)) superRate = round2(Number(sgc.percentage));
  else if (sgc?.calculationType === "STATUTORY") superRate = STATUTORY_SUPER_RATE;
  else if (sgc?.calculationType === "FIXEDAMOUNT") notes.push("Super is a fixed amount in Xero, not a % — enter it by hand.");
  else if (!sgc) notes.push("No super guarantee line in their Xero pay template.");

  // Leave loading: the highest loading on an annual-leave type they accrue.
  const typeById = new Map(leaveTypes.map((t) => [t.leaveTypeID, t]));
  const loadings = (employee.payTemplate?.leaveLines ?? [])
    .map((l) => typeById.get(l.leaveTypeID))
    .filter((t): t is XeroLeaveType => !!t && leaveTypeFromXero(t) === "annual")
    .map((t) => Number(t.leaveLoadingRate ?? 0))
    .filter((v) => Number.isFinite(v));
  const leaveLoadingRate = loadings.length ? round2(Math.max(...loadings)) : null;

  return { hourlyRate, hoursPerWeek, superRate, leaveLoadingRate, basis, notes };
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export type AppLeaveType = "sick" | "annual" | "public_holiday" | "long_service" | "other";

/** Xero leave type → the app's. By Xero's category code where it has one, else by name. */
export function leaveTypeFromXero(t: Pick<XeroLeaveType, "name" | "leaveCategoryCode">): AppLeaveType {
  const code = (t.leaveCategoryCode ?? "").toUpperCase();
  const name = (t.name ?? "").toLowerCase();
  if (code === "ANNUALLEAVE" || /\bannual\b|holiday leave/.test(name)) return "annual";
  if (code === "PERSONALCARERSLEAVE" || /personal|carer|sick/.test(name)) return "sick";
  if (code === "LONGSERVICELEAVE" || /long service/.test(name)) return "long_service";
  if (/public holiday/.test(name)) return "public_holiday";
  return "other";
}

export interface ImportedLeave {
  xeroLeaveApplicationId: string;
  xeroEmployeeId: string;
  leaveType: AppLeaveType;
  start: string;
  end: string;
  hours: number;
  title: string | null;
}

/** Statuses that mean the leave is approved — scheduled or already paid. */
const APPROVED = new Set(["SCHEDULED", "PROCESSED"]);

/**
 * One approved leave application → one staff_leave row, or null when there is
 * nothing to record (requested or rejected only, unpaid, no hours, or before
 * `since`). Hours are the sum of its approved pay periods' units.
 */
export function leaveFromXero(app: XeroLeaveApplication, leaveTypes: XeroLeaveType[], since: string): ImportedLeave | null {
  if (!app.leaveApplicationID || !app.employeeID) return null;
  const start = xeroDate(app.startDate);
  const end = xeroDate(app.endDate) ?? start;
  if (!start || !end || end < since) return null;
  const type = leaveTypes.find((t) => t.leaveTypeID === app.leaveTypeID);
  if (type && type.isPaidLeave === false) return null;
  const hours = round2(
    (app.leavePeriods ?? [])
      .filter((p) => APPROVED.has(String(p.leavePeriodStatus ?? "").toUpperCase()))
      .reduce((s, p) => s + (Number(p.numberOfUnits) || 0), 0)
  );
  if (!(hours > 0)) return null;
  return {
    xeroLeaveApplicationId: app.leaveApplicationID,
    xeroEmployeeId: app.employeeID,
    leaveType: type ? leaveTypeFromXero(type) : "other",
    start,
    end,
    hours,
    title: app.title?.trim() || type?.name || null,
  };
}

// ---------------------------------------------------------------------------
// Matching Xero employees to app staff
// ---------------------------------------------------------------------------

export interface AppStaff {
  id: string;
  full_name: string | null;
  email: string | null;
  /** From staff_cost_profiles, when an earlier import linked them. */
  xero_employee_id?: string | null;
}

export type MatchHow = "linked" | "email" | "name";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Pairs each current Xero employee with an app staff member: an earlier link
 * first, then email, then exact full name. Each side is used at most once, and
 * an ambiguous name (two people with it) is left for the admin.
 */
export function matchStaff(
  employees: XeroEmployee[],
  staff: AppStaff[]
): { matches: { employee: XeroEmployee; staff: AppStaff; how: MatchHow }[]; unmatchedEmployees: XeroEmployee[]; unmatchedStaff: AppStaff[] } {
  const usedStaff = new Set<string>();
  const matches: { employee: XeroEmployee; staff: AppStaff; how: MatchHow }[] = [];
  const pending: XeroEmployee[] = [];

  const take = (employee: XeroEmployee, s: AppStaff | undefined, how: MatchHow) => {
    if (!s || usedStaff.has(s.id)) return false;
    usedStaff.add(s.id);
    matches.push({ employee, staff: s, how });
    return true;
  };

  for (const e of employees) {
    if (!take(e, staff.find((s) => s.xero_employee_id && s.xero_employee_id === e.employeeID), "linked")) pending.push(e);
  }
  const afterEmail: XeroEmployee[] = [];
  for (const e of pending) {
    const email = norm(e.email);
    const byEmail = email ? staff.filter((s) => !usedStaff.has(s.id) && norm(s.email) === email) : [];
    if (!(byEmail.length === 1 && take(e, byEmail[0], "email"))) afterEmail.push(e);
  }
  const unmatchedEmployees: XeroEmployee[] = [];
  for (const e of afterEmail) {
    const full = norm(`${e.firstName} ${e.lastName}`);
    const byName = staff.filter((s) => !usedStaff.has(s.id) && norm(s.full_name) === full);
    if (!(byName.length === 1 && take(e, byName[0], "name"))) unmatchedEmployees.push(e);
  }
  return { matches, unmatchedEmployees, unmatchedStaff: staff.filter((s) => !usedStaff.has(s.id)) };
}

/** Current employees only: not terminated, or terminated after `today`. */
export function isCurrentEmployee(e: XeroEmployee, today: string): boolean {
  if ((e.status ?? "").toUpperCase() === "TERMINATED") {
    const t = xeroDate(e.terminationDate);
    return !!t && t >= today;
  }
  const t = xeroDate(e.terminationDate);
  return !t || t >= today;
}
