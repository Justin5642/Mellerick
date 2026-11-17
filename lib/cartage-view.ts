// What the "Truck loads" section of the job's Day Works tab is sent
// (GET /api/jobs/[id]/cartage-loads, migration 0111 (drafted — not applied yet)).
//
// THE MONEY RULE (HANDOVER §2): the route reads the office-only rate and cost
// tables through the service role, so THIS is the place a dollar figure could
// leak to a technician. Everything is copied field by field; rates, docket
// costs, margins, prices and the docket photo (it shows prices) are added only
// when `isOffice`. tests/unit/cartage-routes.test.ts walks the technician
// payload carries no money-named key and no rate or amount value at any depth.

import {
  defaultBilling,
  effectiveMargin,
  loadTotal,
  priceLoad,
  truckRates,
  type LoadBilling,
  type LoadCost,
  type LoadDirection,
  type LoadPriceLine,
  type LoadStatus,
  type LoadUnit,
} from "@/lib/cartage-pricing";
import type { HireOption } from "@/lib/hire-pricing";

/** A fleet item with its hire options (read by the service role). */
export interface TruckRow {
  id: string;
  name: string;
  is_active: boolean | null;
  category?: string | null;
  options: (Pick<HireOption, "hire_type" | "hire_unit" | "rate"> & { is_active?: boolean | null })[];
}

/** cartage_loads row as read under the caller's session. */
export interface LoadRow {
  id: string;
  job_id: string;
  equipment_id: string;
  load_date: string;
  direction: LoadDirection;
  material: string | null;
  supplier_id: string | null;
  place: string | null;
  from_text: string | null;
  to_text: string | null;
  quantity: number | string | null;
  unit: LoadUnit;
  km: number | string | null;
  docket_number: string | null;
  docket_photo_path: string | null;
  billing: LoadBilling;
  cost_centre_id: string | null;
  status: LoadStatus;
  signer_name: string | null;
  signature_path: string | null;
  signed_at: string | null;
  invoice_id: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_by_name?: string | null;
}

export interface TruckLoad {
  id: string;
  equipment_id: string;
  truck: string;
  load_date: string;
  direction: LoadDirection;
  material: string | null;
  supplier_id: string | null;
  place: string | null;
  from_text: string | null;
  to_text: string | null;
  quantity: number | null;
  unit: LoadUnit;
  km: number | null;
  docket_number: string | null;
  /** Whether a docket photo is attached. The photo itself (it shows prices) is office-only. */
  has_docket_photo: boolean;
  billing: LoadBilling;
  cost_centre: string | null;
  status: LoadStatus;
  signer_name: string | null;
  signed_at: string | null;
  signature_url: string | null;
  invoice_id: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_by_name: string | null;
}

/** Office/admin answers only. */
export interface TruckLoadsOfficePricing {
  /** Company margin (%), billing_rate_config.cartage_margin_pct. */
  companyMarginPct: number;
  loads: Record<
    string,
    {
      docketCost: number | null;
      /** The load's own margin override, or null = the company's. */
      marginOverride: number | null;
      marginPct: number;
      docketPhotoUrl: string | null;
      /** Priced extra: its total and breakdown. Included: null. */
      total: number | null;
      lines: LoadPriceLine[];
      /** Why an extra can't be priced (or invoiced) yet. */
      problem: string | null;
    }
  >;
  /** Signed extras not yet invoiced, priced. */
  uninvoicedSigned: number;
}

export interface TruckLoadsView {
  trucks: { id: string; name: string }[];
  /** Quarries to pick from (names only). */
  suppliers: { id: string; name: string; pinOrder: number | null }[];
  /** The job's default for quarry product (null = included). */
  quarryIncluded: boolean | null;
  /** Defaults for a new load's included/extra, per direction. */
  defaults: Record<LoadDirection, LoadBilling>;
  /** The job site, for a load's from/to. */
  siteLabel: string | null;
  loads: TruckLoad[];
  pricing?: TruckLoadsOfficePricing;
}

/** Trucks a load can be logged against: active, not a tool, and a vehicle or set up for cartage. */
export function isLoadTruck(m: Pick<TruckRow, "is_active" | "category" | "options">): boolean {
  if (m.is_active !== true || m.category === "tool") return false;
  return m.category === "vehicle" || m.options.some((o) => o.hire_type === "cartage" && o.is_active !== false);
}

