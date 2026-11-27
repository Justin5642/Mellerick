import { describe, it, expect } from "vitest";
import {
  buildTimeLogRows,
  CSV_COLUMNS,
  hoursByStaff,
  hoursByStage,
  MAX_RANGE_DAYS,
  NO_STAGE,
  parseTimeLogFilters,
  rangeInstants,
  sumHours,
  timeLogCsv,
  TRAVEL_STAGE,
  type TimeLogEntry,
  type TimeLogLookups,
} from "@/lib/time-log-report";

const STAFF_A = "11111111-1111-4111-8111-111111111111";
const STAFF_B = "22222222-2222-4222-8222-222222222222";

const lookups: TimeLogLookups = {
  jobs: new Map([
    [
      "job-1",
      {
        id: "job-1",
        job_number: 123,
        title: "Lot 5 sewer",
        sites: { address_line1: "12 Smith St", suburb: "Epping", site_lat: -37.65, site_lng: 145.02, geofence_radius_m: null },
      },
    ],
    ["job-2", { id: "job-2", job_number: 124, title: "No pin", sites: { address_line1: "1 Main Rd", suburb: null, site_lat: null, site_lng: null, geofence_radius_m: null } }],
  ]),
  staffNames: new Map([
    [STAFF_A, "Brodie"],
    [STAFF_B, "Dan"],
  ]),
  stageNames: new Map([["cc-sewer", "Sewer"]]),
  variationNames: new Map([["var-1", "Hit rock"]]),
};

function entry(over: Partial<TimeLogEntry>): TimeLogEntry {
  return {
    id: "e",
    job_id: "job-1",
    staff_id: STAFF_A,
    clock_in: "2026-11-24T21:00:00.000Z", // Wed 25 Nov 08:00 Melbourne
    clock_out: "2026-11-25T05:00:00.000Z",
    hours: 8,
    notes: null,
    auto_clocked: false,
    entry_type: "work",
    cost_center_id: "cc-sewer",
    ...over,
  };
}

const MONEY = /(rate|price|amount|charge|fee|value|gst|margin|dollar|\$|cost(?!\s?cent))/i;

function moneyKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => moneyKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...(MONEY.test(k) ? [`${path}.${k}`] : []), ...moneyKeys(v, `${path}.${k}`)]);
  }
  return [];
}

describe("parseTimeLogFilters", () => {
  it("defaults to this week, Monday to Sunday", () => {
    const f = parseTimeLogFilters({}, "2026-11-27"); // a Friday
    expect(f).toEqual({ from: "2026-11-23", to: "2026-11-29", staffId: null, jobNumber: null, entryType: "all" });
  });

  it("reads the filters and ignores junk", () => {
    expect(parseTimeLogFilters({ from: "2026-11-01", to: "2026-11-10", staff: STAFF_A, job: "#123", type: "travel" }, "2026-11-27")).toEqual({
      from: "2026-11-01",
      to: "2026-11-10",
      staffId: STAFF_A,
      jobNumber: 123,
      entryType: "travel",
    });
    const bad = parseTimeLogFilters({ from: "2026-02-30", to: "nope", staff: "x';drop", job: "12a", type: "money" }, "2026-11-27");
    expect(bad).toMatchObject({ from: "2026-11-23", to: "2026-11-29", staffId: null, jobNumber: null, entryType: "all" });
  });

  it("swaps a backwards range and caps a long one", () => {
    expect(parseTimeLogFilters({ from: "2026-11-10", to: "2026-11-01" }, "2026-11-27")).toMatchObject({ from: "2026-11-01", to: "2026-11-10" });
    const long = parseTimeLogFilters({ from: "2020-01-01", to: "2026-11-01" }, "2026-11-27");
    const days = (Date.parse(long.to) - Date.parse(long.from)) / 86_400_000 + 1;
    expect(days).toBe(MAX_RANGE_DAYS);
  });

  it("covers whole Melbourne days", () => {
    // Daylight time (+11): midnight Melbourne is 13:00 UTC the day before.
    expect(rangeInstants({ from: "2026-11-23", to: "2026-11-29" })).toEqual({
      start: "2026-11-22T13:00:00.000Z",
      end: "2026-11-29T13:00:00.000Z",
    });
  });
});

