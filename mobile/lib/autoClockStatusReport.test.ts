jest.mock("./supabase", () => ({ supabase: { from: jest.fn() } }));

import { REPORT_HEARTBEAT_MS, shouldReport, type AutoClockReport } from "./autoClockStatusReport";

const base: AutoClockReport = { tracking: true, reason: null, backgroundOff: false, approximate: false, siteCount: 3 };

describe("shouldReport", () => {
  it("sends the first status", () => {
    expect(shouldReport(null, base, 0)).toBe(true);
  });
  it("sends a change straight away — e.g. 'Always' location just turned off", () => {
    expect(shouldReport({ report: base, atMs: 0 }, { ...base, backgroundOff: true }, 1000)).toBe(true);
    expect(shouldReport({ report: base, atMs: 0 }, { ...base, tracking: false, reason: "off-hours" }, 1000)).toBe(true);
    expect(shouldReport({ report: base, atMs: 0 }, { ...base, siteCount: 4 }, 1000)).toBe(true);
  });
  it("doesn't resend an unchanged status until the heartbeat is due", () => {
    expect(shouldReport({ report: base, atMs: 0 }, base, REPORT_HEARTBEAT_MS - 1)).toBe(false);
    expect(shouldReport({ report: base, atMs: 0 }, base, REPORT_HEARTBEAT_MS)).toBe(true);
  });
  it("never reports a signed-out phone (it has no one to report for)", () => {
    expect(shouldReport(null, { ...base, tracking: false, reason: "signed-out" }, 0)).toBe(false);
  });
});
