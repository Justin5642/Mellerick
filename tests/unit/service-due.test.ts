import { describe, it, expect } from "vitest";
import { dueLabel, isServiceTableMissing, serviceDue, sortRecords, type ServiceRecord } from "@/lib/service-due";

let n = 0;
const rec = (over: Partial<ServiceRecord>): ServiceRecord => ({
  id: `r${++n}`,
  equipment_id: "ute",
  service_date: "2026-05-01",
  service_type: "scheduled",
  odometer_km: null,
  engine_hours: null,
  next_due_date: null,
  next_due_km: null,
  next_due_hours: null,
  ...over,
});
const today = "2026-11-14";

describe("serviceDue", () => {
  it("nothing recorded", () => {
    const d = serviceDue([], today);
    expect(d.state).toBe("none");
    expect(dueLabel(d)).toBe("No service recorded");
  });

  it("uses the LATEST service's next-due, not an older one", () => {
    const d = serviceDue(
      [
        rec({ service_date: "2026-01-10", next_due_date: "2026-07-10" }), // long overdue on its own
        rec({ service_date: "2026-09-01", next_due_date: "2027-03-01", next_due_km: 94_210, odometer_km: 84_210 }),
      ],
      today
    );
    expect(d.state).toBe("ok");
    expect(d.dueDate).toBe("2027-03-01");
    expect(d.daysUntil).toBe(107);
    expect(d.dueKm).toBe(94_210);
    expect(dueLabel(d)).toBe("Next service in 107 days");
  });

  it("overdue and due-soon by date", () => {
    expect(dueLabel(serviceDue([rec({ next_due_date: "2026-11-10" })], today))).toBe("Service overdue by 4 days");
    expect(dueLabel(serviceDue([rec({ next_due_date: "2026-11-13" })], today))).toBe("Service overdue by 1 day");
    expect(dueLabel(serviceDue([rec({ next_due_date: today })], today))).toBe("Service due today");
    expect(serviceDue([rec({ next_due_date: "2026-12-14" })], today).state).toBe("due_soon"); // 30 days
    expect(serviceDue([rec({ next_due_date: "2026-12-15" })], today).state).toBe("ok");
  });

  it("km / hours targets never mark it overdue on their own, but are reported with the last reading", () => {
    const d = serviceDue(
      [
        rec({ service_date: "2026-03-01", odometer_km: 80_000, engine_hours: "1200.5" }),
        rec({ service_date: "2026-09-01", odometer_km: 84_210, next_due_km: 94_210, next_due_hours: "1450" }),
      ],
      today
    );
    expect(d.state).toBe("no_due_date");
    expect(d.lastKm).toBe(84_210);
    expect(d.lastHours).toBe(1200.5);
    expect(d.dueHours).toBe(1450);
  });

  it("same-day services: the one entered last counts", () => {
    const sorted = sortRecords([
      rec({ id: "a", service_date: "2026-09-01", created_at: "2026-09-01T01:00:00Z" }),
      rec({ id: "b", service_date: "2026-09-01", created_at: "2026-09-01T05:00:00Z" }),
    ]);
    expect(sorted[0].id).toBe("b");
  });
});

it("recognises an unapplied 0099 by PostgREST's error codes", () => {
  expect(isServiceTableMissing({ code: "PGRST205" })).toBe(true);
  expect(isServiceTableMissing({ code: "42P01" })).toBe(true);
  expect(isServiceTableMissing({ code: "42501" })).toBe(false);
  expect(isServiceTableMissing(null)).toBe(false);
});
