"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarRange } from "lucide-react";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  financialYearsSince,
  summariseExpenses,
  type FleetExpense,
} from "@/lib/fleet-costs";

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthLabel = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-AU", { month: "short", timeZone: "UTC" });

/**
 * One vehicle's logged costs for a financial year (1 Jul – 30 Jun), by
 * category and by month, against its estimated annual cost. Recomputes from
 * the expenses list it is given, so adding an expense updates it immediately.
 */
export function EquipmentYearCost({
  expenses,
  usage,
  today,
  estimatedAnnualCost,
}: {
  expenses: FleetExpense[];
  usage: { usage_date: string; hours: number | string }[];
  today: string;
  estimatedAnnualCost: number;
}) {
  const years = useMemo(() => financialYearsSince(expenses.map((e) => e.expense_date), today), [expenses, today]);
  const [label, setLabel] = useState(years[0].label);
  const period = years.find((y) => y.label === label) ?? years[0];
  const summary = useMemo(() => summariseExpenses(expenses, period), [expenses, period]);
  const hours = usage
    .filter((u) => u.usage_date >= period.start && u.usage_date <= period.end)
    .reduce((s, u) => s + (Number(u.hours) || 0), 0);
  const peak = Math.max(1, ...summary.byMonth.map((m) => m.exGst));
  const isCurrent = period === years[0];
  const overEstimate = estimatedAnnualCost > 0 && summary.totalExGst > estimatedAnnualCost;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-1.5"><CalendarRange className="w-4 h-4" />Costs logged — {period.label}</span>
          <select
            aria-label="Financial year"
            value={period.label}
            onChange={(e) => setLabel(e.target.value)}
            className="text-xs font-normal border border-slate-200 rounded-md px-2 py-1 bg-white"
          >
            {years.map((y) => <option key={y.label} value={y.label}>{y.label}</option>)}
          </select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label={isCurrent ? "Spent so far (ex GST)" : "Spent (ex GST)"} value={money(summary.totalExGst)} />
          <Stat label="GST" value={money(summary.totalGst)} />
          <Stat label="Expenses" value={String(summary.count)} />
          <Stat label="Hours logged" value={`${hours.toFixed(1)}h`} />
        </div>

        {summary.count === 0 ? (
          <p className="text-sm text-slate-400">No expenses logged for {period.label}.</p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b">
                  <th className="text-left font-medium py-1.5">Category</th>
                  <th className="text-right font-medium py-1.5">Items</th>
                  <th className="text-right font-medium py-1.5">Ex GST</th>
                  <th className="text-right font-medium py-1.5 hidden sm:table-cell">Share</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {EXPENSE_CATEGORIES.filter((c) => summary.byCategory[c]).map((c) => {
                  const row = summary.byCategory[c];
                  return (
                    <tr key={c}>
                      <td className="py-1.5 text-slate-700">{EXPENSE_CATEGORY_LABELS[c]}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500">{row.count}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(row.exGst)}</td>
                      <td className="py-1.5 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                        {summary.totalExGst > 0 ? `${Math.round((row.exGst / summary.totalExGst) * 100)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div>
              <p className="text-xs text-slate-500 mb-1.5">By month</p>
              <div className="grid grid-cols-12 gap-1 items-end h-20" role="img" aria-label={`Monthly costs for ${period.label}`}>
                {summary.byMonth.map((m) => (
                  <div key={m.month} className="flex flex-col items-center gap-1 h-full justify-end" title={`${monthLabel(m.month)}: ${money(m.exGst)}`}>
                    <div className="w-full rounded-sm bg-blue-500/80" style={{ height: `${Math.max(m.exGst > 0 ? 4 : 0, (m.exGst / peak) * 100)}%` }} />
                    <span className="text-[10px] text-slate-400">{monthLabel(m.month).slice(0, 1)}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {estimatedAnnualCost > 0 && (
          <p className={`text-xs ${overEstimate ? "text-amber-700" : "text-slate-500"}`}>
            Estimated annual running cost from the cost profile: {money(estimatedAnnualCost)} (includes depreciation, which isn&apos;t a logged expense).
            {overEstimate && " Logged costs are already above it."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-base font-semibold text-slate-900 tabular-nums">{value}</p>
    </div>
  );
}
