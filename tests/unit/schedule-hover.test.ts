import { describe, it, expect } from "vitest";
import { fromBusinessInputValue } from "@/lib/date";
import { buildBoardIndex, daysByBooking, type BoardBooking, type BoardJob } from "@/components/schedule/board-model";
import {
  boardTextForViewer,
  dayTimeLabel,
  hoverCardDetails,
  hoverCardPlacement,
  siteAddressLines,
  statusLabel,
  trimText,
  HOVER_DESCRIPTION_MAX,
} from "@/lib/schedule-hover";
import { dayTimelineHours, layoutDayRow, LANE_HEIGHT, ROW_PADDING } from "@/lib/schedule-grid";

// The schedule board's hover card (lib/schedule-hover.ts, 25 Nov 2026) and the
// web board's use of the phone's Day timeline layout (lib/schedule-grid.ts).
// Calendar (Melbourne): Mon 23 Nov 2026 … Wed 25 Nov.

const at = (key: string, time: string) => fromBusinessInputValue(`${key}T${time}`);

function job(overrides: Partial<BoardJob> = {}): BoardJob {
  return {
    id: "job-1",
    job_number: 123,
    title: "Sewer connection",
    status: "scheduled",
    priority: "urgent",
    description: "Connect the house drain to the sewer.",
    scheduled_start: at("2026-11-23", "07:00"),
    scheduled_end: at("2026-11-25", "15:30"),
    assigned_to: "alice",
    crew: ["alice", "bob"],
    customers: { name: "Simon Buchanan", company: "Landart Landscapes" },
    sites: {
      name: "Lot 12",
      address_line1: "12 Smith Street",
      address_line2: null,
      suburb: "Epping",
      state: "VIC",
      postcode: "3076",
      notes: "Contact: Dave 0400 000 000\nAccess: side gate code 1234",
      site_lat: null,
      site_lng: null,
    },
    ...overrides,
  };
}

function booking(overrides: Partial<BoardBooking> = {}): BoardBooking {
  return {
    id: "b-1",
    job_id: "job-1",
    staff_id: "alice",
    cost_center_id: "cc-1",
    cost_center_name: "Drainage",
    starts_at: at("2026-11-23", "07:00"),
    ends_at: at("2026-11-25", "15:30"),
    daily: true,
    all_day: false,
    note: "Bring the long ladder",
    ...overrides,
  } as BoardBooking;
}

const names: Record<string, string> = { alice: "Alice Smith", bob: "Bob Jones" };
const nameOf = (id: string | null) => (id ? names[id] ?? "Technician" : "Unassigned");

describe("hoverCardDetails", () => {
  const j = job();
  const mine = booking();
  const bobs = booking({ id: "b-2", staff_id: "bob", starts_at: at("2026-11-24", "09:00"), ends_at: at("2026-11-24", "12:00"), daily: false, cost_center_name: "Plumbing", note: null });
  const all = [mine, bobs];
  const days = daysByBooking(all);
  const index = buildBoardIndex(all, new Map([[j.id, j]]), ["2026-11-24"], days);
  const entry = index.byStaff.get("alice")!.get("2026-11-24")![0];

  it("bills the company, with the contact as Attn", () => {
    const d = hoverCardDetails(entry, all, days, nameOf);
    expect(d.customer).toBe("Landart Landscapes");
    expect(d.attention).toBe("Simon Buchanan");
  });

  it("gives the full site address and its notes", () => {
    const d = hoverCardDetails(entry, all, days, nameOf);
    expect(d.address).toEqual(["Lot 12", "12 Smith Street", "Epping VIC 3076"]);
    expect(d.siteNotes).toBe("Contact: Dave 0400 000 000\nAccess: side gate code 1234");
  });

  it("says who, when, which day of how many, the cost centre and the booking's note", () => {
    const d = hoverCardDetails(entry, all, days, nameOf);
    expect(d.heading).toBe("#123 — Sewer connection");
    expect(d.technician).toBe("Alice Smith");
    expect(d.when).toBe("Tue 24 Nov · 07:00 am – 03:30 pm");
    expect(d.span).toBe("Day 2 of 3 · Mon 23 – Wed 25 Nov");
    expect(d.costCentre).toBe("Drainage");
    expect(d.note).toBe("Bring the long ladder");
    expect(d.status).toBe("Scheduled");
    expect(d.priority).toBe("Urgent");
  });

  it("lists the rest of the crew on the job that day, and only that day", () => {
    const d = hoverCardDetails(entry, all, days, nameOf);
    expect(d.crew).toEqual([{ name: "Bob Jones", time: "09:00 am – 12:00 pm", costCentre: "Plumbing" }]);
    const monday = buildBoardIndex(all, new Map([[j.id, j]]), ["2026-11-23"], days).byStaff.get("alice")!.get("2026-11-23")![0];
    expect(hoverCardDetails(monday, all, days, nameOf).crew).toEqual([]);
  });

  it("leaves out what isn't there: normal priority, no customer, no note", () => {
    const bare = job({ priority: "normal", customers: null, sites: null, description: null });
    const b = booking({ note: null, cost_center_name: null, daily: false, ends_at: at("2026-11-24", "12:00"), starts_at: at("2026-11-24", "08:00") });
    const ds = daysByBooking([b]);
    const e = buildBoardIndex([b], new Map([[bare.id, bare]]), ["2026-11-24"], ds).byStaff.get("alice")!.get("2026-11-24")![0];
    const d = hoverCardDetails(e, [b], ds, nameOf);
    expect(d.priority).toBeNull();
    expect(d.customer).toBeNull();
    expect(d.address).toEqual([]);
    expect(d.note).toBeNull();
    expect(d.costCentre).toBeNull();
    expect(d.span).toBeNull();
    expect(d.description).toBeNull();
  });

  it("carries no money — every value is text the board already had", () => {
    const d = hoverCardDetails(entry, all, days, nameOf);
    expect(JSON.stringify(d)).not.toMatch(/\$|amount|value|rate|price/i);
  });
});

