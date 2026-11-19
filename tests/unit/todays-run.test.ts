import { describe, it, expect } from "vitest";
import { cartageSlotsToday, isCartageLine, runJobOrder, runTotals, type RunBooking, type RunLine } from "@/lib/todays-run";

// "Today's run" rules (lib/todays-run.ts): which of the caller's bookings are
// cartage today, the run's order, and the quantity totals.

const ME = "me";
const TODAY = "2026-11-19"; // a Thursday; Melbourne is UTC+11 (daylight time)

const line = (id: string, name: string | null, costCentre: string | null): RunLine => ({ id, name, costCentre });
const LINES = new Map<string, RunLine>([
  ["transport", line("transport", "Cartage — quarter minus", "Transport")],
  ["truck", line("truck", "Truck Cartage", " truck cartage ")],
  ["drainage", line("drainage", "Sewer drainage", "Below Ground Drainage")],
  ["drainage-named-truck", line("drainage-named-truck", "Truck & drain", "Below Ground Drainage")],
  ["untagged-cartage", line("untagged-cartage", "Tipping and cartage", null)],
  ["untagged-other", line("untagged-other", "Stage 2 drainage", null)],
]);

function booking(over: Partial<RunBooking> & { id: string }): RunBooking {
  return {
    job_id: "job-a",
    staff_id: ME,
    cost_center_id: "transport",
    // 07:00–15:30 Melbourne on 19 Nov
    starts_at: "2026-11-18T20:00:00.000Z",
    ends_at: "2026-11-19T04:30:00.000Z",
    daily: false,
    all_day: true,
    ...over,
  };
}

describe("isCartageLine", () => {
  it("is the company cost centre Transport or Truck Cartage, whatever the case", () => {
    expect(isCartageLine(LINES.get("transport"))).toBe(true);
    expect(isCartageLine(LINES.get("truck"))).toBe(true);
    expect(isCartageLine(LINES.get("drainage"))).toBe(false);
  });

  it("never second-guesses a tagged line by its name", () => {
    expect(isCartageLine(LINES.get("drainage-named-truck"))).toBe(false);
  });

  it("falls back to 0087's keyword rule for an untagged line", () => {
    expect(isCartageLine(LINES.get("untagged-cartage"))).toBe(true);
    expect(isCartageLine(LINES.get("untagged-other"))).toBe(false);
  });

  it("no line, no cartage", () => {
    expect(isCartageLine(undefined)).toBe(false);
    expect(isCartageLine(line("x", null, null))).toBe(false);
  });
});

describe("cartageSlotsToday", () => {
  it("keeps only the caller's own cartage bookings booked today", () => {
    const slots = cartageSlotsToday(
      [
        booking({ id: "mine" }),
        booking({ id: "someone-else", staff_id: "other" }),
        booking({ id: "unassigned", staff_id: null }),
        booking({ id: "drainage", cost_center_id: "drainage" }),
        booking({ id: "no-centre", cost_center_id: null }),
        booking({ id: "unknown-line", cost_center_id: "gone" }),
        // tomorrow
        booking({ id: "tomorrow", starts_at: "2026-11-19T20:00:00.000Z", ends_at: "2026-11-20T04:30:00.000Z" }),
      ],
      LINES,
      ME,
      TODAY,
    );
    expect(slots.map((s) => s.bookingId)).toEqual(["mine"]);
    expect(slots[0]).toMatchObject({ jobId: "job-a", costCentre: "Transport", stage: "Cartage — quarter minus", allDay: true });
  });

  it("uses the day rules: a Mon–Fri daily booking is on today with today's hours", () => {
    const [slot] = cartageSlotsToday(
      [booking({ id: "daily", daily: true, starts_at: "2026-11-16T21:00:00.000Z", ends_at: "2026-11-21T02:00:00.000Z", all_day: false })],
      LINES,
      ME,
      TODAY,
    );
    // 08:00–13:00 Melbourne on the 19th
    expect(slot).toMatchObject({ startIso: "2026-11-18T21:00:00.000Z", endIso: "2026-11-19T02:00:00.000Z" });
  });

  it("a continuous (not daily) booking that began yesterday is not on today by its start alone", () => {
    expect(cartageSlotsToday([booking({ id: "y", starts_at: "2026-11-17T20:00:00.000Z", ends_at: "2026-11-18T04:30:00.000Z" })], LINES, ME, TODAY)).toEqual([]);
  });

  it("drops the stage when it is the cost centre's own name, and sorts by start", () => {
    const slots = cartageSlotsToday(
      [
        booking({ id: "late", job_id: "job-b", cost_center_id: "truck", starts_at: "2026-11-19T01:00:00.000Z", ends_at: "2026-11-19T03:00:00.000Z" }),
        booking({ id: "early", starts_at: "2026-11-18T20:00:00.000Z", ends_at: "2026-11-18T23:00:00.000Z" }),
      ],
      LINES,
      ME,
      TODAY,
    );
    expect(slots.map((s) => s.bookingId)).toEqual(["early", "late"]);
    expect(slots[1]).toMatchObject({ costCentre: "truck cartage", stage: "Truck Cartage" });
    expect(cartageSlotsToday([booking({ id: "x", cost_center_id: "untagged-cartage" })], LINES, ME, TODAY)[0]).toMatchObject({ costCentre: "Tipping and cartage", stage: null });
  });

  it("an empty caller id matches nothing", () => {
    expect(cartageSlotsToday([booking({ id: "a", staff_id: "" })], LINES, "", TODAY)).toEqual([]);
  });
});

