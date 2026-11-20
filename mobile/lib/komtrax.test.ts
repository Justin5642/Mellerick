jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

import { komtraxLiveHours, komtraxMapsUrl, type KomtraxForMachine } from "./fleetOffice";
import { serviceDue } from "./serviceDue";
import { emptyDraft } from "./dayWorks";
import { prefillMeters } from "./komtraxMeter";

// Komtrax on the phone (0113, drafted — not applied yet): the machine screen's
// live hours feed service due, and the Day Works form prefills meters.

const machine = (hours: number | null): KomtraxForMachine => ({
  connected: true,
  ready: true,
  faults: [],
  machine: { id: "m", model: "PC88MR-10", serial: "S1", hours, hours_at: "2026-11-20T00:00:00Z", lat: -37.6, lng: 145.1, location_at: null, fuel_used_cumulative: null, fuel_used_last24: null, fuel_units: null, fuel_remaining_pct: null, def_remaining_pct: null, idle_hours: null, last_seen_at: null },
});

describe("Komtrax on the machine screen", () => {
  it("live hours only when the machine reports them", () => {
    expect(komtraxLiveHours(null)).toBeNull();
    expect(komtraxLiveHours(machine(null))).toBeNull();
    expect(komtraxLiveHours({ connected: false, ready: false, machine: null, faults: [] })).toBeNull();
    expect(komtraxLiveHours(machine(4510))).toEqual({ hours: 4510, at: "2026-11-20T00:00:00Z" });
  });

  it("service due counts the live meter", () => {
    const rec = { id: "r", equipment_id: "e", service_date: "2026-06-01", service_type: "scheduled", odometer_km: null, engine_hours: 4000, next_due_date: null, next_due_km: null, next_due_hours: 4500 };
    expect(serviceDue([rec], "2026-11-20", komtraxLiveHours(machine(4510))).state).toBe("overdue");
  });

  it("maps link", () => {
    expect(komtraxMapsUrl(-37.6, 145.1)).toBe("https://www.google.com/maps/search/?api=1&query=-37.600000,145.100000");
  });
});

describe("Day Works meter prefill on the phone", () => {
  it("a new engine-hour line fills from that day's readings", () => {
    const d = { ...emptyDraft("2026-11-19"), equipment_id: "pc88", optionKey: "dry|engine_hour" };
    const filled = prefillMeters(d, { pc88: { "2026-11-19": { open: 1000, close: 1007.5, first_at: "a", last_at: "b", readings: 2 } } });
    expect(filled).toMatchObject({ meter_open: "1000", meter_close: "1007.5" });
  });
});
