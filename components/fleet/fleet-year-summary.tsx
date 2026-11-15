"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarRange } from "lucide-react";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, summariseExpenses, type FleetExpense, type Period } from "@/lib/fleet-costs";

const money = (n: number) => `$${n.toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;

/** Whole-fleet logged cost for one financial year, by category. */
export function FleetYearSummary({
  expenses,
  years,
  period,
  onPeriodChange,
}: {
  expenses: FleetExpense[];
  years: Period[];
  period: Period;
  onPeriodChange: (label: string) => void;
}) {
  const s = useMemo(() => summariseExpenses(expenses, period), [expenses, period]);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-1.5"><CalendarRange className="w-4 h-4" />Fleet costs logged — {period.label}</span>
          <select
            aria-label="Financial year"
            value={period.label}
            onChange={(e) => onPeriodChange(e.target.value)}
            className="text-xs font-normal border border-slate-200 rounded-md px-2 py-1 bg-white"
          >
            {years.map((y) => <option key={y.label} value={y.label}>{y.label}</option>)}
          </select>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
          <div>
            <p className="text-xs text-slate-500">Total (ex GST)</p>
            <p className="text-base font-semibold text-slate-900 tabular-nums">{money(s.totalExGst)}</p>
          </div>
          {EXPENSE_CATEGORIES.map((c) => (
            <div key={c}>
              <p className="text-xs text-slate-500">{EXPENSE_CATEGORY_LABELS[c]}</p>
              <p className="text-sm font-medium text-slate-700 tabular-nums">{money(s.byCategory[c]?.exGst ?? 0)}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
