"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import { computeLoadedCost } from "@/lib/staff-cost";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";

// Admin-only "true job profitability" rollup: labour (hours logged * each
// staff member's fully-loaded hourly cost, from staff_cost_profiles) +
// materials/other expenses (job_expenses) + equipment (equipment_usage_log
// * each item's cost-per-hour, from the `equipment` table) vs. what was
// actually invoiced for the job. Everything here is ex-GST to match
// invoices.subtotal and job_expenses.amount's existing "GST-exclusive"
// convention, so the comparison is apples-to-apples.
//
// This only renders for admins (gated by the parent tab list in
// job-detail-client.tsx) because labour cost is derived from payroll-
// sensitive staff_cost_profiles data that must never reach technicians.
//
// Vehicle cost double-counting guard: a vehicle assigned to a technician
// (equipment.assigned_to, see lib/staff-cost.ts) already has its $/hour
// folded into that technician's loaded hourly rate for every hour they
// work, on any job -- that's how labourCost below is costed. So if the
// same vehicle also has explicit equipment_usage_log entries against
// this job, counting those again under "Equipment" would double-charge
// the job for it. Usage entries for assigned equipment are excluded from
// the Equipment line for that reason; only unassigned/shared equipment
// (tools, machinery nobody personally drives home) is costed here.

interface TimeEntry {
  staff_id: string;
  hours: number | null;
}

interface StaffCostProfile {
  staff_id: string;
  hourly_rate: number;
  super_rate: number;
  workers_comp_rate: number;
  leave_loading_rate: number;
  annual_fixed_oncosts: number;
  target_hours_per_week: number;
}

interface Expense {
  amount: number;
}

interface EquipmentUsage {
  equipment_id: string;
  hours: number;
}

interface EquipmentOption extends EquipmentCostInputs {
  id: string;
  assigned_to?: string | null;
}

interface Invoice {
  id: string;
  subtotal: number;
  status: string;
}

interface Props {
  timeEntries: TimeEntry[];
  staffCostProfiles: StaffCostProfile[];
  expenses: Expense[];
  equipmentUsage: EquipmentUsage[];
  equipmentOptions: EquipmentOption[];
  invoices: Invoice[];
}

