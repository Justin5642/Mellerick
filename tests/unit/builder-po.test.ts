import { describe, it, expect } from "vitest";
import {
  hasBuilderPo,
  lineInputFromSaved,
  planBuilderPo,
  planBuilderPoEdit,
  planBuilderPoLines,
  remainingToSplit,
  type BuilderPoLineInput,
  type SavedPoLine,
} from "@/lib/builder-po";

// A builder's PO value split across company cost centres (Stage 2). The value
// is what the builder agreed to pay, so it is kept as entered; lines that
// don't add up to it are reported, never used to change it.

const CENTRES = [
  { id: "bgd", name: "Below Ground Drainage" },
  { id: "transport", name: "Transport" },
];
const line = (over: Partial<BuilderPoLineInput> = {}): BuilderPoLineInput => ({ costCentreId: "bgd", stage: "", amount: "", hours: "", ...over });

describe("planBuilderPo", () => {
  it("splits a drainage PO between drainage and transport", () => {
    const r = planBuilderPo(
      { value: "$12,500", lines: [line({ amount: "11000", hours: "40", stage: "Sewer" }), line({ costCentreId: "transport", amount: "1500" })] },
      CENTRES
    );
    expect(r.ok && r.po).toEqual({
      value: 12500,
      totalHours: 40,
      unallocated: 0,
      lines: [
        { cost_centre_id: "bgd", name: "Sewer", allocated_amount: 11000, allocated_hours: 40, sort_order: 0 },
        { cost_centre_id: "transport", name: "Transport", allocated_amount: 1500, allocated_hours: 0, sort_order: 1 },
      ],
    });
  });

  it("keeps the value as entered and reports what isn't split", () => {
    const r = planBuilderPo({ value: "10000", lines: [line({ amount: "6000" })] }, CENTRES);
    expect(r.ok && r.po.value).toBe(10000);
    expect(r.ok && r.po.unallocated).toBe(4000);
  });

  it("allows saving with no split yet (a quote total to split later)", () => {
    const r = planBuilderPo({ value: "8000", lines: [line({ costCentreId: "" })] }, CENTRES);
    expect(r.ok && r.po.lines).toEqual([]);
  });

  it("needs a value or a line — neither is no PO", () => {
    const none = { ok: false, error: "Enter the PO value (ex GST), or split it across cost centres." };
    expect(planBuilderPo({ value: "", lines: [] }, CENTRES)).toEqual(none);
    expect(planBuilderPo({ value: "", lines: [line({ costCentreId: "" })] }, CENTRES)).toEqual(none);
    expect(planBuilderPo({ value: "0", lines: [] }, CENTRES)).toEqual(none);
    expect(planBuilderPo({ value: "abc", lines: [] }, CENTRES)).toEqual({ ok: false, error: "Check the PO value (ex GST)." });
    expect(planBuilderPo({ value: "abc", lines: [line({ amount: "5" })] }, CENTRES).ok).toBe(false);
  });

  it("takes a blank value as the lines' total", () => {
    const r = planBuilderPo({ value: "", lines: [line({ amount: "6000" }), line({ costCentreId: "transport", amount: "1,500" })] }, CENTRES);
    expect(r.ok && r.po.value).toBe(7500);
    expect(r.ok && r.po.unallocated).toBe(0);
  });

  it("saves a truck cartage PO with hours and no price (a $0 PO)", () => {
    const r = planBuilderPo({ value: "", lines: [line({ costCentreId: "transport", hours: "16" })] }, CENTRES);
    expect(r.ok && r.po).toEqual({
      value: 0,
      totalHours: 16,
      unallocated: 0,
      lines: [{ cost_centre_id: "transport", name: "Transport", allocated_amount: 0, allocated_hours: 16, sort_order: 0 }],
    });
  });

  it("keeps a typed $0 value when there are lines", () => {
    const r = planBuilderPo({ value: "0", lines: [line({ costCentreId: "transport", hours: "8" })] }, CENTRES);
    expect(r.ok && r.po.value).toBe(0);
  });

  it("needs a cost centre on any line with something typed", () => {
    const r = planBuilderPo({ value: "1000", lines: [line({ costCentreId: "", amount: "500" })] }, CENTRES);
    expect(r).toEqual({ ok: false, error: "Pick a cost centre for every line." });
  });

  it("refuses a bad amount or negative hours", () => {
    expect(planBuilderPoLines([line({ amount: "lots" })], CENTRES).ok).toBe(false);
    expect(planBuilderPoLines([line({ hours: "-2" })], CENTRES).ok).toBe(false);
  });
});

describe("remainingToSplit", () => {
  it("starts a new line at what's left", () => {
    expect(remainingToSplit("12500", [line({ amount: "11000" })])).toBe("1500.00");
  });

  it("is blank once fully split or with no value", () => {
    expect(remainingToSplit("1000", [line({ amount: "1000" })])).toBe("");
    expect(remainingToSplit("", [])).toBe("");
  });
});

