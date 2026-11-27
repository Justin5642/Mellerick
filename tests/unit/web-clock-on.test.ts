import { describe, it, expect } from "vitest";
import { choiceVariationId, clockOnChoices, clockOnRow, showVariationChoice, STAGE_CHOICE } from "@/lib/web-clock-on";

const vars = [
  { id: "v1", status: "pending_approval", custom_name: "Hit rock" },
  { id: "v2", status: "rejected", custom_name: "Old" },
  { id: "v3", status: "approved", variation_types: { name: "Extra pit" } },
];

describe("clockOnChoices", () => {
  it("Clock In: the stage first, then every open variation (never a rejected one)", () => {
    expect(clockOnChoices(vars).map((c) => [c.value, c.label, c.variationId])).toEqual([
      [STAGE_CHOICE, "Stage work (not a variation)", null],
      ["v1", "Variation: Hit rock (waiting for the office)", "v1"],
      ["v3", "Variation: Extra pit (approved)", "v3"],
    ]);
  });

  it("Switch from the stage: only the open variations", () => {
    expect(clockOnChoices(vars, null).map((c) => c.value)).toEqual(["v1", "v3"]);
  });

  it("Switch from a variation: back to the stage, or another variation", () => {
    expect(clockOnChoices(vars, "v1").map((c) => c.value)).toEqual([STAGE_CHOICE, "v3"]);
  });

  it("nothing to switch to on the stage with no open variations", () => {
    expect(clockOnChoices([vars[1]], null)).toEqual([]);
  });
});

describe("choiceVariationId", () => {
  it("maps the stage and empty to null", () => {
    expect(choiceVariationId(STAGE_CHOICE)).toBeNull();
    expect(choiceVariationId("")).toBeNull();
    expect(choiceVariationId(null)).toBeNull();
    expect(choiceVariationId("v1")).toBe("v1");
  });
});

describe("showVariationChoice", () => {
  const base = { openCount: 1, entryCount: 3, variationsReady: true, columnMissing: false };
  it("shows with open variations on a database with the column", () => {
    expect(showVariationChoice(base)).toBe(true);
  });
  it("hides with no open variation, or once the column is known missing", () => {
    expect(showVariationChoice({ ...base, openCount: 0 })).toBe(false);
    expect(showVariationChoice({ ...base, columnMissing: true })).toBe(false);
  });
  it("hides when entries came back without the column; shows on a job with no time yet", () => {
    expect(showVariationChoice({ ...base, variationsReady: false })).toBe(false);
    expect(showVariationChoice({ ...base, variationsReady: false, entryCount: 0 })).toBe(true);
  });
});

describe("clockOnRow", () => {
  const at = "2026-11-27T00:00:00.000Z";
  it("stage time carries no variation_id key (a database without 0120 still takes it)", () => {
    const row = clockOnRow({ jobId: "j", staffId: "s", atIso: at, costCenterId: "cc", variationId: null });
    expect(row).toEqual({ job_id: "j", staff_id: "s", clock_in: at, auto_clocked: false, cost_center_id: "cc" });
    expect("variation_id" in row).toBe(false);
  });
  it("variation time carries the id and no money", () => {
    const row = clockOnRow({ jobId: "j", staffId: "s", atIso: at, costCenterId: null, variationId: "v1" });
    expect(row.variation_id).toBe("v1");
    expect(Object.keys(row).some((k) => /rate|amount|price|cost(?!_center)/.test(k))).toBe(false);
  });
});
