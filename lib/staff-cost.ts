// Shared "true cost" math for a staff member, used by both the admin cost
// editor (components/staff/staff-cost-dialog.tsx, for a live preview while
// editing) and the Reports page's staff efficiency section
// (app/dashboard/reports/page.tsx, computed server-side). Kept in one place
// so the two never drift apart.

export interface StaffCostInputs {
  hourly_rate: number;
  super_rate: number;
  workers_comp_rate: number;
  leave_loading_rate: number;
  annual_fixed_oncosts: number;
  target_hours_per_week: number;
  // Derived (not stored on staff_cost_profiles itself) from any equipment
  // rows with equipment.assigned_to = this staff member -- see
  // lib/equipment-cost.ts's costPerHour, summed across their assigned
  // vehicle(s). Optional/defaults to 0 so existing callers that don't pass
  // it (or staff with no assigned vehicle) behave exactly as before.
  vehicle_cost_per_hour?: number;
}

export interface StaffCostResult {
  annualPaidHours: number;
  annualVehicleCost: number;
  annualLoadedCost: number;
  loadedHourlyRate: number;
}

// Assumes a standard paid employee: paid for target_hours_per_week every
// week of the year (52), whether those hours are worked or taken as leave.
// That's what makes the "true cost per hour actually worked" comparison in
// the Reports page meaningful -- the same annual spend gets divided across
// fewer worked hours for someone who takes more leave, surfacing a higher
// effective cost even on an identical nominal wage.
export function computeLoadedCost(inputs: StaffCostInputs): StaffCostResult {
  const annualPaidHours = Number(inputs.target_hours_per_week || 0) * 52;
  const baseWageAnnual = Number(inputs.hourly_rate || 0) * annualPaidHours;
  const oncostMultiplier =
    1 + (Number(inputs.super_rate || 0) + Number(inputs.workers_comp_rate || 0) + Number(inputs.leave_loading_rate || 0)) / 100;
  const annualVehicleCost = Number(inputs.vehicle_cost_per_hour || 0) * annualPaidHours;
  const annualLoadedCost =
    baseWageAnnual * oncostMultiplier + Number(inputs.annual_fixed_oncosts || 0) + annualVehicleCost;
  const loadedHourlyRate = annualPaidHours > 0 ? annualLoadedCost / annualPaidHours : 0;
  return { annualPaidHours, annualVehicleCost, annualLoadedCost, loadedHourlyRate };
}

export const LEAVE_TYPE_LABELS: Record<string, string> = {
  sick: "Sick",
  annual: "Annual",
  public_holiday: "Public Holiday",
  other: "Other",
};