export function JobProfitability({ timeEntries, staffCostProfiles, expenses, equipmentUsage, equipmentOptions, invoices }: Props) {
  // Vehicles assigned to a staff member fold their $/hour into that staff
  // member's loaded rate (mirrors the Reports page's staffEfficiency
  // section) so labourCost below already reflects vehicle cost for
  // whichever technician drives it.
  const vehicleCostPerHourByStaff = new Map<string, number>();
  equipmentOptions.forEach((eq) => {
    if (!eq.assigned_to) return;
    vehicleCostPerHourByStaff.set(
      eq.assigned_to,
      (vehicleCostPerHourByStaff.get(eq.assigned_to) ?? 0) + computeEquipmentCost(eq).costPerHour
    );
  });

  const rateByStaff = new Map(
    staffCostProfiles.map((p) => [
      p.staff_id,
      computeLoadedCost({ ...p, vehicle_cost_per_hour: vehicleCostPerHourByStaff.get(p.staff_id) ?? 0 }).loadedHourlyRate,
    ])
  );
  const labourCost = timeEntries.reduce((sum, e) => sum + Number(e.hours ?? 0) * (rateByStaff.get(e.staff_id) ?? 0), 0);
  const labourHours = timeEntries.reduce((sum, e) => sum + Number(e.hours ?? 0), 0);

  // Hours logged by staff whose loaded rate resolves to $0 -- either they have
  // no staff_cost_profiles row, or their profile has hourly_rate/target hours
  // of 0. Those hours silently cost nothing, which quietly overstates the
  // margin (e.g. job #829 showed a 91% margin purely because the tech who
  // logged the time had no wage on file). Surface it instead of hiding it.
  const uncostedHours = timeEntries.reduce(
    (sum, e) => sum + ((rateByStaff.get(e.staff_id) ?? 0) === 0 ? Number(e.hours ?? 0) : 0),
    0
  );
  const uncostedStaffCount = new Set(
    timeEntries.filter((e) => (rateByStaff.get(e.staff_id) ?? 0) === 0 && Number(e.hours ?? 0) > 0).map((e) => e.staff_id)
  ).size;

  const materialsCost = expenses.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);

  const equipmentById = new Map(equipmentOptions.map((eq) => [eq.id, eq]));
  // Exclude usage of equipment already assigned to a staff member -- its
  // cost is already counted above via that staff member's loaded rate.
  const unassignedEquipmentUsage = equipmentUsage.filter((u) => !equipmentById.get(u.equipment_id)?.assigned_to);
  const excludedEquipmentUsageCount = equipmentUsage.length - unassignedEquipmentUsage.length;
  const equipmentCost = unassignedEquipmentUsage.reduce((sum, u) => {
    const eq = equipmentById.get(u.equipment_id);
    const costPerHour = eq ? computeEquipmentCost(eq).costPerHour : 0;
    return sum + Number(u.hours) * costPerHour;
  }, 0);

  const totalCost = labourCost + materialsCost + equipmentCost;
  const revenue = invoices.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + Number(i.subtotal ?? 0), 0);
  const hasRevenue = revenue > 0;
  const margin = revenue - totalCost;
  const marginPct = hasRevenue ? (margin / revenue) * 100 : null;

  const rows = [
    { label: "Labour", value: labourCost, detail: `${labourHours.toFixed(1)}h logged` },
    { label: "Materials / Other Expenses", value: materialsCost, detail: `${expenses.length} expense${expenses.length === 1 ? "" : "s"}` },
    {
      label: "Equipment",
      value: equipmentCost,
      detail: `${unassignedEquipmentUsage.length} usage entr${unassignedEquipmentUsage.length === 1 ? "y" : "ies"}`,
    },
  ];

  return (
    <div className="p-6 space-y-6 max-w-xl">
      <Card>
        <CardHeader><CardTitle className="text-base">True Job Cost</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between text-sm">
              <div>
                <span className="text-slate-600">{row.label}</span>
                <span className="text-xs text-slate-400 ml-2">{row.detail}</span>
              </div>
              <span className="font-medium text-slate-800">${row.value.toFixed(2)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between text-sm pt-2 border-t">
            <span className="font-medium text-slate-700">Total Cost (ex GST)</span>
            <span className="font-bold text-slate-900">${totalCost.toFixed(2)}</span>
          </div>
          {uncostedHours > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
              <span className="font-semibold">⚠ Labour is under-costed.</span>{" "}
              {uncostedHours.toFixed(1)}h logged by {uncostedStaffCount} staff member{uncostedStaffCount === 1 ? "" : "s"} with
              no hourly rate on file, so {uncostedStaffCount === 1 ? "their" : "those"} hours count as $0 here and the margin
              above is overstated. Set the rate in each staff member&apos;s cost profile to fix this.
            </div>
          )}
          {excludedEquipmentUsageCount > 0 && (
            <p className="text-xs text-slate-400">
              {excludedEquipmentUsageCount} equipment usage entr{excludedEquipmentUsageCount === 1 ? "y" : "ies"} for vehicles already
              assigned to a technician {excludedEquipmentUsageCount === 1 ? "isn't" : "aren't"} counted separately here — that
              vehicle&apos;s cost is already included in Labour via their loaded hourly rate.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Revenue vs Cost</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">Invoiced (ex GST)</span>
            <span className="font-medium text-slate-800">${revenue.toFixed(2)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">Total Cost</span>
            <span className="font-medium text-slate-800">${totalCost.toFixed(2)}</span>
          </div>
          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 flex items-center justify-between mt-2">
            <div>
              <p className="text-xs text-slate-500">Margin</p>
              <p className={`text-lg font-bold flex items-center gap-1 ${margin >= 0 ? "text-green-700" : "text-red-600"}`}>
                {margin >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                ${margin.toFixed(2)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">Margin %</p>
              <p className={`text-lg font-bold ${margin >= 0 ? "text-green-700" : "text-red-600"}`}>
                {marginPct === null ? "—" : `${marginPct.toFixed(1)}%`}
              </p>
            </div>
          </div>
          {!hasRevenue && (
            <p className="text-xs text-slate-400">No invoice raised for this job yet — margin will show once it&apos;s invoiced.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
