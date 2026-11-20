import { describe, it, expect } from "vitest";
import {
  matchEquipmentBySerial,
  parseFaultSeries,
  parseFleetPage,
  parseHourSeries,
  parseSnapshot,
} from "@/lib/komtrax-parse";

// Fixtures are written by hand in the ISO 15143-3 (AEMP 2.0) shape from the
// standard and Komatsu's manual — invented serials and values, no real data.

const fleetPage = {
  Version: "2",
  SnapshotTime: "2026-11-19T06:00:00Z",
  Links: [
    { rel: "self", href: "https://isoapi.komtrax.komatsu/provider/v1/400673/Fleet/1" },
    { rel: "next", href: "https://isoapi.komtrax.komatsu/provider/v1/400673/Fleet/2" },
  ],
  Equipment: [
    {
      EquipmentHeader: { OEMName: "Komatsu", MakeCode: "KOMATSU", Model: "PC88MR-10", EquipmentID: "Excavator 8t", SerialNumber: "TEST1001" },
      Location: { datetime: "2026-11-19T05:12:00Z", Latitude: -37.6, Longitude: 145.1 },
      CumulativeOperatingHours: { datetime: "2026-11-19T05:12:00Z", Hour: 4321.6 },
      CumulativeIdleHours: { datetime: "2026-11-19T05:12:00Z", Hour: 812.3 },
      FuelUsed: { datetime: "2026-11-19T05:12:00Z", FuelUnits: "litre", FuelConsumed: 23456.5 },
      FuelUsedLast24: { datetime: "2026-11-19T05:12:00Z", FuelUnits: "litre", FuelConsumed: 61.2 },
      FuelRemaining: { datetime: "2026-11-19T05:12:00Z", Percent: 55 },
      DEFRemaining: { datetime: "2026-11-19T05:12:00Z", Percent: 80 },
    },
    {
      // camelCase keys, string numbers, no fuel or location reported
      equipmentHeader: { oemName: "Komatsu", model: "PC18MR-5", serialNumber: "TEST2002" },
      cumulativeOperatingHours: { datetime: "2026-11-19T04:00:00Z", hour: "1203.0" },
      location: { datetime: "2026-11-19T04:00:00Z", latitude: 0, longitude: 0 },
    },
    { EquipmentHeader: { Model: "no serial" } },
  ],
};

describe("parseFleetPage", () => {
  it("reads each machine's snapshot and the next link", () => {
    const { machines, next } = parseFleetPage(fleetPage);
    expect(next).toBe("https://isoapi.komtrax.komatsu/provider/v1/400673/Fleet/2");
    expect(machines).toHaveLength(2);
    expect(machines[0]).toMatchObject({
      make_code: "KOMATSU",
      model: "PC88MR-10",
      serial: "TEST1001",
      komtrax_label: "Excavator 8t",
      hours: 4321.6,
      hours_at: "2026-11-19T05:12:00.000Z",
      lat: -37.6,
      lng: 145.1,
      fuel_used_cumulative: 23456.5,
      fuel_used_last24: 61.2,
      fuel_units: "litre",
      fuel_remaining_pct: 55,
      def_remaining_pct: 80,
      idle_hours: 812.3,
      faults: [],
    });
  });

  it("tolerates other key casing, string numbers and missing items; 0,0 is no position", () => {
    const m = parseFleetPage(fleetPage).machines[1];
    expect(m).toMatchObject({ make_code: "Komatsu", model: "PC18MR-5", serial: "TEST2002", hours: 1203, lat: null, lng: null, location_at: null, fuel_used_last24: null });
  });

  it("reads a wrapped answer, a single object, and XML-style attribute keys", () => {
    const wrapped = { Fleet: { Equipment: { EquipmentHeader: { "@MakeCode": "KOM", "@Model": "D61", "@SerialNumber": "X1234" }, CumulativeOperatingHours: { "@datetime": "2026-11-19T00:00:00Z", Hour: { "#text": "10.5" } } } } };
    const { machines, next } = parseFleetPage(wrapped);
    expect(next).toBeNull();
    expect(machines).toEqual([expect.objectContaining({ make_code: "KOM", model: "D61", serial: "X1234", hours: 10.5 })]);
    // a single-machine snapshot with the header at the top level
    expect(parseFleetPage(fleetPage.Equipment[0]).machines[0].serial).toBe("TEST1001");
  });

  it("reads a ratio for fuel remaining and fault codes inside a snapshot", () => {
    const m = parseSnapshot({
      EquipmentHeader: { MakeCode: "K", Model: "M", SerialNumber: "S12345" },
      FuelRemaining: { Ratio: 0.42 },
      FaultCodes: { FaultCode: [{ CodeIdentifier: "CA2185", datetime: "2026-11-18T01:00:00Z", CodeSeverity: "High", CodeDescription: "Throttle sensor", CodeSource: "Engine" }] },
    });
    expect(m?.fuel_remaining_pct).toBe(42);
    expect(m?.faults).toEqual([{ code: "CA2185", severity: "High", description: "Throttle sensor", source: "Engine", occurred_at: "2026-11-18T01:00:00.000Z" }]);
  });

  it("an empty or unknown answer is no machines", () => {
    expect(parseFleetPage(null)).toEqual({ machines: [], next: null });
    expect(parseFleetPage({ message: "nothing" })).toEqual({ machines: [], next: null });
  });
});

