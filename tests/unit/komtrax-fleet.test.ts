import { describe, it, expect } from "vitest";
import { dueLabel, serviceDue, type ServiceRecord } from "@/lib/service-due";
import { buildDigest } from "@/lib/weekly-digest";
import { groupFaults } from "@/lib/komtrax-data";
import { ageText, fuelText, mapsUrl, severityTone } from "@/lib/komtrax-view";

// Komtrax (0113, drafted — not applied yet) in Fleet: service due from the
// live hour meter, the Monday digest's fault section, and display helpers.

const rec = (over: Partial<ServiceRecord>): ServiceRecord => ({
  id: "r1",
  equipment_id: "pc88",
  service_date: "2026-06-01",
  service_type: "scheduled",
  odometer_km: null,
  engine_hours: 4000,
  next_due_date: null,
  next_due_km: null,
  next_due_hours: 4500,
  ...over,
});
const today = "2026-11-20";

describe("service due with Komtrax hours", () => {
  it("without a live meter, hours never decide (unchanged behaviour)", () => {
    const d = serviceDue([rec({})], today);
    expect(d).toMatchObject({ state: "no_due_date", lastHours: 4000, liveHours: null, hoursUntil: null, dueBy: null });
  });

  it("the live meter past the hours target makes it overdue", () => {
    const d = serviceDue([rec({})], today, { hours: 4512.4, at: "2026-11-20T04:00:00Z" });
    expect(d).toMatchObject({ state: "overdue", dueBy: "hours", hoursUntil: -12.4, lastHours: 4512.4, liveHours: 4512.4, liveHoursAt: "2026-11-20T04:00:00Z" });
    expect(dueLabel(d)).toBe("Service overdue by 12 engine hours");
  });

  it("within 50 hours is due soon; further is ok", () => {
    expect(dueLabel(serviceDue([rec({})], today, { hours: 4470, at: null }))).toBe("Service due in 30 engine hours");
    expect(dueLabel(serviceDue([rec({})], today, { hours: 4500, at: null }))).toBe("Service due now (engine hours)");
    const ok = serviceDue([rec({})], today, { hours: 4100, at: null });
    expect(ok.state).toBe("ok");
    expect(dueLabel(ok)).toBe("Next service in 400 engine hours");
  });

  it("the worse of the date and the hours decides; a tie stays with the date", () => {
    const dateOk = rec({ next_due_date: "2027-03-01" });
    expect(serviceDue([dateOk], today, { hours: 4510, at: null })).toMatchObject({ state: "overdue", dueBy: "hours" });
    const dateOverdue = rec({ next_due_date: "2026-11-01" });
    const d = serviceDue([dateOverdue], today, { hours: 4510, at: null });
    expect(d).toMatchObject({ state: "overdue", dueBy: "date" });
    expect(dueLabel(d)).toBe("Service overdue by 19 days");
  });

  it("no service on record stays 'none' whatever the meter says; no hours target leaves the date alone", () => {
    expect(serviceDue([], today, { hours: 9999, at: null }).state).toBe("none");
    const d = serviceDue([rec({ next_due_hours: null, next_due_date: "2027-01-31" })], today, { hours: 9999, at: null });
    expect(d).toMatchObject({ state: "ok", dueBy: "date", hoursUntil: null, lastHours: 9999 });
  });
});

describe("weekly digest: active machine faults", () => {
  const base = {
    appUrl: "https://app.test",
    unallocated: { count: 0, total: 0, bills: [] },
    coverage: [],
    overdue: { count: 0, total: 0, top: [] },
    awaitingInvoice: { count: 0, oldest: [] },
  } as unknown as Parameters<typeof buildDigest>[0];

  it("lists each machine's faults from the last 7 days, escaped", () => {
    const faults = groupFaults([
      { code: "CA2185", severity: "High", description: "Throttle <sensor>", occurred_at: "2026-11-18T01:00:00Z", komtrax_machines: { model: "PC88MR-10", serial: "S1", equipment: { name: "PC88 & co" } } },
      { code: "CA2185", severity: "High", description: "Throttle <sensor>", occurred_at: "2026-11-19T01:00:00Z", komtrax_machines: { model: "PC88MR-10", serial: "S1", equipment: { name: "PC88 & co" } } },
      { code: "E10", severity: null, description: null, occurred_at: "2026-11-17T01:00:00Z", komtrax_machines: { model: "PC18MR-5", serial: "S2", equipment: null } },
    ]);
    expect(faults).toEqual([
      { machine: "PC88 & co", code: "CA2185", severity: "High", description: "Throttle <sensor>", lastSeen: "2026-11-19T01:00:00Z", times: 2 },
      { machine: "PC18MR-5 (serial S2)", code: "E10", severity: null, description: null, lastSeen: "2026-11-17T01:00:00Z", times: 1 },
    ]);
    const d = buildDigest({ ...base, machineFaults: faults });
    expect(d.text).toContain("ACTIVE MACHINE FAULTS (LAST 7 DAYS): 2");
    expect(d.text).toContain("PC88 & co  CA2185 (High)  Throttle <sensor>  last 19 Nov, 2 times");
    expect(d.text).toContain("https://app.test/dashboard/fleet");
    expect(d.html).toContain("Active machine faults (last 7 days): 2");
    expect(d.html).toContain("PC88 &amp; co");
    expect(d.html).not.toContain("<sensor>");
  });

  it("says none when there were none; leaves the section out when Komtrax isn't set up", () => {
    expect(buildDigest({ ...base, machineFaults: [] }).text).toContain("ACTIVE MACHINE FAULTS (LAST 7 DAYS): none");
    expect(buildDigest({ ...base, machineFaults: null }).text).not.toContain("MACHINE FAULTS");
    expect(buildDigest(base).html).not.toContain("machine faults");
  });
});

describe("display helpers", () => {
  it("maps link, fuel, age, severity", () => {
    expect(mapsUrl(-37.6, 145.1)).toBe("https://www.google.com/maps/search/?api=1&query=-37.600000,145.100000");
    expect(fuelText(61.24, "litre")).toBe("61.2 L");
    expect(fuelText(null, null)).toBe("—");
    const now = Date.parse("2026-11-20T06:00:00Z");
    expect(ageText("2026-11-20T03:00:00Z", now)).toBe("3 h ago");
    expect(ageText("2026-11-16T06:00:00Z", now)).toBe("4 days ago");
    expect(ageText(null, now)).toBe("never");
    expect(severityTone("High")).toBe("high");
    expect(severityTone("Caution")).toBe("medium");
    expect(severityTone(null)).toBe("low");
  });
});
