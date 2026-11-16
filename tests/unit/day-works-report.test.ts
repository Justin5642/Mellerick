import { describe, it, expect } from "vitest";
import {
  cellAmount,
  dayWorksByMonth,
  dayWorksJobsForMonth,
  isMonthKey,
  lastMonths,
  monthLabel,
  parseReportView,
  UNTAGGED,
  type ReportEntry,
} from "@/lib/day-works-report";
import type { HireOption } from "@/lib/hire-pricing";

const PC88: HireOption = { equipment_id: "pc88", hire_type: "wet", hire_unit: "hour", rate: 146, cost_centre_id: "wet" };
const ROLLER: HireOption = { equipment_id: "roller", hire_type: "dry", hire_unit: "day", rate: 400, whole_days_only: true, cost_centre_id: null };
const QUAD: HireOption = { equipment_id: "quad", hire_type: "float", hire_unit: "move", rate: 0, float_base: 470, float_km_included: 30, float_per_km: 5, cost_centre_id: "float" };
const OPTIONS = [PC88, ROLLER, QUAD];
const TRENCHER = { id: "trencher", name: "Trencher", day_rate: 200 };
const CENTRES = [
  { id: "cartage", name: "Truck Cartage" },
  { id: "wet", name: "Plant Wet Hire" },
  { id: "dry", name: "Plant Dry Hire" },
  { id: "float", name: "Float Moves" },
];

let n = 0;
const entry = (o: HireOption, q: Partial<ReportEntry> = {}): ReportEntry => ({
  id: `e${++n}`,
  job_id: "job1",
  equipment_id: o.equipment_id,
  hire_type: o.hire_type,
  hire_unit: o.hire_unit,
  work_date: "2026-11-10",
  status: "signed",
  attachment_ids: [],
  ...q,
});

const MONTHS = lastMonths("2026-11", 12);

