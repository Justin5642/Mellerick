import { describe, it, expect } from "vitest";
import { mistakesByMonth, mistakesInCell, UNTAGGED } from "@/lib/mistakes-report";
import { buildMistakeRow, formFromMistake, isMissingMistakesTable, mistakesTotal, sortMistakes, type MistakeForm } from "@/lib/job-mistakes";

const centres = [
  { id: "bgd", name: "Below Ground Drainage" },
  { id: "transport", name: "Transport" },
  { id: "agp", name: "Above Ground Plumbing" },
];
// po_cost_centers id → company cost centre
const lineCentre = new Map<string, string | null>([
  ["l-sewer", "bgd"],
  ["l-storm", "bgd"],
  ["l-cart", "transport"],
  ["l-old", null],
  ["l-gone-centre", "deleted-centre"],
]);
const months = ["2026-11", "2026-10", "2026-09"];
const m = (id: string, occurred_on: string, amount: number | null, line: string | null, job = "j1") => ({
  id,
  job_id: job,
  occurred_on,
  amount_ex_gst: amount,
  cost_center_id: line,
});

describe("mistakesByMonth", () => {
  const mistakes = [
    m("a", "2026-11-03", 400, "l-sewer"),
    m("b", "2026-11-20", 100.25, "l-storm", "j2"),
    m("c", "2026-11-21", 50, "l-cart"),
    m("d", "2026-10-02", 75, null),
    m("e", "2026-10-09", 25, "l-old"),
    m("f", "2026-10-10", 10, "l-gone-centre"),
    m("g", "2025-01-01", 999, "l-sewer"), // outside the 12 months
    m("h", "2026-11-05", 0, "l-sewer"), // not a cost
  ];
  const r = mistakesByMonth({ mistakes, lineCentre, centres, months });

  it("adds mistakes up per month × company cost centre (two lines of one centre together)", () => {
    expect(r.cells["2026-11"].bgd).toEqual({ amount: 500.25, count: 2 });
    expect(r.cells["2026-11"].transport).toEqual({ amount: 50, count: 1 });
    expect(r.monthTotals["2026-11"]).toEqual({ amount: 550.25, count: 3 });
  });

  it("puts no line, an untagged line or an unknown company cost centre under Not tagged", () => {
    expect(r.cells["2026-10"][UNTAGGED]).toEqual({ amount: 110, count: 3 });
  });

  it("leaves out mistakes outside the period and zero amounts", () => {
    expect(r.total).toEqual({ amount: 660.25, count: 6 });
    expect(r.monthTotals["2026-09"]).toBeUndefined();
  });

  it("lists only columns with mistakes, in the company order, Not tagged last", () => {
    expect(r.centres.map((c) => c.id)).toEqual(["bgd", "transport", UNTAGGED]);
    expect(r.centreTotals.bgd).toEqual({ amount: 500.25, count: 2 });
  });

  it("lists one month's mistakes, or one cell's, biggest first", () => {
    expect(mistakesInCell(mistakes, lineCentre, centres, "2026-11").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(mistakesInCell(mistakes, lineCentre, centres, "2026-11", "bgd").map((x) => x.id)).toEqual(["a", "b"]);
    expect(mistakesInCell(mistakes, lineCentre, centres, "2026-10", UNTAGGED).map((x) => x.id)).toEqual(["d", "e", "f"]);
  });

  it("is empty with no mistakes", () => {
    const e = mistakesByMonth({ mistakes: [], lineCentre, centres, months });
    expect(e.centres).toEqual([]);
    expect(e.total).toEqual({ amount: 0, count: 0 });
  });
});

describe("buildMistakeRow", () => {
  const form = (over: Partial<MistakeForm> = {}): MistakeForm => ({
    occurred_on: "2026-11-20",
    cost_center_id: "l-sewer",
    amount: "$1,250.505",
    description: "  Pit at the wrong level  ",
    cause: "",
    staff_id: "",
    ...over,
  });
  const lines = ["l-sewer", "l-storm"];

  it("builds the row, trimming text and rounding to cents", () => {
    expect(buildMistakeRow(form(), lines)).toEqual({
      ok: true,
      row: { occurred_on: "2026-11-20", cost_center_id: "l-sewer", amount_ex_gst: 1250.51, description: "Pit at the wrong level", cause: null, staff_id: null },
    });
    const r = buildMistakeRow(form({ cost_center_id: "", cause: " Wrong plans ", staff_id: "s1" }), lines);
    expect(r.ok && r.row).toMatchObject({ cost_center_id: null, cause: "Wrong plans", staff_id: "s1" });
  });

  it("refuses a zero, negative or missing amount", () => {
    for (const amount of ["", "0", "-5", "abc"]) expect(buildMistakeRow(form({ amount }), lines).ok).toBe(false);
  });

  it("refuses a missing description, a bad date or a line not on this job", () => {
    expect(buildMistakeRow(form({ description: "   " }), lines)).toEqual({ ok: false, error: "Say what went wrong." });
    expect(buildMistakeRow(form({ occurred_on: "20/11/2026" }), lines).ok).toBe(false);
    expect(buildMistakeRow(form({ cost_center_id: "l-other-job" }), lines)).toEqual({ ok: false, error: "Pick one of this job's cost centres." });
    expect(buildMistakeRow(form({ description: "x".repeat(2001) }), lines).ok).toBe(false);
    expect(buildMistakeRow(form({ cause: "x".repeat(501) }), lines).ok).toBe(false);
  });

  it("round-trips a saved mistake through the form", () => {
    const saved = {
      id: "1",
      job_id: "j",
      cost_center_id: "l-storm",
      occurred_on: "2026-11-01",
      amount_ex_gst: 99.5,
      description: "Broke a pipe",
      cause: null,
      staff_id: "s2",
      entered_by: null,
      created_at: "2026-11-01T00:00:00Z",
    };
    const r = buildMistakeRow(formFromMistake(saved), lines);
    expect(r.ok && r.row).toEqual({ occurred_on: "2026-11-01", cost_center_id: "l-storm", amount_ex_gst: 99.5, description: "Broke a pipe", cause: null, staff_id: "s2" });
  });
});

describe("job mistakes helpers", () => {
  it("treats a missing table or column as not switched on, anything else as an error", () => {
    for (const code of ["42P01", "PGRST205", "42703", "PGRST204"]) expect(isMissingMistakesTable({ code })).toBe(true);
    expect(isMissingMistakesTable({ code: "42501" })).toBe(false);
    expect(isMissingMistakesTable(null)).toBe(false);
  });

  it("sorts newest first and totals to the cent", () => {
    const list = [
      { occurred_on: "2026-11-01", created_at: "a", amount_ex_gst: 0.1 },
      { occurred_on: "2026-11-03", created_at: "a", amount_ex_gst: 0.2 },
    ];
    expect(sortMistakes(list).map((x) => x.occurred_on)).toEqual(["2026-11-03", "2026-11-01"]);
    expect(mistakesTotal(list)).toBe(0.3);
  });
});
