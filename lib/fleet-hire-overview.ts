// Fleet → Hire rates (office/admin): every machine Day Works lists, with its
// hire options and rates, so a machine the office hasn't priced yet is seen at
// a glance instead of silently missing from the job's Day Works picker.
//
// Office-only by construction: it is built from equipment_hire_options, which
// RLS gives to office/admin alone, and only rendered for them.

import { isHireableMachine } from "@/lib/day-works-view";
import { hireOptionLabel, type HireType, type HireUnit } from "@/lib/hire-pricing";

export interface FleetHireMachineInput {
  id: string;
  name: string;
  category?: string | null;
  is_active: boolean | null;
}

export interface FleetHireOptionInput {
  equipment_id: string;
  hire_type: HireType;
  hire_unit: HireUnit;
  rate: number | string | null;
  float_base?: number | string | null;
  float_km_included?: number | string | null;
  float_per_km?: number | string | null;
  fuel_included?: boolean | null;
  whole_days_only?: boolean | null;
  is_active?: boolean | null;
}

export interface FleetHireRow {
  id: string;
  name: string;
  category: string | null;
  /** Active options first; switched-off ones are listed (greyed) but don't count as a rate. */
  options: { label: string; rateText: string; active: boolean }[];
  hasRate: boolean;
}

const num = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const money = (v: number) => `$${v.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const UNIT_SUFFIX: Record<HireUnit, string> = {
  hour: "/hr",
  day: "/day",
  engine_hour: "/engine hr",
  km: "/km",
  contract: " contract",
  move: "/move",
};

/** "$115.37/hr", "$251.19/day, full days", "$470.00 base, 30 km incl., then $5.00/km". Ex GST. */
export function hireRateText(o: FleetHireOptionInput): string {
  if (o.hire_type === "float" || o.hire_unit === "move") {
    return `${money(num(o.float_base))} base, ${num(o.float_km_included)} km incl., then ${money(num(o.float_per_km))}/km`;
  }
  const extras = [o.whole_days_only ? "full days" : null, o.hire_type === "wet" || o.hire_type === "dry" ? (o.fuel_included ? "fuel incl." : "no fuel") : null].filter(Boolean);
  return `${money(num(o.rate))}${UNIT_SUFFIX[o.hire_unit]}${extras.length ? `, ${extras.join(", ")}` : ""}`;
}

/**
 * Every active non-tool machine (the rule Day Works and 0108's seed use), with
 * its hire options. Machines with no active option come first, then A–Z.
 */
export function fleetHireOverview(
  equipment: FleetHireMachineInput[],
  options: FleetHireOptionInput[]
): { rows: FleetHireRow[]; missing: number } {
  const byMachine = new Map<string, FleetHireOptionInput[]>();
  for (const o of options) (byMachine.get(o.equipment_id) ?? byMachine.set(o.equipment_id, []).get(o.equipment_id)!).push(o);
  const rows: FleetHireRow[] = equipment
    .filter((m) => isHireableMachine({ is_active: m.is_active, category: m.category }))
    .map((m) => {
      const mine = (byMachine.get(m.id) ?? [])
        .map((o) => ({ label: hireOptionLabel(o), rateText: hireRateText(o), active: o.is_active !== false }))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label));
      return { id: m.id, name: m.name, category: m.category ?? null, options: mine, hasRate: mine.some((o) => o.active) };
    })
    .sort((a, b) => Number(a.hasRate) - Number(b.hasRate) || a.name.localeCompare(b.name));
  return { rows, missing: rows.filter((r) => !r.hasRate).length };
}