describe("months", () => {
  it("lists the last 12 months newest first, across a year end", () => {
    expect(MONTHS[0]).toBe("2026-11");
    expect(MONTHS[11]).toBe("2025-12");
    expect(MONTHS).toHaveLength(12);
    expect(lastMonths("2026-01", 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });
  it("validates month keys and labels them", () => {
    expect(isMonthKey("2026-11")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("nov")).toBe(false);
    expect(isMonthKey(undefined)).toBe(false);
    expect(monthLabel("2026-11")).toMatch(/Nov.*2026/);
  });
  it("parses the view, defaulting to all", () => {
    expect(parseReportView("signed")).toBe("signed");
    expect(parseReportView("invoiced")).toBe("invoiced");
    expect(parseReportView("void")).toBe("all");
    expect(parseReportView(undefined)).toBe("all");
  });
});

describe("dayWorksByMonth", () => {
  const entries: ReportEntry[] = [
    // Nov: 8 h wet = 1168 signed, + trencher 200 = 1368
    entry(PC88, { hours: 8, attachment_ids: ["trencher"] }),
    // Nov: roller 1.5 days → 2 full days = 800, invoiced; option has no centre → default "Plant Dry Hire" by name
    entry(ROLLER, { days: 1.5, status: "invoiced", job_id: "job2" }),
    // Nov: quad float 50 km = 570 invoiced
    entry(QUAD, { km: 50, status: "invoiced", work_date: "2026-11-03" }),
    // Oct: 4 h wet = 584 signed
    entry(PC88, { hours: 4, work_date: "2026-10-31" }),
    // Nov draft: 2 h = 292, not revenue
    entry(PC88, { hours: 2, status: "draft", work_date: "2026-11-12" }),
    // void: ignored
    entry(PC88, { hours: 10, status: "void" }),
    // outside the window
    entry(PC88, { hours: 10, work_date: "2025-11-30" }),
  ];
  const r = dayWorksByMonth({ entries, options: OPTIONS, attachments: [TRENCHER], centres: CENTRES, months: MONTHS });

  it("adds machine + attachments by month and cost centre, keeping signed and invoiced apart", () => {
    expect(r.cells["2026-11"].wet).toMatchObject({ signed: 1368, invoiced: 0, entries: 1, drafts: 1, draftAmount: 292 });
    expect(r.cells["2026-11"].dry).toMatchObject({ signed: 0, invoiced: 800, entries: 1 });
    expect(r.cells["2026-11"].float).toMatchObject({ invoiced: 570 });
    expect(r.cells["2026-10"].wet).toMatchObject({ signed: 584 });
    expect(r.monthTotals["2026-11"]).toMatchObject({ signed: 1368, invoiced: 1370, entries: 3, drafts: 1 });
    expect(cellAmount(r.monthTotals["2026-11"], "all")).toBe(2738);
    expect(cellAmount(r.monthTotals["2026-11"], "signed")).toBe(1368);
    expect(cellAmount(r.monthTotals["2026-11"], "invoiced")).toBe(1370);
    expect(r.centreTotals.wet).toMatchObject({ signed: 1952 });
    expect(cellAmount(r.total, "all")).toBe(3322);
  });

  it("leaves void and out-of-window entries out", () => {
    expect(r.total.entries).toBe(4);
    expect(r.total.drafts).toBe(1);
    expect(r.cells["2025-11"]).toBeUndefined();
  });

  it("shows only cost centres with entries, in the company order", () => {
    expect(r.centres.map((c) => c.id)).toEqual(["wet", "dry", "float"]);
    expect(r.months).toEqual(MONTHS);
  });

  it("counts an entry whose machine has no hire setup as unpriced, never $0 revenue", () => {
    const orphan = entry({ ...PC88, equipment_id: "gone" }, { hours: 5, cost_centre_id: "wet" });
    const r2 = dayWorksByMonth({ entries: [orphan], options: OPTIONS, attachments: [], centres: CENTRES, months: MONTHS });
    expect(r2.cells["2026-11"].wet).toMatchObject({ signed: 0, entries: 1, unpriced: 1 });
  });

  it("uses the entry's own cost centre first, and 'Not tagged' when none can be found", () => {
    const stamped = entry(PC88, { hours: 1, cost_centre_id: "cartage" });
    const lost = entry({ ...ROLLER }, { days: 1 });
    const r2 = dayWorksByMonth({ entries: [stamped, lost], options: OPTIONS, attachments: [], centres: CENTRES.filter((c) => c.id !== "dry"), months: MONTHS });
    expect(r2.cells["2026-11"].cartage.signed).toBe(146);
    expect(r2.cells["2026-11"][UNTAGGED].signed).toBe(400);
    expect(r2.centres.map((c) => c.id)).toEqual(["cartage", UNTAGGED]);
  });
});

describe("dayWorksJobsForMonth", () => {
  it("breaks one month down by job, largest first, drafts-only jobs after", () => {
    const entries = [
      entry(PC88, { hours: 1, job_id: "small" }),
      entry(PC88, { hours: 10, job_id: "big", status: "invoiced" }),
      entry(QUAD, { km: 10, job_id: "big" }),
      entry(PC88, { hours: 3, job_id: "draftonly", status: "draft" }),
      entry(PC88, { hours: 50, job_id: "other-month", work_date: "2026-10-01" }),
    ];
    const r = dayWorksJobsForMonth({ entries, options: OPTIONS, attachments: [], centres: CENTRES, month: "2026-11" });
    expect(r.jobs.map((j) => j.job_id)).toEqual(["big", "small", "draftonly"]);
    const big = r.jobs[0];
    expect(big.byCentre.wet).toMatchObject({ invoiced: 1460 });
    expect(big.byCentre.float).toMatchObject({ signed: 470 });
    expect(cellAmount(big.total, "all")).toBe(1930);
    expect(r.jobs[2].total).toMatchObject({ entries: 0, drafts: 1, draftAmount: 438 });
    expect(r.centres.map((c) => c.id)).toEqual(["wet", "float"]);
  });
});
