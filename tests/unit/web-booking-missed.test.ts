import { describe, it, expect } from "vitest";
import { bookingMenuItems, missedAction } from "@/components/schedule/board-actions";

// "Didn't make it" for the office on the web (27 Nov 2026; 0121).
const booking = (over: Partial<Parameters<typeof missedAction>[0]> = {}) => ({
  staff_id: "tech-1",
  // 9:00 Melbourne on Tue 25 Nov 2026 (AEDT, UTC+11).
  starts_at: "2026-11-24T22:00:00.000Z",
  ends_at: "2026-11-25T06:00:00.000Z",
  daily: false,
  missed_at: null,
  missed_reason: null,
  missed_note: null,
  ...over,
});

describe("missedAction", () => {
  it("offers office/admin a flag on a past or today's booking of an open job", () => {
    expect(missedAction(booking(), "scheduled", "2026-11-27", true)).toBe("flag");
    expect(missedAction(booking(), "in_progress", "2026-11-25", true)).toBe("flag");
  });

  it("offers change/clear once flagged", () => {
    expect(missedAction(booking({ missed_reason: "weather", missed_at: "2026-11-25T01:00:00Z" }), "scheduled", "2026-11-27", true)).toBe("change");
  });

  it("offers nothing to a technician, on a future booking, a closed job or Unassigned", () => {
    expect(missedAction(booking(), "scheduled", "2026-11-27", false)).toBeNull();
    expect(missedAction(booking(), "scheduled", "2026-11-24", true)).toBeNull();
    expect(missedAction(booking(), "completed", "2026-11-27", true)).toBeNull();
    expect(missedAction(booking(), "cancelled", "2026-11-27", true)).toBeNull();
    expect(missedAction(booking({ staff_id: null }), "scheduled", "2026-11-27", true)).toBeNull();
  });
});

describe("bookingMenuItems — Didn't make it", () => {
  const base = { closed: null, unsaved: false, readOnly: false, canTodo: true };

  it("is left out unless asked for", () => {
    expect(bookingMenuItems(base).some((i) => i.action === "missed")).toBe(false);
    expect(bookingMenuItems({ ...base, missed: null }).some((i) => i.action === "missed")).toBe(false);
  });

  it("is the last item, worded by state", () => {
    const flag = bookingMenuItems({ ...base, missed: "flag" });
    expect(flag[flag.length - 1]).toEqual({ action: "missed", label: "Didn't make it…", disabled: undefined });
    const change = bookingMenuItems({ ...base, missed: "change" });
    expect(change[change.length - 1].label).toBe("Didn't make it — change or clear…");
  });

  it("is greyed while the booking is still saving, and gone on a closed job", () => {
    expect(bookingMenuItems({ ...base, unsaved: true, missed: "flag" }).find((i) => i.action === "missed")?.disabled).toBe("Still saving");
    expect(bookingMenuItems({ ...base, closed: "completed", missed: "flag" }).map((i) => i.action)).toEqual(["open"]);
  });
});
