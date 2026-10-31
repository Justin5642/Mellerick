"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";
import {
  belowMinimumMargin,
  computeJobLedger,
  loadedRatesByStaff,
  plantCosts,
  type EquipmentInput,
  type StaffCostProfileInput,
} from "@/lib/job-ledger";

// The job ledger card at the top of the Costing tab (admin only, like the rest
// of the tab — labour cost comes from payroll data). Budget per cost centre
// from the builder's PO split, against cost so far, and the margin that
// leaves, flagged under the company minimum. The maths is lib/job-ledger.ts.

interface Props {
  purchaseOrders: { total_value: number | null; po_cost_centers?: { id: string; cost_centre_id?: string | null; allocated_amount: number | null; allocated_hours: number | null }[] }[];
  timeEntries: { staff_id: string; hours: number | null; cost_center_id: string | null; entry_type?: string | null }[];
  expenses: { amount: number | null; cost_center_id: string | null }[];
  vendorOrders: { amount: number | null; cost_center_id: string | null; status: string }[];
  equipmentUsage: { equipment_id: string; hours: number }[];
  equipmentOptions: EquipmentInput[];
  staffCostProfiles: StaffCostProfileInput[];
  minMarginPct: number;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;

export function JobLedger({ purchaseOrders, timeEntries, expenses, vendorOrders, equipmentUsage, equipmentOptions, staffCostProfiles, minMarginPct }: Props) {
  const [costCentres, setCostCentres] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    createClient()
      .from("cost_centres")
      .select("id, name")
      .order("sort_order")
      .then(({ data }) => setCostCentres((data as { id: string; name: string }[]) ?? []));
  }, []);

  const ledger = useMemo(
    () =>
      computeJobLedger({
        costCentres,
        lines: purchaseOrders.flatMap((p) => p.po_cost_centers ?? []),
        poTotal: purchaseOrders.reduce((s, p) => s + Number(p.total_value ?? 0), 0),
        timeEntries,
        ratesByStaff: loadedRatesByStaff(staffCostProfiles, equipmentOptions),
        expenses,
        supplierOrders: vendorOrders,
        plant: plantCosts(equipmentUsage, equipmentOptions),
      }),
    [costCentres, purchaseOrders, timeEntries, staffCostProfiles, equipmentOptions, expenses, vendorOrders, equipmentUsage]
  );

  if (ledger.budget === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Job Ledger</CardTitle></CardHeader>
        <CardContent className="text-sm text-slate-500">
          No builder PO on this job yet. Add one on the Purchase Orders tab (value split by cost centre) to see the budget
          and live margin here.
        </CardContent>
      </Card>
    );
  }

  const flagged = belowMinimumMargin(ledger, minMarginPct);
  const marginColour = flagged ? "text-red-600" : "text-green-700";

  return (
    <Card className={flagged ? "border-red-300" : ""}>
      <CardHeader><CardTitle className="text-base">Job Ledger</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Builder&apos;s price</p>
            <p className="text-lg font-bold text-slate-900">{money(ledger.budget)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Cost so far</p>
            <p className="text-lg font-bold text-slate-900">{money(ledger.cost)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Margin left</p>
            <p className={`text-lg font-bold ${marginColour}`}>
              {money(ledger.margin)} <span className="text-sm">({ledger.marginPct?.toFixed(0)}%)</span>
            </p>
          </div>
        </div>

        {flagged && (
          <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-800">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              This job has already used enough of the builder&apos;s price that, even with nothing more to spend, it is under
              your {minMarginPct.toFixed(0)}% minimum margin.
            </span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-400 text-right">
                <th className="text-left font-medium pb-2">Cost centre</th>
                <th className="font-medium pb-2">Budget</th>
                <th className="font-medium pb-2">Labour</th>
                <th className="font-medium pb-2">Materials</th>
                <th className="font-medium pb-2">Plant</th>
                <th className="font-medium pb-2">Cost</th>
                <th className="font-medium pb-2">Left</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ledger.rows.map((r) => {
                const left = r.budget - r.cost;
                const over = r.budget > 0 && left < 0;
                return (
                  <tr key={r.key} className="text-right">
                    <td className="text-left py-2">
                      <span className="font-medium text-slate-800">{r.name}</span>
                      {r.hours > 0 && (
                        <span className="block text-xs text-slate-400">
                          {r.hours.toFixed(1)}h{r.budgetHours > 0 ? ` of ${r.budgetHours.toFixed(1)}h` : ""}
                        </span>
                      )}
                      {r.unpricedOrders > 0 && (
                        <span className="block text-xs text-amber-600">
                          {r.unpricedOrders} supplier PO{r.unpricedOrders === 1 ? "" : "s"} not priced yet
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-slate-600">{r.budget ? money(r.budget) : "—"}</td>
                    <td className="py-2 text-slate-600">{r.labour ? money(r.labour) : "—"}</td>
                    <td className="py-2 text-slate-600">{r.materials ? money(r.materials) : "—"}</td>
                    <td className="py-2 text-slate-600">{r.plant ? money(r.plant) : "—"}</td>
                    <td className="py-2 font-medium text-slate-800">{money(r.cost)}</td>
                    <td className={`py-2 font-medium ${over ? "text-red-600" : "text-slate-800"}`}>{r.budget ? money(left) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="space-y-1 text-xs text-slate-500">
          {ledger.unsplit !== 0 && (
            <p className="text-amber-700">
              {ledger.unsplit > 0
                ? `${money(ledger.unsplit)} of the builder's price isn't split across cost centres yet (Purchase Orders tab).`
                : `The cost centre budgets add up to ${money(-ledger.unsplit)} more than the builder's price.`}
            </p>
          )}
          {ledger.uncostedHours > 0 && (
            <p className="text-amber-700">
              {ledger.uncostedHours.toFixed(1)}h were logged by staff with no hourly rate on file and count as $0, so cost is
              understated.
            </p>
          )}
          {ledger.unpricedOrders > 0 && (
            <p>Supplier POs not priced yet aren&apos;t in the cost until their invoice amount is entered.</p>
          )}
          <p>Ex GST. Plant isn&apos;t tagged to a cost centre yet, so it shows under &quot;Not tagged&quot;.</p>
        </div>
      </CardContent>
    </Card>
  );
}
