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
  const rateByStaff = new Map(staffCostProfiles.map((p) => [p.staff_id, computeLoadedCost(p).loadedHourlyRate]));
  const labourCost = timeEntries.reduce((sum, e) => sum + Number(e.hours ?? 0) * (rateByStaff.get(e.staff_id) ?? 0), 0);
  const labourHours = timeEntries.reduce((sum, e) => sum + Number(e.hours ?? 0), 0);

  const materialsCost = expenses.reduce((sum, e) => sum + Number(e.amount ?? 0), 0);

  const equipmentById = new Map(equipmentOptions.map((eq) => [eq.id, eq]));
  const equipmentCost = equipmentUsage.reduce((sum, u) => {
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
    { label: "Equipment", value: equipmentCost, detail: `${equipmentUsage.length} usage entr${equipmentUsage.length === 1 ? "y" : "ies"}` },
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