describe("siteAddressLines", () => {
  it("doesn't repeat a site name that is the street", () => {
    expect(siteAddressLines({ name: "12 Smith Street", address_line1: "12 Smith Street", suburb: "Epping", state: "VIC", postcode: "3076" })).toEqual([
      "12 Smith Street",
      "Epping VIC 3076",
    ]);
  });
  it("includes the second address line", () => {
    expect(siteAddressLines({ address_line1: "Unit 4", address_line2: "8 Quinlan Road", suburb: "Epping", state: "VIC", postcode: null })).toEqual([
      "Unit 4",
      "8 Quinlan Road",
      "Epping VIC",
    ]);
  });
  it("is empty with no site", () => {
    expect(siteAddressLines(null)).toEqual([]);
  });
});

describe("trimText / labels", () => {
  it("cuts long text at a word with an ellipsis", () => {
    const long = "word ".repeat(100);
    const t = trimText(long, HOVER_DESCRIPTION_MAX)!;
    expect(t.length).toBeLessThanOrEqual(HOVER_DESCRIPTION_MAX + 1);
    expect(t.endsWith("word…")).toBe(true);
  });
  it("is null for blank text", () => {
    expect(trimText("   ", 10)).toBeNull();
    expect(trimText(null, 10)).toBeNull();
  });
  it("names statuses and times", () => {
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("on_hold")).toBe("On hold");
    const s = at("2026-11-24", "07:00");
    expect(dayTimeLabel({ startIso: s, endIso: s })).toBe("07:00 am");
  });
});

describe("hoverCardPlacement", () => {
  const viewport = { width: 1500, height: 900 };
  const size = { width: 320, height: 300 };
  it("goes to the right of the booking, level with its top", () => {
    expect(hoverCardPlacement({ left: 100, top: 200, right: 220, bottom: 256 }, size, viewport)).toEqual({ x: 228, y: 200 });
  });
  it("goes to the left when the right has no room", () => {
    expect(hoverCardPlacement({ left: 1200, top: 200, right: 1320, bottom: 256 }, size, viewport)).toEqual({ x: 872, y: 200 });
  });
  it("stays inside the viewport at the bottom", () => {
    expect(hoverCardPlacement({ left: 100, top: 850, right: 220, bottom: 890 }, size, viewport).y).toBe(900 - 300 - 8);
  });
  it("goes below a booking as wide as the screen", () => {
    expect(hoverCardPlacement({ left: 10, top: 100, right: 1490, bottom: 156 }, size, viewport)).toEqual({ x: 10, y: 164 });
  });
});

describe("boardTextForViewer", () => {
  it("gives office the (trimmed) description and site notes", () => {
    const j = boardTextForViewer(job({ description: "x".repeat(2000) }), { role: "office", id: "o1" });
    expect(j.description!.length).toBeLessThanOrEqual(601);
    expect(j.sites?.notes).toContain("side gate");
  });
  it("gives a technician on the job the same", () => {
    expect(boardTextForViewer(job(), { role: "technician", id: "bob" }).description).toContain("sewer");
  });
  it("strips them for a technician not on the job", () => {
    const j = boardTextForViewer(job(), { role: "technician", id: "carol" });
    expect(j.description).toBeNull();
    expect(j.sites?.notes).toBeNull();
    expect(j.sites?.address_line1).toBe("12 Smith Street");
  });
});

describe("the web Day timeline uses the phone's layout (lib/schedule-grid.ts)", () => {
  const j = job({ priority: null });
  const a = booking({ id: "a", daily: false, starts_at: at("2026-11-24", "07:00"), ends_at: at("2026-11-24", "11:00") });
  const b = booking({ id: "b", daily: false, starts_at: at("2026-11-24", "10:00"), ends_at: at("2026-11-24", "14:00") });
  const c = booking({ id: "c", daily: false, starts_at: at("2026-11-24", "12:00"), ends_at: at("2026-11-24", "15:00") });
  const days = daysByBooking([a, b, c]);
  const entries = buildBoardIndex([a, b, c], new Map([[j.id, j]]), ["2026-11-24"], days).byStaff.get("alice")!.get("2026-11-24")!;
  const range = dayTimelineHours(entries.map((e) => e.day), "2026-11-24");

  it("places blocks by their hours and stacks overlaps in lanes", () => {
    const { items, height } = layoutDayRow(entries, [], range, { hourWidth: 84, laneHeight: 62 });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(range).toEqual({ startHour: 6, endHour: 19 });
    expect(byId.get("a")).toMatchObject({ left: 84, width: 4 * 84, top: ROW_PADDING });
    expect(byId.get("b")).toMatchObject({ left: 4 * 84, top: ROW_PADDING + 62 });
    expect(byId.get("c")).toMatchObject({ left: 6 * 84, top: ROW_PADDING });
    expect(height).toBe(2 * 62 + ROW_PADDING * 2);
  });

  it("keeps the phone's sizes when none are given", () => {
    const { height } = layoutDayRow(entries, [], range);
    expect(height).toBe(2 * LANE_HEIGHT + ROW_PADDING * 2);
  });
});
