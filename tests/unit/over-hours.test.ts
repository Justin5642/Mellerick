import { describe, it, expect } from "vitest";
import {
  bookingOverHours,
  entryUsedHours,
  jobOverHours,
  jobsOverHours,
  overHoursHeadline,
  summariseJobHours,
  type OverHoursEntry,
} from "@/lib/over-hours";

const NOW = Date.parse("2026-11-24T05:00:00Z");
const closed = (job_id: string, cost_center_id: string | null, hours: number, entry_type = "work"): OverHoursEntry => ({
  job_id,
  cost_center_id,
  hours,
  clock_in: "2026-11-20T21:00:00Z",
  clock_out: "2026-11-21T05:00:00Z",
  entry_type,
});

describe("entryUsedHours", () => {
  it("counts a closed work entry's hours, travel never, and an open entry's live time", () => {
    expect(entryUsedHours(closed("j", null, 7.5), NOW)).toBe(7.5);
    expect(entryUsedHours(closed("j", null, 7.5, "travel"), NOW)).toBe(0);
    expect(
      entryUsedHours({ job_id: "j", cost_center_id: null, hours: null, clock_in: "2026-11-24T02:00:00Z", clock_out: null, entry_type: "work" }, NOW),
    ).toBe(3);
    expect(entryUsedHours({ job_id: "j", cost_center_id: null, hours: null, clock_in: null, clock_out: null }, NOW)).toBe(0);
  });
});

describe("summariseJobHours / bookingOverHours", () => {
  const hours = summariseJobHours({
    pos: [{ job_id: "A", total_hours: 40 }, { job_id: "B", total_hours: 100 }, { job_id: "C", total_hours: null }],
    lines: [
      { id: "drain", job_id: "A", name: "Drainage", allocated_hours: 30 },
      { id: "plumb", job_id: "A", name: "Plumbing", allocated_hours: "10" },
    ],
    entries: [
      closed("A", "drain", 20),
      closed("A", "drain", 14),
      closed("A", "plumb", 4),
      closed("A", "plumb", 50, "travel"),
      closed("B", null, 120),
      closed("C", null, 500),
    ],
    nowMs: NOW,
  });

  it("adds up used and allowed hours per job and per line", () => {
    expect(hours.A.usedHours).toBe(38);
    expect(hours.A.allowedHours).toBe(40);
    expect(hours.A.lines.drain).toEqual({ name: "Drainage", usedHours: 34, allowedHours: 30 });
    // No lines: the PO's total_hours is the job's allowance.
    expect(hours.B.allowedHours).toBe(100);
  });

  it("flags the booking's own line when it is over", () => {
    expect(bookingOverHours({ job_id: "A", cost_center_id: "drain" }, hours)?.text).toBe("Over hours: 34 h of 30 h (Drainage)");
  });

  it("a line within its hours on a job within its total is not flagged", () => {
    expect(bookingOverHours({ job_id: "A", cost_center_id: "plumb" }, hours)).toBeNull();
    expect(bookingOverHours({ job_id: "A", cost_center_id: null }, hours)).toBeNull();
  });

  it("falls back to the job total", () => {
    const over = bookingOverHours({ job_id: "B", cost_center_id: null }, hours);
    expect(over).toMatchObject({ level: "job", text: "Over hours: 120 h of 100 h" });
  });

  it("never flags a job with no allowed hours", () => {
    expect(bookingOverHours({ job_id: "C", cost_center_id: null }, hours)).toBeNull();
    expect(bookingOverHours({ job_id: "nothing", cost_center_id: null }, hours)).toBeNull();
  });

  it("the job total wins over a line's own flag only when the line isn't over", () => {
    const h = summariseJobHours({
      pos: [],
      lines: [
        { id: "a", job_id: "J", name: "A", allocated_hours: 10 },
        { id: "b", job_id: "J", name: "B", allocated_hours: 10 },
      ],
      entries: [closed("J", "a", 5), closed("J", "b", 18)],
      nowMs: NOW,
    });
    expect(bookingOverHours({ job_id: "J", cost_center_id: "a" }, h)?.text).toBe("Over hours: 23 h of 20 h");
    expect(bookingOverHours({ job_id: "J", cost_center_id: "b" }, h)?.text).toBe("Over hours: 18 h of 10 h (B)");
    expect(jobOverHours("J", h).map((o) => o.level)).toEqual(["job", "line"]);
  });

  it("a job whose only line is over lists the line, not the same hours twice", () => {
    const h = summariseJobHours({
      pos: [],
      lines: [{ id: "a", job_id: "J", name: "Drainage", allocated_hours: 30 }],
      entries: [closed("J", "a", 34)],
      nowMs: NOW,
    });
    expect(jobOverHours("J", h).map((o) => o.text)).toEqual(["Over hours: 34 h of 30 h (Drainage)"]);
  });

  it("exactly on the allowance, or over by less than the rounding, is not over", () => {
    const h = summariseJobHours({ pos: [{ job_id: "J", total_hours: 30 }], lines: [], entries: [closed("J", null, 30.04)], nowMs: NOW });
    expect(bookingOverHours({ job_id: "J" }, h)).toBeNull();
  });

  it("counts a running clock towards the total", () => {
    const h = summariseJobHours({
      pos: [{ job_id: "J", total_hours: 8 }],
      lines: [],
      entries: [closed("J", null, 6), { job_id: "J", cost_center_id: null, hours: null, clock_in: "2026-11-24T02:00:00Z", clock_out: null, entry_type: "work" }],
      nowMs: NOW,
    });
    expect(bookingOverHours({ job_id: "J" }, h)?.text).toBe("Over hours: 9 h of 8 h");
  });
});

describe("jobsOverHours", () => {
  it("lists each job once, in the order given, only when something is over", () => {
    const h = summariseJobHours({
      pos: [{ job_id: "X", total_hours: 1 }, { job_id: "Y", total_hours: 100 }, { job_id: "Z", total_hours: 2 }],
      lines: [],
      entries: [closed("X", null, 2), closed("Y", null, 2), closed("Z", null, 3)],
      nowMs: NOW,
    });
    expect(jobsOverHours(["Z", "Y", "X", "Z"], h).map((j) => j.jobId)).toEqual(["Z", "X"]);
    expect(overHoursHeadline(1)).toBe("1 job over its allowed hours");
    expect(overHoursHeadline(3)).toBe("3 jobs over their allowed hours");
  });

  it("returns hours only — no money-named key anywhere", () => {
    const h = summariseJobHours({ pos: [{ job_id: "X", total_hours: 1 }], lines: [{ id: "l", job_id: "X", name: "L", allocated_hours: 1 }], entries: [closed("X", "l", 2)], nowMs: NOW });
    const json = JSON.stringify({ h, list: jobsOverHours(["X"], h) });
    expect(json).not.toMatch(/amount|rate|value|price|cost"/i);
  });
});
