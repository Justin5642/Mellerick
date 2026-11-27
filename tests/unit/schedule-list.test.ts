import { describe, expect, it } from "vitest";
import { isListCompleted, listSection, listStages, listStagesLabel, listStatusLabel } from "@/lib/schedule-list";

const TODAY = "2026-11-27";

describe("listSection", () => {
  it("puts open work booked today under Today and the rest under Upcoming", () => {
    expect(listSection("scheduled", ["2026-11-26", TODAY], TODAY)).toBe("today");
    expect(listSection("scheduled", ["2026-11-30"], TODAY)).toBe("upcoming");
    // Past-dated open work stays listed, as before.
    expect(listSection("in_progress", ["2026-11-20"], TODAY)).toBe("upcoming");
  });

  it("lists a completed job only when it is booked today or later", () => {
    expect(listSection("completed", [TODAY], TODAY)).toBe("today");
    expect(listSection("completed", ["2026-11-25", "2026-12-01"], TODAY)).toBe("upcoming");
    expect(listSection("completed", ["2026-11-25", "2026-11-26"], TODAY)).toBeNull();
  });

  it("never lists a cancelled job or one with no booked day", () => {
    expect(listSection("cancelled", [TODAY], TODAY)).toBeNull();
    expect(listSection("scheduled", [], TODAY)).toBeNull();
  });
});

describe("completed label", () => {
  it("marks completed jobs and keeps other statuses readable", () => {
    expect(isListCompleted("completed")).toBe(true);
    expect(isListCompleted("in_progress")).toBe(false);
    expect(listStatusLabel("completed")).toBe("✓ Completed");
    expect(listStatusLabel("on_hold")).toBe("on hold");
  });
});

describe("listStages", () => {
  const days: Record<string, string[]> = {
    a: [TODAY],
    b: [TODAY],
    c: ["2026-11-28"],
    d: [TODAY],
    e: [TODAY],
  };
  const daysOf = (id: string) => days[id] ?? [];
  const bookings = [
    { id: "a", cost_center_id: "sewer", cost_center_name: "Sewer", cost_center_completed_at: "2026-11-26T05:00:00Z" },
    { id: "b", cost_center_id: "storm", cost_center_name: "Stormwater", cost_center_completed_at: null },
    { id: "c", cost_center_id: "camera", cost_center_name: "Camera Inspection", cost_center_completed_at: null },
    { id: "d", cost_center_id: null, cost_center_name: null },
    { id: "e", cost_center_id: "sewer", cost_center_name: "Sewer", cost_center_completed_at: null },
  ];

  it("lists that day's stages once each, ticked when complete", () => {
    const stages = listStages(bookings, daysOf, [TODAY]);
    expect(stages).toEqual([
      { id: "sewer", name: "Sewer", done: true },
      { id: "storm", name: "Stormwater", done: false },
    ]);
    expect(listStagesLabel(stages)).toBe("Sewer ✓ · Stormwater");
  });

  it("takes every day asked for", () => {
    expect(listStages(bookings, daysOf, [TODAY, "2026-11-28"]).map((s) => s.name)).toEqual([
      "Sewer",
      "Stormwater",
      "Camera Inspection",
    ]);
  });

  it("answers nothing when no booking is on those days", () => {
    expect(listStages(bookings, daysOf, ["2026-12-25"])).toEqual([]);
    expect(listStagesLabel([])).toBe("");
  });
});
