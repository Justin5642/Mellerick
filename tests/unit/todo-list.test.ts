import { describe, it, expect } from "vitest";
import {
  allocatedHoursByJob,
  daysOnList,
  fitsGap,
  formatHours,
  isTodoListable,
  parseEstimatedHours,
  parseGapHours,
  sortTodoJobs,
  todoHours,
} from "@/lib/todo-list";

describe("todoHours — estimate, else PO hours, else unknown", () => {
  it("prefers office's estimate over the PO allocation", () => {
    expect(todoHours(3, 8)).toEqual({ hours: 3, source: "estimate" });
  });

  it("takes a numeric string (PostgREST returns numeric as a number, but be tolerant)", () => {
    expect(todoHours("2.5", null)).toEqual({ hours: 2.5, source: "estimate" });
  });

  it("an explicit 0h estimate is still an estimate", () => {
    expect(todoHours(0, 8)).toEqual({ hours: 0, source: "estimate" });
  });

  it("falls back to PO hours when no estimate is set", () => {
    expect(todoHours(null, 6)).toEqual({ hours: 6, source: "po" });
    expect(todoHours(undefined, 6)).toEqual({ hours: 6, source: "po" });
  });

  it("treats a 0h PO allocation as unknown, not as a job that fits every gap", () => {
    expect(todoHours(null, 0)).toEqual({ hours: null, source: null });
    expect(todoHours(null, null)).toEqual({ hours: null, source: null });
  });
});

describe("fitsGap", () => {
  it("no gap entered shows everything", () => {
    expect(fitsGap(40, null)).toBe(true);
  });

  it("keeps jobs at or under the gap and drops larger ones", () => {
    expect(fitsGap(3, 3)).toBe(true);
    expect(fitsGap(2, 3)).toBe(true);
    expect(fitsGap(3.5, 3)).toBe(false);
  });

  it("keeps a job with no estimate visible", () => {
    expect(fitsGap(null, 2)).toBe(true);
  });
});

describe("parseGapHours / parseEstimatedHours", () => {
  it("blank gap means no filter; garbage or negative too", () => {
    expect(parseGapHours("")).toBeNull();
    expect(parseGapHours("  ")).toBeNull();
    expect(parseGapHours("-1")).toBeNull();
    expect(parseGapHours("abc")).toBeNull();
    expect(parseGapHours("4.5")).toBe(4.5);
  });

  it("blank estimate is null; out of the 0..1000 check-constraint range is invalid", () => {
    expect(parseEstimatedHours("")).toBeNull();
    expect(parseEstimatedHours("2.25")).toBe(2.25);
    expect(parseEstimatedHours("0")).toBe(0);
    expect(parseEstimatedHours("1000")).toBe(1000);
    expect(parseEstimatedHours("1000.5")).toBe("invalid");
    expect(parseEstimatedHours("-1")).toBe("invalid");
    expect(parseEstimatedHours("x")).toBe("invalid");
  });

  it("rounds an estimate to 2 decimal places", () => {
    expect(parseEstimatedHours("1.23456")).toBe(1.23);
  });
});

describe("sortTodoJobs — priority, then longest waiting", () => {
  const job = (id: string, priority: string, todo_listed_at: string) => ({ id, priority, todo_listed_at });

  it("orders urgent > high > normal > low, oldest first within a priority", () => {
    const sorted = sortTodoJobs([
      job("low-old", "low", "2026-01-01T00:00:00Z"),
      job("normal-new", "normal", "2026-03-01T00:00:00Z"),
      job("urgent", "urgent", "2026-04-01T00:00:00Z"),
      job("normal-old", "normal", "2026-02-01T00:00:00Z"),
      job("high", "high", "2026-05-01T00:00:00Z"),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["urgent", "high", "normal-old", "normal-new", "low-old"]);
  });

  it("sorts an unknown priority as normal and does not mutate its input", () => {
    const input = [job("b", "normal", "2026-02-01T00:00:00Z"), job("a", "weird", "2026-01-01T00:00:00Z")];
    expect(sortTodoJobs(input).map((j) => j.id)).toEqual(["a", "b"]);
    expect(input.map((j) => j.id)).toEqual(["b", "a"]);
  });
});

describe("daysOnList", () => {
  const listed = "2026-10-01T00:00:00Z";
  const t = new Date(listed).getTime();

  it("counts whole days", () => {
    expect(daysOnList(listed, t + 2.9 * 86_400_000)).toBe(2);
  });

  it("never goes negative when the browser clock is behind the database's", () => {
    expect(daysOnList(listed, t - 3_600_000)).toBe(0);
  });

  it("an unparseable stamp reads as 0", () => {
    expect(daysOnList("nope", t)).toBe(0);
  });
});

describe("allocatedHoursByJob / isTodoListable / formatHours", () => {
  it("sums PO hours per job and skips rows with no job", () => {
    const m = allocatedHoursByJob([
      { job_id: "a", total_hours: 2 },
      { job_id: "a", total_hours: "1.5" },
      { job_id: "b", total_hours: null },
      { job_id: null, total_hours: 9 },
    ]);
    expect(Object.fromEntries(m)).toEqual({ a: 3.5, b: 0 });
  });

  it("only pending and on-hold jobs can be listed (the trigger refuses the rest)", () => {
    expect(isTodoListable("pending")).toBe(true);
    expect(isTodoListable("on_hold")).toBe(true);
    for (const s of ["scheduled", "in_progress", "completed", "cancelled", null, undefined]) {
      expect(isTodoListable(s)).toBe(false);
    }
  });

  it("formats hours without trailing zeros", () => {
    expect(formatHours(8)).toBe("8h");
    expect(formatHours(2.5)).toBe("2.5h");
    expect(formatHours(1 / 3)).toBe("0.33h");
  });
});
