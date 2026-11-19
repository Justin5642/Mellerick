import { clocksFromBeforeToday, unfinishedYesterday, variationsToInvoice } from "./dashboardLooseEnds";

// The web dashboard's "Needs a look from yesterday" and "Variations to invoice"
// rules (app/dashboard/page.tsx), on the phone. Melbourne days; Wed 19 Nov 2026
// is "today" (AEDT, UTC+11).
const TODAY = "2026-11-19";

const job = (id: string, start: string, end: string | null, daily = false) => ({
  id,
  scheduled_start: start,
  scheduled_end: end,
  schedule_daily: daily,
});

describe("unfinishedYesterday", () => {
  it("lists a job booked yesterday that is still open", () => {
    const tue = job("a", "2026-11-17T21:00:00Z", "2026-11-18T05:30:00Z"); // Tue 18 Nov 8:00–16:30
    expect(unfinishedYesterday([tue], TODAY).map((j) => j.id)).toEqual(["a"]);
  });

  it("leaves out a multi-day job that carries on today", () => {
    const monToWed = job("b", "2026-11-16T20:00:00Z", "2026-11-19T04:30:00Z", true);
    expect(unfinishedYesterday([monToWed], TODAY)).toEqual([]);
  });

  it("leaves out jobs booked today or earlier in the week only", () => {
    const today = job("c", "2026-11-18T21:00:00Z", "2026-11-19T05:00:00Z");
    const monday = job("d", "2026-11-16T21:00:00Z", "2026-11-17T05:00:00Z");
    expect(unfinishedYesterday([today, monday], TODAY)).toEqual([]);
  });
});

describe("clocksFromBeforeToday", () => {
  it("keeps clocks started before Melbourne midnight, oldest first", () => {
    const clocks = [
      { id: "late", clock_in: "2026-11-18T08:00:00+00:00" }, // Tue 7 pm Melbourne
      { id: "today", clock_in: "2026-11-18T13:30:00Z" }, // Wed 00:30 Melbourne — today
      { id: "old", clock_in: "2026-11-17T22:00:00Z" },
    ];
    expect(clocksFromBeforeToday(clocks, TODAY).map((c) => c.id)).toEqual(["old", "late"]);
  });

  it("ignores an unreadable time rather than flagging it", () => {
    expect(clocksFromBeforeToday([{ clock_in: "not a date" }], TODAY)).toEqual([]);
  });
});

describe("variationsToInvoice", () => {
  it("counts and totals, leaving the QA fixture's probe out", () => {
    expect(
      variationsToInvoice([
        { total_amount: 250, jobs: { title: "Kitchen reno" } },
        { total_amount: null, jobs: null },
        { total_amount: 99.5, jobs: { title: "Bathroom" } },
        { total_amount: 1000, jobs: { title: "QA FIXTURE — do not invoice, do not delete" } },
      ])
    ).toEqual({ count: 3, total: 349.5 });
  });
});
