// Truck loads (cartage) pricing — migration 0111 (drafted — not applied yet), Nov 2026. Pure, beside
// lib/hire-pricing.ts, so the job's Day Works tab, the invoice builder and any
// later report price a load the same way.
//
// Justin (17 Nov 2026):
//   - "Some jobs include quarry products, some don't." A material-in load is
//     INCLUDED (in the quoted price: a cost only, never invoiced) or EXTRA.
//     jobs.quarry_included is the job's default (null = included).
//   - "The spoil removal is almost always an extra charge." Spoil out
//     defaults to EXTRA.
//   - Spoil cartage is charged per tonne or per m³ (from the tip docket) at
//     the truck's own rate (equipment_hire_options, cartage × tonne / m3).
//   - Quarry product and tip fees charged on are cost + margin + km:
//       docket cost (ex GST) × (1 + margin%) + km × the truck's per-km rate.
//     The margin is a company setting (billing_rate_config.cartage_margin_pct),
//     overridable per load by the office (cartage_load_costs.margin_pct).
//
//   Extra spoil    = quantity × per-tonne/m³ rate + tip fee × (1 + margin) + km × per km
//   Extra material = product cost × (1 + margin) + km × per km
//                    (+ quantity × per-tonne/m³ rate when the truck has one for the load's unit)
//
// Never prices an extra at $0 silently: a missing rate or docket cost is a
// `problem`, and invoicing refuses it.
//
// Everything here is ex GST and comes from office-only tables; call it on
// office pages and office routes only. A technician's view of a load is
// quantities only (lib/cartage-view.ts).

import type { DayWorksInvoiceLine, HireOption, HireStatus } from "@/lib/hire-pricing";

export type LoadDirection = "material_in" | "spoil_out";
export type LoadUnit = "tonne" | "m3" | "load";
export type LoadBilling = "included" | "extra";
export type LoadStatus = HireStatus;

export const LOAD_DIRECTIONS: LoadDirection[] = ["material_in", "spoil_out"];
export const LOAD_UNITS_ALL: LoadUnit[] = ["tonne", "m3", "load"];

/** The company margin when billing_rate_config has none yet (0111's default). */
export const DEFAULT_CARTAGE_MARGIN_PCT = 15;

export const DIRECTION_LABELS: Record<LoadDirection, string> = {
  material_in: "Material in",
  spoil_out: "Spoil out",
};

const UNIT_SHORT: Record<LoadUnit, [string, string]> = {
  tonne: ["t", "t"],
  m3: ["m³", "m³"],
  load: ["load", "loads"],
};

export function loadQuantityText(quantity: number | string | null | undefined, unit: LoadUnit): string {
  const q = num(quantity);
  const [one, many] = UNIT_SHORT[unit] ?? ["", ""];
  return `${q} ${q === 1 ? one : many}`;
}

/** Justin's defaults: spoil out → extra; material in → extra only when the job says quarry product is not included. */
export function defaultBilling(direction: LoadDirection, quarryIncluded: boolean | null | undefined): LoadBilling {
  if (direction === "spoil_out") return "extra";
  return quarryIncluded === false ? "extra" : "included";
}

/** cartage_loads row — quantities only. */
export interface CartageLoadQuantities {
  id: string;
  equipment_id: string;
  direction: LoadDirection;
  billing: LoadBilling;
  quantity: number | string | null;
  unit: LoadUnit;
  km: number | string | null;
  status?: LoadStatus | string;
}

/** cartage_load_costs row (office only). */
export interface LoadCost {
  docket_cost_ex_gst: number | string | null;
  margin_pct: number | string | null;
}

/** A truck's active cartage rates, ex GST. Null = not set up. */
export interface TruckRates {
  perKm: number | null;
  perTonne: number | null;
  perM3: number | null;
}

const num = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const has = (v: number | string | null | undefined) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const cents = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The truck's cartage rates from its hire setup (active options only). */
export function truckRates(options: (Pick<HireOption, "equipment_id" | "hire_type" | "hire_unit" | "rate"> & { is_active?: boolean | null })[], equipmentId: string): TruckRates {
  const pick = (unit: string) => {
    const o = options.find((x) => x.equipment_id === equipmentId && x.hire_type === "cartage" && x.hire_unit === unit && x.is_active !== false);
    return o ? num(o.rate) : null;
  };
  return { perKm: pick("km"), perTonne: pick("tonne"), perM3: pick("m3") };
}

const unitRate = (rates: TruckRates, unit: LoadUnit) => (unit === "tonne" ? rates.perTonne : unit === "m3" ? rates.perM3 : null);

export interface LoadPriceLine {
  label: string;
  amount: number;
}

export type LoadPrice =
  /** Included in the quoted price: never charged. `cost` is the docket cost, when entered. */
  | { kind: "included"; cost: number | null }
  | { kind: "extra"; ok: true; lines: LoadPriceLine[]; total: number; marginPct: number; cost: number }
  | { kind: "extra"; ok: false; problem: string };

/** The margin that applies to a load: its own override, else the company's. */
export function effectiveMargin(cost: Pick<LoadCost, "margin_pct"> | null | undefined, companyMarginPct: number | null | undefined): number {
  if (cost && has(cost.margin_pct)) return num(cost.margin_pct);
  return has(companyMarginPct) ? num(companyMarginPct) : DEFAULT_CARTAGE_MARGIN_PCT;
}

