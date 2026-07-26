// Mobile mirror of the web's job-costing math — ported VERBATIM from
// ../../lib/staff-cost.ts, ../../lib/equipment-cost.ts and the rollup in
// components/job/job-profitability.tsx. Payroll-sensitive: rendered ADMIN-ONLY.
// Kept in sync by hand (separate bundles); if you change one, change the other.

export interface StaffCostInputs {
  hourly_rate: number;
  super_rate: number;
  workers_comp_rate: number;
  leave_loading_rate: number;
  annual_fixed_oncosts: number;
  target_hours_per_week: number;
  vehicle_cost_per_hour?: number;
}

export interface StaffCostResult {
  annualPaidHours: number;
  annualVehicleCost: number;
  annualLoadedCost: number;
  loadedHourlyRate: number;
}

// Paid for target_hours_per_week every week (52), whether worked or on leave —
// so the same annual spend divides across fewer worked hours for heavier leave,
// surfacing a higher effective cost even on an identical nominal wage.
export function computeLoadedCost(inputs: StaffCostInputs): StaffCostResult {
  const annualPaidHours = Number(inputs.target_hours_per_week || 0) * 52;
  const baseWageAnnual = Number(inputs.hourly_rate || 0) * annualPaidHours;
  const oncostMultiplier =
    1 + (Number(inputs.super_rate || 0) + Number(inputs.workers_comp_rate || 0) + Number(inputs.leave_loading_rate || 0)) / 100;
  const annualVehicleCost = Number(inputs.vehicle_cost_per_hour || 0) * annualPaidHours;
  const annualLoadedCost = baseWageAnnual * oncostMultiplier + Number(inputs.annual_fixed_oncosts || 0) + annualVehicleCost;
  const loadedHourlyRate = annualPaidHours > 0 ? annualLoadedCost / annualPaidHours : 0;
  return { annualPaidHours, annualVehicleCost, annualLoadedCost, loadedHourlyRate };
}

export interface EquipmentCostInputs {
  purchase_cost: number;
  estimated_life_years: number;
  insurance_annual: number;
  maintenance_annual: number;
  registration_annual: number;
  other_annual_costs: number;
  fuel_cost_per_hour: number;
  target_hours_per_year: number;
}

export interface EquipmentCostResult {
  annualDepreciation: number;
  annualFixedCost: number;
  annualFuelCost: number;
  annualTotalCost: number;
  costPerHour: number;
}

// Straight-line depreciation + annual fixed costs spread across
// target_hours_per_year, plus fuel ($/hour input) on top.
export function computeEquipmentCost(inputs: EquipmentCostInputs): EquipmentCostResult {
  const lifeYears = Number(inputs.estimated_life_years || 0);
  const annualDepreciation = lifeYears > 0 ? Number(inputs.purchase_cost || 0) / lifeYears : 0;
  const annualFixedCost =
    annualDepreciation +
    Number(inputs.insurance_annual || 0) +
    Number(inputs.maintenance_annual || 0) +
    Number(inputs.registration_annual || 0) +
    Number(inputs.other_annual_costs || 0);
  const targetHours = Number(inputs.target_hours_per_year || 0);
  const annualFuelCost = Number(inputs.fuel_cost_per_hour || 0) * targetHours;
  const annualTotalCost = annualFixedCost + annualFuelCost;
  const costPerHour = targetHours > 0 ? annualTotalCost / targetHours : 0;
  return { annualDepreciation, annualFixedCost, annualFuelCost, annualTotalCost, costPerHour };
}

// ---- Job profitability rollup (ported from job-profitability.tsx) ----

export interface JobTimeEntry {
  staff_id: string;
  hours: number | null;
}
export type StaffCostProfile = StaffCostInputs & { staff_id: string };
export type EquipmentOption = EquipmentCostInputs & { id: string; assigned_to?: string | null };

export interface JobProfitabilityInput {
  timeEntries: JobTimeEntry[];
  staffCostProfiles: StaffCostProfile[];
  expenses: { amount: number | null }[];
  equipmentUsage: { equipment_id: string; hours: number }[];
  equipmentOptions: EquipmentOption[];
  invoices: { subtotal: number | null; status: string }[];
  jobItems: { total: number | null }[];
  variations: { status: string; invoice_id: string | null; total_amount: number | null }[];
  minMarginPct: number;
}

