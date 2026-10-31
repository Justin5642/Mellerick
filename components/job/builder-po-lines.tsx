"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
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

// Picked from the cost centre list to add a new company cost centre on the
// spot (Justin, 31 Oct 2026: "a button to add a different one if it is a
// different type of job"). It joins the company list in Settings too.
const NEW_CENTRE = "__new__";

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function BuilderPoLines({
  value,
  lines,
  onChange,
  costCentres,
  stages,
  loadError,
  onCostCentreAdded,
}: {
  /** The PO value as typed, for the running "unallocated" figure. */
  value: string;
  lines: BuilderPoLineInput[];
  onChange: (lines: BuilderPoLineInput[]) => void;
  costCentres: CostCentreOption[];
  stages: StageOption[];
  /** The cost centre list couldn't be read — say so instead of an empty list. */
  loadError?: boolean;
  /** A cost centre added here, for the parent to add to its list. */
  onCostCentreAdded?: (c: CostCentreOption) => void;
}) {
  const [addingFor, setAddingFor] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [savingNew, setSavingNew] = useState(false);

  const set = (i: number, patch: Partial<BuilderPoLineInput>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function addCentre(i: number) {
    const name = newName.trim();
    if (!name) return;
    const existing = costCentres.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      set(i, { costCentreId: existing.id, stage: "" });
      setAddingFor(null);
      setNewName("");
      return;
    }
    setSavingNew(true);
    const { data, error } = await createClient()
      .from("cost_centres")
      .insert({ name, sort_order: 100 })
      .select("id, name")
      .single();
    setSavingNew(false);
    if (error || !data) {
      toast.error(error?.code === "23505" ? `There's already a cost centre called ${name} (it may be switched off in Settings).` : "Couldn't add the cost centre.");
      return;
    }
    onCostCentreAdded?.(data as CostCentreOption);
    set(i, { costCentreId: data.id, stage: "" });
    setAddingFor(null);
    setNewName("");
    toast.success(`${name} added to your cost centres`);
  }

  const num = (s: string) => Number(s.replace(/[$,\s]/g, "")) || 0;
  const total = num(value);
  const split = lines.reduce((s, l) => s + num(l.amount), 0);
  const left = Math.round((total - split) * 100) / 100;

  return (
    <div className="space-y-2">
      {loadError && (
        <p className="text-xs text-red-600">Couldn&apos;t load your cost centres. Refresh the page to try again.</p>
      )}
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
            {addingFor === i ? (
              <div className="col-span-4 flex gap-1">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); addCentre(i); }
                    if (e.key === "Escape") { setAddingFor(null); setNewName(""); }
                  }}
                  placeholder="New cost centre"
                  className="h-8 text-sm"
                  autoFocus
                />
                <Button type="button" size="sm" className="h-8 px-2 text-xs" onClick={() => addCentre(i)} disabled={savingNew || !newName.trim()}>
                  Add
                </Button>
              </div>
            ) : (
              <select
                value={l.costCentreId}
                onChange={(e) => {
                  if (e.target.value === NEW_CENTRE) { setAddingFor(i); setNewName(""); return; }
                  set(i, { costCentreId: e.target.value, stage: "" });
                }}
                className={`col-span-4 h-8 rounded-md border bg-white px-2 text-sm ${l.costCentreId ? "border-slate-200" : "border-orange-300"}`}
              >
                <option value="">Pick…</option>
                {costCentres.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value={NEW_CENTRE}>+ New cost centre…</option>
              </select>
            )}
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
