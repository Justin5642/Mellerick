import { describe, it, expect } from "vitest";
import { buildCartageLoadRow, cartageWriteError, decodeDocketImage, docketPhotoPath, loadSignProblem, parseCartageLoadBody } from "@/lib/cartage-load-entry";
import { buildTruckLoadsView, isLoadTruck, siteLabelOf } from "@/lib/cartage-view";

// Truck loads (0111): what a load as typed must look like, and the view's
// money rule at the unit level (the routes test walks whole answers).

const TRUCK = "22222222-2222-4222-8222-222222222222";
const QUARRY = "55555555-5555-4555-8555-555555555555";
const base = { equipment_id: TRUCK, load_date: "2026-11-17", direction: "material_in", unit: "tonne", quantity: "20", km: "40" };

describe("parse and build", () => {
  it("keeps the quarry only on material in, and blank text as null", () => {
    const p = parseCartageLoadBody({ ...base, supplier_id: QUARRY, material: "  Crushed rock ", place: "", docket_number: " 88 " });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const b = buildCartageLoadRow(p.input);
    expect(b).toMatchObject({ ok: true, row: { supplier_id: QUARRY, material: "Crushed rock", place: null, docket_number: "88", quantity: 20, km: 40 } });
    if (b.ok) expect(b.row).not.toHaveProperty("billing");
    const spoil = buildCartageLoadRow({ ...p.input, direction: "spoil_out", supplier_id: QUARRY });
    expect(spoil.ok && spoil.row.supplier_id).toBe(null);
  });

  it("refuses bad shapes with fixed sentences", () => {
    expect(parseCartageLoadBody(null)).toMatchObject({ ok: false });
    expect(parseCartageLoadBody({ ...base, equipment_id: "x" })).toMatchObject({ ok: false, error: "Pick the truck." });
    expect(parseCartageLoadBody({ ...base, load_date: "2026-02-30" })).toMatchObject({ ok: false, error: "Pick the date." });
    expect(parseCartageLoadBody({ ...base, direction: "sideways" })).toMatchObject({ ok: false });
    expect(parseCartageLoadBody({ ...base, unit: "bucket" })).toMatchObject({ ok: false });
    expect(parseCartageLoadBody({ ...base, billing: "free" })).toMatchObject({ ok: false });
    expect(parseCartageLoadBody({ ...base, docket_number: "x".repeat(61) })).toMatchObject({ ok: false });
    const neg = parseCartageLoadBody({ ...base, km: "-1" });
    expect(neg.ok && buildCartageLoadRow(neg.input)).toMatchObject({ ok: false, error: "Check the numbers entered." });
  });

  it("spoil by the bare load is refused unless it's included", () => {
    const p = parseCartageLoadBody({ ...base, direction: "spoil_out", unit: "load" });
    expect(p.ok && buildCartageLoadRow(p.input)).toMatchObject({ ok: false });
    const inc = parseCartageLoadBody({ ...base, direction: "spoil_out", unit: "load", billing: "included" });
    expect(inc.ok && buildCartageLoadRow(inc.input)).toMatchObject({ ok: true, row: { billing: "included" } });
  });

  it("sign-off needs a quantity", () => {
    expect(loadSignProblem({ quantity: null })).toMatch(/how much/);
    expect(loadSignProblem({ quantity: "0" })).toMatch(/how much/);
    expect(loadSignProblem({ quantity: "12.00" })).toBeNull();
  });

  it("passes only the database's own sentences through", () => {
    expect(cartageWriteError({ code: "42501", message: "This truck load is signed and locked. Ask the office if it needs changing." })).toEqual({
      status: 403,
      error: "This truck load is signed and locked. Ask the office if it needs changing.",
    });
    expect(cartageWriteError({ code: "23514", message: 'new row violates check constraint "cartage_loads_km_check"' }).error).toBe("Check the numbers entered.");
    expect(cartageWriteError({ code: "XX000", message: "secret detail" }).status).toBe(500);
  });
});

describe("docket photos", () => {
  it("are stored where 0047/0065 hide money documents from technicians", () => {
    // storage_object_is_money_document() matches '%/expense-receipt-%'.
    expect(docketPhotoPath("job", "load", "jpg", 5)).toBe("job/expense-receipt-cartage-load-5.jpg");
    expect(/\/expense-receipt-/.test(docketPhotoPath("j", "l", "png"))).toBe(true);
  });

  it("accept JPEG, PNG and WebP only", () => {
    const b64 = (bytes: number[]) => Buffer.from([...bytes, ...new Array(200).fill(1)]).toString("base64");
    expect(decodeDocketImage(b64([0xff, 0xd8, 0xff]))).toMatchObject({ ok: true, ext: "jpg" });
    expect(decodeDocketImage(`data:image/png;base64,${b64([0x89, 0x50, 0x4e, 0x47])}`)).toMatchObject({ ok: true, ext: "png" });
    expect(decodeDocketImage(b64([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toMatchObject({ ok: true, ext: "webp" });
    expect(decodeDocketImage(b64([0x25, 0x50, 0x44, 0x46]))).toMatchObject({ ok: false });
    expect(decodeDocketImage("")).toMatchObject({ ok: false });
    expect(decodeDocketImage("A".repeat(4_200_004))).toMatchObject({ ok: false });
  });
});

describe("the view", () => {
  const truck = { id: TRUCK, name: "Tipper", is_active: true, category: "vehicle", options: [{ hire_type: "cartage" as const, hire_unit: "tonne" as const, rate: 28.37 }] };

  it("lists trucks — vehicles or anything set up for cartage, never tools or inactive", () => {
    expect(isLoadTruck(truck)).toBe(true);
    expect(isLoadTruck({ ...truck, category: "machinery" })).toBe(true);
    expect(isLoadTruck({ ...truck, category: "machinery", options: [] })).toBe(false);
    expect(isLoadTruck({ ...truck, category: "tool" })).toBe(false);
    expect(isLoadTruck({ ...truck, is_active: false })).toBe(false);
  });

  it("the crew's view has names, defaults and no pricing", () => {
    const v = buildTruckLoadsView({
      isOffice: false,
      trucks: [truck],
      suppliers: [{ id: QUARRY, name: "Northern Quarries", pin_order: null }],
      loads: [],
      quarryIncluded: false,
      siteLabel: siteLabelOf({ name: "Lot 4", address_line1: "", suburb: null }),
      costCentreNames: new Map(),
      signatureUrls: new Map(),
      costs: new Map([["x", { docket_cost_ex_gst: 1, margin_pct: 1 }]]),
      companyMarginPct: 17.5,
    });
    expect(v.pricing).toBeUndefined();
    expect(v.trucks).toEqual([{ id: TRUCK, name: "Tipper" }]);
    expect(v.defaults).toEqual({ material_in: "extra", spoil_out: "extra" });
    expect(v.siteLabel).toBe("Lot 4");
    expect(JSON.stringify(v)).not.toMatch(/28\.37|17\.5/);
  });
});