const n = (v: number | string | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));

export function siteLabelOf(site: { name?: string | null; address_line1?: string | null; suburb?: string | null } | null | undefined): string | null {
  if (!site) return null;
  const street = [site.address_line1, site.suburb].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
  return street || (site.name ?? "").trim() || null;
}

export function buildTruckLoadsView(input: {
  isOffice: boolean;
  trucks: TruckRow[];
  suppliers: { id: string; name: string; pin_order?: number | null }[];
  loads: LoadRow[];
  quarryIncluded: boolean | null;
  siteLabel: string | null;
  costCentreNames: Map<string, string>;
  signatureUrls: Map<string, string>;
  /** Office only (ignored otherwise). */
  costs?: Map<string, LoadCost>;
  companyMarginPct?: number | null;
  docketUrls?: Map<string, string>;
}): TruckLoadsView {
  const { isOffice, trucks, loads, costCentreNames, signatureUrls } = input;
  const truckName = new Map(trucks.map((t) => [t.id, t.name]));

  const view: TruckLoadsView = {
    // Names only — never a rate.
    trucks: trucks
      .filter(isLoadTruck)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    suppliers: input.suppliers.map((s) => ({ id: s.id, name: s.name, pinOrder: s.pin_order ?? null })),
    quarryIncluded: input.quarryIncluded,
    defaults: { material_in: defaultBilling("material_in", input.quarryIncluded), spoil_out: defaultBilling("spoil_out", input.quarryIncluded) },
    siteLabel: input.siteLabel,
    loads: loads.map((l) => ({
      id: l.id,
      equipment_id: l.equipment_id,
      truck: truckName.get(l.equipment_id) ?? "Truck",
      load_date: l.load_date,
      direction: l.direction,
      material: l.material,
      supplier_id: l.supplier_id,
      place: l.place,
      from_text: l.from_text,
      to_text: l.to_text,
      quantity: n(l.quantity),
      unit: l.unit,
      km: n(l.km),
      docket_number: l.docket_number,
      has_docket_photo: !!l.docket_photo_path,
      billing: l.billing,
      cost_centre: l.cost_centre_id ? costCentreNames.get(l.cost_centre_id) ?? null : null,
      status: l.status,
      signer_name: l.signer_name,
      signed_at: l.signed_at,
      signature_url: l.signature_path ? signatureUrls.get(l.signature_path) ?? null : null,
      invoice_id: l.invoice_id,
      void_reason: l.void_reason,
      created_by: l.created_by,
      created_by_name: l.created_by_name ?? null,
    })),
  };
  if (!isOffice) return view;

  // Office only from here: rates, docket costs, margins → prices.
  const options = trucks.flatMap((t) => t.options.map((o) => ({ ...o, equipment_id: t.id })));
  const costs = input.costs ?? new Map<string, LoadCost>();
  const companyMarginPct = effectiveMargin(null, input.companyMarginPct);
  const entries = loads.map((l) => {
    const cost = costs.get(l.id) ?? null;
    const price = priceLoad(l, truckRates(options, l.equipment_id), cost, companyMarginPct);
    return { l, cost, price };
  });
  view.pricing = {
    companyMarginPct,
    loads: Object.fromEntries(
      entries.map(({ l, cost, price }) => [
        l.id,
        {
          docketCost: cost && n(cost.docket_cost_ex_gst) !== null ? Number(cost.docket_cost_ex_gst) : null,
          marginOverride: cost && n(cost.margin_pct) !== null ? Number(cost.margin_pct) : null,
          marginPct: effectiveMargin(cost, companyMarginPct),
          docketPhotoUrl: l.docket_photo_path ? input.docketUrls?.get(l.docket_photo_path) ?? null : null,
          total: loadTotal(price),
          lines: price.kind === "extra" && price.ok ? price.lines : [],
          problem: price.kind === "extra" && !price.ok ? price.problem : null,
        },
      ])
    ),
    uninvoicedSigned:
      Math.round(entries.filter(({ l }) => l.status === "signed" && l.billing === "extra").reduce((s, { price }) => s + (loadTotal(price) ?? 0), 0) * 100) / 100,
  };
  return view;
}