export interface JobProfitabilityResult {
  labourCost: number;
  labourHours: number;
  uncostedHours: number;
  uncostedStaffCount: number;
  materialsCost: number;
  expenseCount: number;
  equipmentCost: number;
  equipmentUsageCount: number; // unassigned entries actually costed
  excludedEquipmentUsageCount: number; // assigned-vehicle entries excluded (already in labour)
  totalCost: number;
  revenue: number;
  margin: number;
  marginPct: number | null;
  projectedRevenue: number;
  projectedMargin: number;
  projectedMarginPct: number | null;
  belowMinMargin: boolean;
  minMarginPct: number;
}

// Pure "true job cost vs revenue" rollup. Everything is ex-GST to match
// invoices.subtotal and job_expenses.amount. A vehicle assigned to a staff
// member folds its $/hour into that member's loaded rate, so its explicit
// usage entries are excluded here to avoid double-charging the job.
export function computeJobProfitability(input: JobProfitabilityInput): JobProfitabilityResult {
  const vehicleCostPerHourByStaff = new Map<string, number>();
  input.equipmentOptions.forEach((eq) => {
    if (!eq.assigned_to) return;
    vehicleCostPerHourByStaff.set(eq.assigned_to, (vehicleCostPerHourByStaff.get(eq.assigned_to) ?? 0) + computeEquipmentCost(eq).costPerHour);
  });

  const rateByStaff = new Map(
    input.staffCostProfiles.map((p) => [
      p.staff_id,
      computeLoadedCost({ ...p, vehicle_cost_per_hour: vehicleCostPerHourByStaff.get(p.staff_id) ?? 0 }).loadedHourlyRate,
    ])
  );
  const labourCost = input.timeEntries.reduce((s, e) => s + Number(e.hours ?? 0) * (rateByStaff.get(e.staff_id) ?? 0), 0);
  const labourHours = input.timeEntries.reduce((s, e) => s + Number(e.hours ?? 0), 0);
  const uncostedHours = input.timeEntries.reduce((s, e) => s + ((rateByStaff.get(e.staff_id) ?? 0) === 0 ? Number(e.hours ?? 0) : 0), 0);
  const uncostedStaffCount = new Set(
    input.timeEntries.filter((e) => (rateByStaff.get(e.staff_id) ?? 0) === 0 && Number(e.hours ?? 0) > 0).map((e) => e.staff_id)
  ).size;

  const materialsCost = input.expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);

  const equipmentById = new Map(input.equipmentOptions.map((eq) => [eq.id, eq]));
  const unassignedEquipmentUsage = input.equipmentUsage.filter((u) => !equipmentById.get(u.equipment_id)?.assigned_to);
  const excludedEquipmentUsageCount = input.equipmentUsage.length - unassignedEquipmentUsage.length;
  const equipmentCost = unassignedEquipmentUsage.reduce((s, u) => {
    const eq = equipmentById.get(u.equipment_id);
    return s + Number(u.hours) * (eq ? computeEquipmentCost(eq).costPerHour : 0);
  }, 0);

  const totalCost = labourCost + materialsCost + equipmentCost;
  const revenue = input.invoices.filter((i) => i.status !== "cancelled").reduce((s, i) => s + Number(i.subtotal ?? 0), 0);
  const margin = revenue - totalCost;
  const marginPct = revenue > 0 ? (margin / revenue) * 100 : null;

  const builtUpCharges = input.jobItems.reduce((s, i) => s + Number(i.total ?? 0), 0);
  const unbilledVariationsRevenue = input.variations
    .filter((v) => (v.status === "approved" || v.status === "auto_approved") && !v.invoice_id)
    .reduce((s, v) => s + Number(v.total_amount ?? 0), 0);
  const projectedRevenue = builtUpCharges + unbilledVariationsRevenue;
  const projectedMargin = projectedRevenue - totalCost;
  const projectedMarginPct = projectedRevenue > 0 ? (projectedMargin / projectedRevenue) * 100 : null;
  const belowMinMargin = projectedMarginPct !== null && projectedMarginPct < input.minMarginPct;

  return {
    labourCost, labourHours, uncostedHours, uncostedStaffCount,
    materialsCost, expenseCount: input.expenses.length,
    equipmentCost, equipmentUsageCount: unassignedEquipmentUsage.length, excludedEquipmentUsageCount,
    totalCost, revenue, margin, marginPct,
    projectedRevenue, projectedMargin, projectedMarginPct, belowMinMargin, minMarginPct: input.minMarginPct,
  };
}
