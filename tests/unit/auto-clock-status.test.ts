import { describe, it, expect } from "vitest";
import { STALE_AFTER_MS, describeAutoClockStatus, type AutoClockStatusRow } from "@/lib/auto-clock-status";

const now = Date.parse("2026-11-16T09:00:00+11:00");
const row = (over: Partial<AutoClockStatusRow> = {}): AutoClockStatusRow => ({
  staff_id: "s",
  tracking: true,
  reason: null,
  background_off: false,
  approximate: false,
  site_count: 3,
  platform: "ios",
  app_version: "1.0.0 (28)",
  updated_at: new Date(now - 60_000).toISOString(),
  ...over,
});

describe("describeAutoClockStatus", () => {
  it("no report yet", () => {
    expect(describeAutoClockStatus(null, now)).toMatchObject({ tone: "idle", text: "Phone hasn't reported yet" });
  });
  it("working", () => {
    expect(describeAutoClockStatus(row(), now)).toMatchObject({ tone: "ok", text: "Working — watching 3 sites" });
  });
  it("names the permission problem and how to fix it, worst first", () => {
    expect(describeAutoClockStatus(row({ tracking: false, reason: "declined" }), now)).toMatchObject({ tone: "bad", text: "Location turned down on the phone" });
    expect(describeAutoClockStatus(row({ approximate: true, background_off: true }), now).text).toBe("Approximate location only");
    const whileUsing = describeAutoClockStatus(row({ background_off: true }), now);
    expect(whileUsing).toMatchObject({ tone: "warn", text: 'Location set to "While using"' });
    expect(whileUsing.fix).toMatch(/Always/);
  });
  it("no sites points at map pins", () => {
    expect(describeAutoClockStatus(row({ tracking: false, reason: "no-sites", site_count: 0 }), now).fix).toMatch(/map location/);
  });
  it("outside work hours is fine", () => {
    expect(describeAutoClockStatus(row({ tracking: false, reason: "off-hours" }), now)).toMatchObject({ tone: "ok", text: "Ready (outside work hours)" });
  });
  it("flags a phone that has gone quiet", () => {
    const old = row({ updated_at: new Date(now - STALE_AFTER_MS - 86_400_000).toISOString() });
    expect(describeAutoClockStatus(old, now)).toMatchObject({ tone: "warn", text: "Phone quiet (last heard 4 days ago)" });
    expect(describeAutoClockStatus({ ...old, background_off: true }, now).text).toBe('Location set to "While using" (last heard 4 days ago)');
  });
});
