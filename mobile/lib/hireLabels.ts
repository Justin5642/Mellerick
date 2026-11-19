// Hire setup vocabulary for Fleet → Hire setup on the phone (office/admin).
// A copy of the constants in the web's lib/hire-pricing.ts — the same values,
// pinned by tests/unit/fleet-mobile-mirror.test.ts. Includes the cartage
// tonne / m³ units (0111), which only truck loads are charged in.
//
// (mobile/lib/dayWorks.ts has its own narrower HireUnit for Day Works entries,
// which never use tonne / m³.)

export type HireType = "wet" | "dry" | "cartage" | "float";
export type HireUnit = "hour" | "day" | "engine_hour" | "km" | "contract" | "move" | "tonne" | "m3";

/** Which units each hire type may be charged in — mirrors the table's check constraint. */
export const HIRE_UNITS_BY_TYPE: Record<HireType, HireUnit[]> = {
  wet: ["hour"],
  dry: ["day", "engine_hour"],
  cartage: ["hour", "km", "contract", "tonne", "m3"],
  float: ["move"],
};

export const HIRE_TYPE_LABELS: Record<HireType, string> = {
  wet: "Wet hire",
  dry: "Dry hire",
  cartage: "Cartage",
  float: "Float",
};

export const HIRE_UNIT_LABELS: Record<HireUnit, string> = {
  hour: "per hour",
  day: "per day",
  engine_hour: "per engine hour",
  km: "per km",
  contract: "contract",
  move: "per move",
  tonne: "per tonne (truck loads)",
  m3: "per m³ (truck loads)",
};

/** The company cost centre a hire type falls under when the setup names none. */
export const DEFAULT_COST_CENTRE_BY_TYPE: Record<HireType, string> = {
  wet: "Plant Wet Hire",
  dry: "Plant Dry Hire",
  cartage: "Truck Cartage",
  float: "Float Moves",
};

export function hireOptionLabel(o: { hire_type: HireType; hire_unit: HireUnit }): string {
  if (o.hire_type === "float") return "Float move";
  if (o.hire_type === "dry" && o.hire_unit === "engine_hour") return "Dry hire, per engine hour";
  if (o.hire_type === "cartage" && o.hire_unit === "contract") return "Cartage, contract";
  return `${HIRE_TYPE_LABELS[o.hire_type]}, ${HIRE_UNIT_LABELS[o.hire_unit]}`;
}

/** Float = base + max(0, km − included) × per km (the web's floatMoveCharge). */
export function floatMoveCharge(
  km: number,
  o: { float_base: number | string; float_km_included: number | string; float_per_km: number | string },
): number {
  const base = Number(o.float_base) || 0;
  const included = Number(o.float_km_included) || 0;
  const perKm = Number(o.float_per_km) || 0;
  return Math.round((base + Math.max(0, km - included) * perKm) * 100) / 100;
}
