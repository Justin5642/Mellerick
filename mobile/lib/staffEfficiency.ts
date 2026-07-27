import { computeLoadedCost, computeEquipmentCost, type StaffCostInputs, type EquipmentCostInputs } from "./costing";

// Admin-only staff cost & efficiency, ported verbatim from the web Reports page
// (app/dashboard/reports/page.tsx). Payroll-sensitive — gated to admins. True
// cost per worked hour = fully-loaded annual cost / hours actually worked, so
// heavy leave/low utilisation drives the effective rate up.
export interface StaffEffProfile extends StaffCostInputs {
  staff_id: string;
}
export interface StaffEffInput {
  profiles: StaffEffProfile[];
  workEntries: { staff_id: string; hours: number | null }[];
  leaveEntries: { staff_id: string; leave_type: string; hours: number | null }[];
  equipment: (EquipmentCostInputs & { assigned_to?: string | null })[];
  nameByStaff: Record<string, string>;
}
export interface StaffEffRow {
  name: string;
  loadedHourlyRate: number;
  workedHours: number;
  sickHours: number;
  leaveHours: number;
  utilizationPct: number | null;
  trueCostPerWorkedHour: number | null;
}

export function computeStaffEfficiency(input: StaffEffInput): StaffEffRow[] {
  // A vehicle assigned to a staff member folds its $/hour into their loaded rate.
  const vehicleByStaff = new Map<string, number>();
  for (const eq of input.equipment) {
    if (!eq.assigned_to) continue;
    vehicleByStaff.set(eq.assigned_to, (vehicleByStaff.get(eq.assigned_to) ?? 0) + computeEquipmentCost(eq).costPerHour);
  }
  const worked = new Map<string, number>();
  for (const e of input.workEntries) worked.set(e.staff_id, (worked.get(e.staff_id) ?? 0) + Number(e.hours ?? 0));
  const leave = new Map<string, number>();
  const sick = new Map<string, number>();
  for (const l of input.leaveEntries) {
    const h = Number(l.hours ?? 0);
    leave.set(l.staff_id, (leave.get(l.staff_id) ?? 0) + h);
    if (l.leave_type === "sick") sick.set(l.staff_id, (sick.get(l.staff_id) ?? 0) + h);
  }

  return input.profiles
    .map((cp) => {
      const vehicle_cost_per_hour = vehicleByStaff.get(cp.staff_id) ?? 0;
      const { annualLoadedCost, loadedHourlyRate } = computeLoadedCost({ ...cp, vehicle_cost_per_hour });
      const workedHours = worked.get(cp.staff_id) ?? 0;
      const leaveHours = leave.get(cp.staff_id) ?? 0;
      const sickHours = sick.get(cp.staff_id) ?? 0;
      const paidHours = workedHours + leaveHours;
      return {
        name: input.nameByStaff[cp.staff_id] ?? "Unknown",
        loadedHourlyRate,
        workedHours,
        sickHours,
        leaveHours,
        utilizationPct: paidHours > 0 ? (workedHours / paidHours) * 100 : null,
        trueCostPerWorkedHour: workedHours > 0 ? annualLoadedCost / workedHours : null,
      };
    })
    .sort((a, b) => (b.trueCostPerWorkedHour ?? 0) - (a.trueCostPerWorkedHour ?? 0));
}