describe("buildTimeLogRows", () => {
  it("shapes an entry with every detail", () => {
    const [row] = buildTimeLogRows(
      [
        entry({
          id: "e1",
          notes: "  laid 20 m  ",
          clock_in_lat: -37.65,
          clock_in_lng: 145.02,
          clock_in_accuracy: 10,
          clock_out_lat: -37.66,
          clock_out_lng: 145.02,
          clock_out_accuracy: 10,
          edited_by: STAFF_B,
        }),
      ],
      lookups
    );
    expect(row).toMatchObject({
      date: "2026-11-25",
      staffName: "Brodie",
      jobNumber: 123,
      jobTitle: "Lot 5 sewer",
      site: "12 Smith St, Epping",
      stageName: "Sewer",
      variationName: null,
      entryType: "work",
      stillOn: false,
      hours: 8,
      auto: false,
      editedBy: "Dan",
      notes: "laid 20 m",
      clockInPlace: { label: "on site", outside: false },
    });
    expect(row.clockOutPlace?.outside).toBe(true);
  });

  it("leaves the place blank with no pin, no fix, or travel", () => {
    const rows = buildTimeLogRows(
      [
        entry({ id: "a", job_id: "job-2", clock_in_lat: -37, clock_in_lng: 145 }),
        entry({ id: "b" }),
        entry({ id: "c", entry_type: "travel", cost_center_id: null, clock_in_lat: -30, clock_in_lng: 140 }),
      ],
      lookups
    );
    for (const r of rows) {
      expect(r.clockInPlace).toBeNull();
      expect(r.clockOutPlace).toBeNull();
    }
  });

  it("times an open entry up to now and marks it still on", () => {
    const now = Date.parse("2026-11-25T00:30:00.000Z");
    const [row] = buildTimeLogRows([entry({ clock_out: null, hours: null, auto_clocked: true })], lookups, now);
    expect(row.stillOn).toBe(true);
    expect(row.hours).toBe(3.5);
    expect(row.auto).toBe(true);
  });

  it("names variations, unknown stages and staff", () => {
    const [row] = buildTimeLogRows([entry({ variation_id: "var-1", cost_center_id: "gone", staff_id: null })], lookups);
    expect(row.variationName).toBe("Hit rock");
    expect(row.stageName).toBe(NO_STAGE);
    expect(row.staffName).toBe("Unknown staff member");
  });
});

describe("totals", () => {
  const rows = buildTimeLogRows(
    [
      entry({ id: "1", hours: 8 }),
      entry({ id: "2", hours: 1.25, entry_type: "travel", cost_center_id: null }),
      entry({ id: "3", staff_id: STAFF_B, hours: 4.5 }),
      entry({ id: "4", staff_id: STAFF_B, hours: 2, variation_id: "var-1" }),
    ],
    lookups
  );

  it("adds hours per staff member, split work / travel", () => {
    expect(hoursByStaff(rows)).toEqual([
      { staffId: STAFF_A, name: "Brodie", hours: 9.25, workHours: 8, travelHours: 1.25, entries: 2 },
      { staffId: STAFF_B, name: "Dan", hours: 6.5, workHours: 6.5, travelHours: 0, entries: 2 },
    ]);
  });

  it("adds hours per cost centre, travel and variations on their own lines", () => {
    expect(hoursByStage(rows)).toEqual([
      { name: "Sewer", hours: 12.5, entries: 2 },
      { name: "Variation: Hit rock", hours: 2, entries: 1 },
      { name: TRAVEL_STAGE, hours: 1.25, entries: 1 },
    ]);
    expect(sumHours(rows)).toBe(15.75);
  });

  it("carries no money anywhere — keys, columns or totals", () => {
    expect(moneyKeys(rows)).toEqual([]);
    expect(moneyKeys(hoursByStaff(rows))).toEqual([]);
    expect(moneyKeys(hoursByStage(rows))).toEqual([]);
    expect(CSV_COLUMNS.filter((c) => MONEY.test(c))).toEqual([]);
    expect(timeLogCsv(rows)).not.toMatch(/\$/);
  });
});

describe("timeLogCsv", () => {
  it("writes a header and quotes awkward cells", () => {
    const rows = buildTimeLogRows([entry({ notes: 'said "hi", left\nearly' }), entry({ id: "z", notes: "=SUM(A1)", clock_out: null, hours: null })], lookups, Date.parse("2026-11-24T22:00:00Z"));
    const csv = timeLogCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(csv).toContain('"said ""hi"", left\nearly"');
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain("still on");
    expect(csv).toContain("2026-11-25,Brodie,123,Lot 5 sewer,\"12 Smith St, Epping\",Sewer,,Work,");
  });
});