describe("runJobOrder", () => {
  const numbers: Record<string, number> = { a: 10, b: 20, c: 5, d: 7 };
  const n = (id: string) => numbers[id];
  const slot = (jobId: string, startIso: string) => ({ jobId, bookingId: `${jobId}-${startIso}`, startIso, endIso: startIso, allDay: false, costCentre: null, stage: null });

  it("booked jobs by their earliest block (each once — Job A then B then back to A is still one card), then added jobs by number", () => {
    const order = runJobOrder([slot("a", "2026-11-19T01:00:00Z"), slot("b", "2026-11-18T22:00:00Z"), slot("a", "2026-11-18T21:00:00Z")], ["d", "c", "a", "c"], n);
    expect(order).toEqual([
      { jobId: "a", booked: true },
      { jobId: "b", booked: true },
      { jobId: "c", booked: false },
      { jobId: "d", booked: false },
    ]);
  });

  it("same start: lower job number first", () => {
    expect(runJobOrder([slot("b", "2026-11-18T21:00:00Z"), slot("a", "2026-11-18T21:00:00Z")], [], n).map((o) => o.jobId)).toEqual(["a", "b"]);
  });
});

describe("runTotals", () => {
  it("counts trips and adds quantities by unit and direction, leaving void loads out", () => {
    const t = runTotals([
      { direction: "material_in", unit: "tonne", quantity: 12, km: 30, material: "Crushed rock", status: "draft" },
      { direction: "material_in", unit: "tonne", quantity: 12.5, km: 30, material: "crushed rock", status: "signed" },
      { direction: "material_in", unit: "load", quantity: 1, km: null, material: "Quarter minus", status: "draft" },
      { direction: "spoil_out", unit: "m3", quantity: 9.25, km: 22.4, material: null, status: "draft" },
      { direction: "spoil_out", unit: "tonne", quantity: null, km: null, material: null, status: "draft" },
      { direction: "spoil_out", unit: "m3", quantity: 100, km: 100, material: null, status: "void" },
    ]);
    expect(t.in).toEqual({ trips: 3, tonnes: 24.5, m3: 0, loadUnits: 1, km: 60, materials: ["Crushed rock", "Quarter minus"] });
    expect(t.out).toEqual({ trips: 2, tonnes: 0, m3: 9.25, loadUnits: 0, km: 22.4, materials: [] });
    expect(t).toMatchObject({ trips: 5, tonnes: 24.5, m3: 9.25, km: 82.4 });
  });

  it("no loads, all zero", () => {
    expect(runTotals([])).toMatchObject({ trips: 0, tonnes: 0, m3: 0, km: 0 });
  });
});