describe("time series", () => {
  it("hour readings: oldest first, duplicates and junk dropped", () => {
    const body = {
      EquipmentHeader: { Model: "PC88MR-10", SerialNumber: "TEST1001" },
      CumulativeOperatingHours: [
        { datetime: "2026-11-19T05:00:00Z", Hour: 4321 },
        { datetime: "2026-11-18T22:00:00Z", Hour: 4316.5 },
        { datetime: "2026-11-19T05:00:00Z", Hour: 4321 },
        { datetime: "not a date", Hour: 1 },
        { datetime: "2026-11-19T06:00:00Z" },
      ],
    };
    expect(parseHourSeries(body)).toEqual([
      { read_at: "2026-11-18T22:00:00.000Z", hours: 4316.5 },
      { read_at: "2026-11-19T05:00:00.000Z", hours: 4321 },
    ]);
  });

  it("faults: either spelling, de-duplicated, a fault without a code or time is dropped", () => {
    const a = { FaultCode: [{ CodeIdentifier: "E10", datetime: "2026-11-19T01:00:00Z", CodeSeverity: "Low" }, { CodeIdentifier: "E10", datetime: "2026-11-19T01:00:00Z" }, { datetime: "2026-11-19T01:00:00Z" }] };
    expect(parseFaultSeries(a)).toHaveLength(1);
    const b = { FaultCodes: [{ codeIdentifier: "E11", dateTime: "2026-11-19T02:00:00Z", codeDescription: "Coolant temp" }] };
    expect(parseFaultSeries(b)).toEqual([{ code: "E11", severity: null, description: "Coolant temp", source: null, occurred_at: "2026-11-19T02:00:00.000Z" }]);
  });
});

describe("matchEquipmentBySerial", () => {
  const eq = [
    { id: "pc88", name: "PC88 excavator", registration: null, notes: "Serial TEST1001, bought 2022", is_active: true },
    { id: "pc18", name: "PC18 (TEST2002)", registration: null, notes: null, is_active: true },
    { id: "old", name: "Old dozer TEST3003", registration: null, notes: null, is_active: false },
    { id: "a", name: "Twin A", registration: "DUP4004", notes: null, is_active: true },
    { id: "b", name: "Twin B DUP4004", registration: null, notes: null, is_active: true },
  ];

  it("matches the serial as a whole word in name, rego or notes", () => {
    expect(matchEquipmentBySerial("TEST1001", eq)).toBe("pc88");
    expect(matchEquipmentBySerial("test2002", eq)).toBe("pc18");
  });

  it("no match for inactive items, part-words, two candidates, short serials, or an item already linked", () => {
    expect(matchEquipmentBySerial("TEST3003", eq)).toBeNull();
    expect(matchEquipmentBySerial("TEST100", eq)).toBeNull();
    expect(matchEquipmentBySerial("DUP4004", eq)).toBeNull();
    expect(matchEquipmentBySerial("123", [{ id: "x", name: "123", registration: null, notes: null, is_active: true }])).toBeNull();
    expect(matchEquipmentBySerial("TEST1001", eq, new Set(["pc88"]))).toBeNull();
  });
});
