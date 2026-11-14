import { describe, it, expect } from "vitest";
import {
  buildHourLines,
  defaultRates,
  groupHours,
  quoteHourlyRate,
  totalHours,
  NO_COST_CENTRE,
  type HoursEntry,
} from "@/lib/approved-hours";

let n = 0;
const entry = (over: Partial<HoursEntry>): HoursEntry => ({
  id: `e${++n}`,
  staff_id: "tech-a",
  staff_name: "Alex",
  cost_center_id: "cc-1",
  cost_center_name: "Above Ground",
  entry_type: "work",
  clock_in: "2026-11-13T22:44:00Z",
  clock_out: "2026-11-14T02:00:00Z", // 3h16m = 3.27h — the Garden World entry
  invoice_id: null,
  ...over,
});

describe("groupHours", () => {
  it("bills the corrected clock times, rounded to 2dp", () => {
    const [g] = groupHours([entry({})]);
    expect(g.hours).toBe(3.27);
  });

  it("groups by cost centre, then technician, and sums each group before rounding", () => {
    const groups = groupHours([
      entry({ clock_in: "2026-11-14T00:00:00Z", clock_out: "2026-11-14T01:00:20Z" }),
      entry({ clock_in: "2026-11-14T02:00:00Z", clock_out: "2026-11-14T03:00:20Z" }),
      entry({ staff_id: "tech-b", staff_name: "Blake", clock_in: "2026-11-14T00:00:00Z", clock_out: "2026-11-14T02:00:00Z" }),
      entry({ cost_center_id: "cc-2", cost_center_name: "Fit Off", clock_in: "2026-11-14T00:00:00Z", clock_out: "2026-11-14T00:30:00Z" }),
      entry({ cost_center_id: null, cost_center_name: null, clock_in: "2026-11-14T00:00:00Z", clock_out: "2026-11-14T00:15:00Z" }),
    ]);
    expect(groups.map((g) => [g.costCentreName, g.staffName, g.hours, g.entryIds.length])).toEqual([
      ["Above Ground", "Alex", 2.01, 2], // 2h 0m 40s
      ["Above Ground", "Blake", 2, 1],
      ["Fit Off", "Alex", 0.5, 1],
      [null, "Alex", 0.25, 1], // no cost centre sorts last
    ]);
    expect(groups[3].costCentreKey).toBe(NO_COST_CENTRE);
    expect(totalHours(groups)).toBe(4.76);
  });

  it("leaves out travel, entries still clocked on, and zero-length entries", () => {
    expect(
      groupHours([
        entry({ entry_type: "travel" }),
        entry({ clock_out: null }),
        entry({ clock_out: "2026-11-13T22:44:00Z" }),
        entry({ clock_out: "2026-11-13T22:44:10Z" }), // 10 seconds rounds to 0.00h
      ])
    ).toEqual([]);
  });
});

describe("rates", () => {
  const groups = groupHours([
    entry({}),
    entry({ staff_id: "tech-b", staff_name: "Blake", cost_center_id: "cc-2", cost_center_name: "Fit Off" }),
  ]);

  it("takes the quote's hourly line, ignoring flat-rate and material lines", () => {
    expect(
      quoteHourlyRate([
        { unit_price: 450, pricing_type: "flat_rate" },
        { unit_price: "38.50", pricing_type: "material" },
        { unit_price: "145", pricing_type: "hourly" },
        { unit_price: 99, pricing_type: "hourly" },
      ])
    ).toBe(145);
    expect(quoteHourlyRate([{ unit_price: 450, pricing_type: "flat_rate" }])).toBeNull();
  });

  it("quoted job: the quote rate for everyone, even over a tech's own charge-out rate", () => {
    const d = defaultRates({ groups, quoteRate: 145, chargeOutByStaff: { "tech-b": 160 }, companyRate: 130 });
    expect(d.all).toBe(145);
    expect(d.allSource).toBe("quote");
    expect(d.byStaff["tech-b"]).toEqual({ rate: 145, source: "quote" });
    expect(d.byCostCentre["cc-2"]).toEqual({ rate: 145, source: "quote" });
  });

  it("unquoted job: each tech's charge-out rate, else the company rate", () => {
    const d = defaultRates({ groups, quoteRate: null, chargeOutByStaff: { "tech-b": 160, "tech-a": null }, companyRate: 130 });
    expect(d.all).toBe(130);
    expect(d.byStaff["tech-a"]).toEqual({ rate: 130, source: "company" });
    expect(d.byStaff["tech-b"]).toEqual({ rate: 160, source: "charge_out" });
  });
});

describe("buildHourLines", () => {
  const groups = groupHours([
    entry({}),
    entry({ staff_id: "tech-b", staff_name: "Blake", cost_center_id: "cc-2", cost_center_name: "Fit Off" }),
  ]);

  it("one rate for all: a line per cost centre x technician", () => {
    const r = buildHourLines(groups, { mode: "all", all: 130 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines).toEqual([
      { name: "Labour — Above Ground", description: "Alex — 3.27h @ $130.00/hr", quantity: 3.27, unit_price: 130, entry_ids: [groups[0].entryIds[0]] },
      { name: "Labour — Fit Off", description: "Blake — 3.27h @ $130.00/hr", quantity: 3.27, unit_price: 130, entry_ids: [groups[1].entryIds[0]] },
    ]);
  });

  it("per technician and per cost centre pick the matching rate", () => {
    const byTech = buildHourLines(groups, { mode: "technician", byStaff: { "tech-a": 120, "tech-b": 95.5 } });
    expect(byTech.ok && byTech.lines.map((l) => l.unit_price)).toEqual([120, 95.5]);
    const byCc = buildHourLines(groups, { mode: "cost_centre", byCostCentre: { "cc-1": 150, "cc-2": 110 } });
    expect(byCc.ok && byCc.lines.map((l) => l.unit_price)).toEqual([150, 110]);
  });

  it("refuses a missing rate and names whose it is, instead of billing $0", () => {
    const r = buildHourLines(groups, { mode: "technician", byStaff: { "tech-a": 120 } });
    expect(r).toEqual({ ok: false, error: "Enter an hourly rate for Blake." });
    expect(buildHourLines(groups, { mode: "all", all: Number.NaN }).ok).toBe(false);
    expect(buildHourLines([], { mode: "all", all: 130 }).ok).toBe(false);
  });
});