/** What one load is charged, with its breakdown, or why it can't be priced yet. */
export function priceLoad(load: CartageLoadQuantities, rates: TruckRates, cost: LoadCost | null | undefined, companyMarginPct: number | null | undefined): LoadPrice {
  const docket = cost && has(cost.docket_cost_ex_gst) ? num(cost.docket_cost_ex_gst) : null;
  if (load.billing !== "extra") return { kind: "included", cost: docket };

  const what = load.direction === "spoil_out" ? "tip fee" : "quarry product cost";
  const quantity = num(load.quantity);
  if (!(quantity > 0)) return { kind: "extra", ok: false, problem: "Enter how much was carted." };
  if (!has(load.km)) return { kind: "extra", ok: false, problem: "Enter the km travelled (0 if none)." };
  const km = num(load.km);
  if (km > 0 && rates.perKm === null) {
    return { kind: "extra", ok: false, problem: "This truck has no Cartage per km rate. Set it in Fleet → Hire setup." };
  }
  const rate = unitRate(rates, load.unit);
  if (load.direction === "spoil_out") {
    if (load.unit === "load") return { kind: "extra", ok: false, problem: "Spoil is charged per tonne or m³ — change the load's unit to the tip docket's." };
    if (rate === null) {
      return { kind: "extra", ok: false, problem: `This truck has no Cartage ${load.unit === "tonne" ? "per tonne" : "per m³"} rate. Set it in Fleet → Hire setup.` };
    }
  }
  if (docket === null) return { kind: "extra", ok: false, problem: `Enter the ${what} (ex GST) from the docket.` };

  const marginPct = effectiveMargin(cost, companyMarginPct);
  const lines: LoadPriceLine[] = [];
  if (rate !== null && load.unit !== "load") {
    lines.push({ label: `Cartage ${loadQuantityText(quantity, load.unit)} × ${money(rate)}`, amount: cents(quantity * rate) });
  }
  lines.push({
    label: `${load.direction === "spoil_out" ? "Tip fee" : "Quarry product"} ${money(docket)} + ${marginPct}%`,
    amount: cents(docket * (1 + marginPct / 100)),
  });
  if (km > 0) lines.push({ label: `${km} km × ${money(rates.perKm!)}`, amount: cents(km * rates.perKm!) });
  const total = cents(lines.reduce((s, l) => s + l.amount, 0));
  return { kind: "extra", ok: true, lines, total, marginPct, cost: docket };
}

/** A priced extra's total, or null (included, or not yet priceable). */
export const loadTotal = (p: LoadPrice): number | null => (p.kind === "extra" && p.ok ? p.total : null);

export interface InvoiceableLoad extends CartageLoadQuantities {
  load_date: string;
  material?: string | null;
  place?: string | null;
  from_text?: string | null;
  to_text?: string | null;
  docket_number?: string | null;
  signer_name?: string | null;
  invoice_id?: string | null;
}

function fmtDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

const clean = (s: string | null | undefined) => (s ?? "").trim();

/** "Job site → Wollert tip": the typed from/to, else the job site and the quarry or tip. */
export function loadRoute(load: Pick<InvoiceableLoad, "direction" | "place" | "from_text" | "to_text">, siteLabel: string | null | undefined): string {
  const site = clean(siteLabel) || "job site";
  const from = clean(load.from_text) || (load.direction === "spoil_out" ? site : clean(load.place));
  const to = clean(load.to_text) || (load.direction === "spoil_out" ? clean(load.place) : site);
  return [from, to].filter(Boolean).join(" → ");
}

/**
 * The invoice line for one signed extra load: "Spoil removal 12 t — Lot 4
 * Smith St → Wollert tip, docket 1234", quantity 1 at the load's whole price
 * (so the line shows exactly the amount priced here; the margin is not shown
 * to the builder). Throws when the load isn't a signed extra or can't be priced.
 */
export function invoiceLineFromLoad(
  load: InvoiceableLoad,
  rates: TruckRates,
  cost: LoadCost | null | undefined,
  companyMarginPct: number | null | undefined,
  truckName: string,
  siteLabel: string | null | undefined
): DayWorksInvoiceLine {
  if (load.status !== "signed" || load.invoice_id) throw new Error("Only signed truck loads that are not yet invoiced can be invoiced.");
  if (load.billing !== "extra") throw new Error("An included truck load is in the quoted price and is never invoiced.");
  const price = priceLoad(load, rates, cost, companyMarginPct);
  if (price.kind !== "extra" || !price.ok) {
    throw new Error(`${truckName} load on ${fmtDate(load.load_date)}: ${price.kind === "extra" && !price.ok ? price.problem : "can't be priced."}`);
  }
  const what = load.direction === "spoil_out" ? "Spoil removal" : clean(load.material) || "Quarry product";
  const docket = clean(load.docket_number);
  const route = loadRoute(load, siteLabel);
  const name = `${what} ${loadQuantityText(load.quantity, load.unit)}${route ? ` — ${route}` : ""}${docket ? `, docket ${docket}` : ""}`;
  const parts = [fmtDate(load.load_date), truckName];
  if (num(load.km) > 0) parts.push(`${num(load.km)} km`);
  if (clean(load.signer_name)) parts.push(`signed by ${clean(load.signer_name)}`);
  return { name, description: parts.join(" · "), quantity: 1, unit_price: price.total };
}

/** Invoice lines for signed extra loads, oldest first. Throws on the first that can't be invoiced. */
export function invoiceLinesFromLoads(
  loads: InvoiceableLoad[],
  ratesFor: (equipmentId: string) => TruckRates,
  costs: Map<string, LoadCost>,
  companyMarginPct: number | null | undefined,
  truckNames: Map<string, string>,
  siteLabel: string | null | undefined
): DayWorksInvoiceLine[] {
  return [...loads]
    .sort((a, b) => a.load_date.localeCompare(b.load_date))
    .map((l) => invoiceLineFromLoad(l, ratesFor(l.equipment_id), costs.get(l.id) ?? null, companyMarginPct, truckNames.get(l.equipment_id) ?? "Truck", siteLabel));
}
