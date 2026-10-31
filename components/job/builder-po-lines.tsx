"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";
import { remainingToSplit, type BuilderPoLineInput, type CostCentreOption } from "@/lib/builder-po";

// The split of a builder's PO value across cost centres (lib/builder-po.ts).
// Used by the New Job form and the job's PO tab, so the office enters a
// builder PO the same way in both places.

export interface StageOption {
  cost_centre_id: string | null;
  name: string;
}

export const blankLine = (): BuilderPoLineInput => ({ costCentreId: "", stage: "", amount: "", hours: "" });

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function BuilderPoLines({
  value,
  lines,
  onChange,
  costCentres,
  stages,
}: {
  /** The PO value as typed, for the running "unallocated" figure. */
  value: string;
  lines: BuilderPoLineInput[];
  onChange: (lines: BuilderPoLineInput[]) => void;
  costCentres: CostCentreOption[];
  stages: StageOption[];
}) {
  const set = (i: number, patch: Partial<BuilderPoLineInput>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const num = (s: string) => Number(s.replace(/[$,\s]/g, "")) || 0;
  const total = num(value);
  const split = lines.reduce((s, l) => s + num(l.amount), 0);
  const left = Math.round((total - split) * 100) / 100;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-12 gap-2 text-xs text-slate-400 font-medium px-1">
        <span className="col-span-4">Cost centre *</span>
        <span className="col-span-3">Stage</span>
        <span className="col-span-2 text-right">$ ex GST</span>
        <span className="col-span-2 text-right">Hours</span>
      </div>
      {lines.map((l, i) => {
        const stageOptions = stages.filter((s) => s.cost_centre_id === l.costCentreId);
        return (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <select
              value={l.costCentreId}
              onChange={(e) => set(i, { costCentreId: e.target.value, stage: "" })}
              className={`col-span-4 h-8 rounded-md border bg-white px-2 text-sm ${l.costCentreId ? "border-slate-200" : "border-orange-300"}`}
            >
              <option value="">Pick…</option>
              {costCentres.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select
              value={l.stage}
              onChange={(e) => set(i, { stage: e.target.value })}
              disabled={stageOptions.length === 0}
              className="col-span-3 h-8 rounded-md border border-slate-200 bg-white px-2 text-sm disabled:text-slate-300"
            >
              <option value="">{stageOptions.length === 0 ? "—" : "Whole cost centre"}</option>
              {stageOptions.map((s) => (
                <option key={s.name} value={s.name}>{s.name}</option>
              ))}
            </select>
            <Input
              inputMode="decimal"
              value={l.amount}
              onChange={(e) => set(i, { amount: e.target.value })}
              placeholder="0.00"
              className="col-span-2 h-8 text-sm text-right"
            />
            <Input
              inputMode="decimal"
              value={l.hours}
              onChange={(e) => set(i, { hours: e.target.value })}
              placeholder="0"
              className="col-span-2 h-8 text-sm text-right"
            />
            <button
              type="button"
              onClick={() => onChange(lines.length > 1 ? lines.filter((_, j) => j !== i) : [blankLine()])}
              className="col-span-1 flex justify-end text-slate-300 hover:text-red-400 transition-colors"
              aria-label="Remove line"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-1">
        <Button
          type="button" variant="ghost" size="sm" className="gap-1 h-7 text-xs"
          onClick={() => onChange([...lines, { ...blankLine(), amount: remainingToSplit(value, lines) }])}
        >
          <Plus className="w-3 h-3" />Add cost centre
        </Button>
        {total > 0 && (
          <span className={`text-xs font-medium ${left === 0 ? "text-green-600" : left > 0 ? "text-orange-600" : "text-red-600"}`}>
            {left === 0 ? "Fully split" : left > 0 ? `${money(left)} not split yet` : `Split is ${money(-left)} over the PO value`}
          </span>
        )}
      </div>
    </div>
  );
}