describe("hasBuilderPo", () => {
  it("is a PO once a value or any line is filled in", () => {
    expect(hasBuilderPo({ value: "", lines: [line({ costCentreId: "" })] })).toBe(false);
    expect(hasBuilderPo({ value: " ", lines: [] })).toBe(false);
    expect(hasBuilderPo({ value: "100", lines: [] })).toBe(true);
    expect(hasBuilderPo({ value: "", lines: [line({ costCentreId: "transport" })] })).toBe(true);
  });
});

describe("planBuilderPoEdit", () => {
  const SAVED: SavedPoLine[] = [
    { id: "l1", name: "Sewer", cost_centre_id: "bgd", allocated_amount: 11000, allocated_hours: 40 },
    { id: "l2", name: "Transport", cost_centre_id: "transport", allocated_amount: "1500.00", allocated_hours: 0 },
  ];
  const form = (lines: BuilderPoLineInput[], over: { value?: string; poNumber?: string } = {}) => ({
    poNumber: over.poNumber ?? "4500123",
    value: over.value ?? "12500",
    lines,
  });
  const fromSaved = () => SAVED.map((l) => lineInputFromSaved(l, CENTRES));

  it("loads saved lines back into the form", () => {
    expect(fromSaved()).toEqual([
      { id: "l1", costCentreId: "bgd", stage: "Sewer", amount: "11000.00", hours: "40" },
      { id: "l2", costCentreId: "transport", stage: "", amount: "1500.00", hours: "" },
    ]);
  });

  it("updates saved lines in place, inserts new ones and deletes removed ones", () => {
    const [sewer] = fromSaved();
    const r = planBuilderPoEdit(
      form([{ ...sewer, amount: "10000", hours: "35" }, line({ costCentreId: "transport", amount: "2500", hours: "6" })]),
      SAVED,
      CENTRES
    );
    expect(r.ok && r.edit).toEqual({
      value: 12500,
      totalHours: 41,
      unallocated: 0,
      updates: [{ id: "l1", cost_centre_id: "bgd", name: "Sewer", allocated_amount: 10000, allocated_hours: 35, sort_order: 0 }],
      inserts: [{ cost_centre_id: "transport", name: "Transport", allocated_amount: 2500, allocated_hours: 6, sort_order: 1 }],
      deletes: ["l2"],
    });
  });

  it("refuses to remove a line with something recorded against it", () => {
    const [sewer] = fromSaved();
    const r = planBuilderPoEdit(form([sewer]), SAVED, CENTRES, { l2: "it has supplier orders against it." });
    expect(r).toEqual({
      ok: false,
      error: "Transport can't be removed: it has supplier orders against it. Set its amount to $0 instead.",
    });
  });

  it("lets a line in use be changed, including to $0", () => {
    const [sewer, transport] = fromSaved();
    const r = planBuilderPoEdit(form([sewer, { ...transport, amount: "0" }]), SAVED, CENTRES, { l2: "busy" });
    expect(r.ok && r.edit.updates.map((u) => u.allocated_amount)).toEqual([11000, 0]);
    expect(r.ok && r.edit.deletes).toEqual([]);
  });

  it("keeps a saved line with no cost centre (Simpro) but needs one on a new line", () => {
    const simpro: SavedPoLine = { id: "s1", name: "Stage 1 Sewer", cost_centre_id: null, allocated_amount: 500, allocated_hours: 2 };
    const ok = planBuilderPoEdit(form([lineInputFromSaved(simpro, CENTRES)], { value: "500" }), [simpro], CENTRES);
    expect(ok.ok && ok.edit.updates).toEqual([
      { id: "s1", cost_centre_id: null, name: "Stage 1 Sewer", allocated_amount: 500, allocated_hours: 2, sort_order: 0 },
    ]);
    const bad = planBuilderPoEdit(form([line({ costCentreId: "", stage: "Extra", amount: "5" })]), [], CENTRES);
    expect(bad).toEqual({ ok: false, error: "Pick a cost centre for every line." });
  });

  it("needs a PO number, and takes a blank value as the lines' total", () => {
    expect(planBuilderPoEdit(form(fromSaved(), { poNumber: " " }), SAVED, CENTRES)).toEqual({ ok: false, error: "Enter the PO number." });
    const r = planBuilderPoEdit(form(fromSaved(), { value: "" }), SAVED, CENTRES);
    expect(r.ok && r.edit.value).toBe(12500);
  });

  it("removing every line needs a value", () => {
    const r = planBuilderPoEdit(form([line({ costCentreId: "" })], { value: "" }), SAVED, CENTRES);
    expect(r.ok).toBe(false);
    const kept = planBuilderPoEdit(form([], { value: "9000" }), SAVED, CENTRES);
    expect(kept.ok && kept.edit.deletes).toEqual(["l1", "l2"]);
    expect(kept.ok && kept.edit.unallocated).toBe(9000);
  });
});
