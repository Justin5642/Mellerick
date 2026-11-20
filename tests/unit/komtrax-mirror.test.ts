import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { meterDays, meterNote, prefillMeters, type MeterDraft, type MeterReadings } from "@/lib/komtrax-meter";

// The phone's Day Works form prefills engine-hour meters from Komtrax with a
// copy of the web's rule. Both must fill (and refuse to overwrite) alike.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const afterHeader = (p: string) => {
  const lines = read(p).split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("//") || lines[i] === "")) i++;
  return lines.slice(i).join("\n");
};

describe("Komtrax meter prefill mirror", () => {
  it("mobile/lib/komtraxMeter.ts is lib/komtrax-meter.ts below the header", () => {
    expect(afterHeader("mobile/lib/komtraxMeter.ts")).toBe(afterHeader("lib/komtrax-meter.ts"));
  });

  it("has no imports (so the phone copy stands alone)", () => {
    expect(read("lib/komtrax-meter.ts")).not.toMatch(/^import /m);
  });
});

const melb = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

describe("meterDays", () => {
  it("groups by Melbourne day: first reading opens, last closes", () => {
    const days = meterDays(
      [
        { read_at: "2026-11-18T22:00:00.000Z", hours: 1004.2 }, // 19 Nov 09:00 AEDT
        { read_at: "2026-11-18T14:30:00.000Z", hours: "1000" }, // 19 Nov 01:30 AEDT
        { read_at: "2026-11-19T05:00:00.000Z", hours: 1009.9 }, // 19 Nov 16:00 AEDT
        { read_at: "2026-11-19T13:30:00.000Z", hours: 1010 }, //   20 Nov 00:30 AEDT
        { read_at: "2026-11-19T13:40:00.000Z", hours: "bad" },
      ],
      melb
    );
    expect(days["2026-11-19"]).toEqual({ open: 1000, close: 1009.9, first_at: "2026-11-18T14:30:00.000Z", last_at: "2026-11-19T05:00:00.000Z", readings: 3 });
    expect(days["2026-11-20"]).toMatchObject({ open: 1010, close: 1010, readings: 1 });
  });
});

describe("prefillMeters", () => {
  const readings: MeterReadings = {
    pc88: { "2026-11-19": { open: 1000, close: 1009.94, first_at: "a", last_at: "b", readings: 3 } },
  };
  const draft = (over: Partial<MeterDraft> = {}): MeterDraft => ({
    id: null,
    equipment_id: "pc88",
    work_date: "2026-11-19",
    optionKey: "dry|engine_hour",
    meter_open: "",
    meter_close: "",
    ...over,
  });

  it("fills an empty new engine-hour line, rounded to 0.1", () => {
    const d = prefillMeters(draft(), readings);
    expect(d).toMatchObject({ meter_open: "1000", meter_close: "1009.9", meter_auto: { open: "1000", close: "1009.9" } });
    expect(meterNote(d, readings)).toMatch(/Filled from Komtrax \(first and last of 3/);
  });

  it("never fills another unit, an existing entry, or a machine/day with no readings", () => {
    expect(prefillMeters(draft({ optionKey: "dry|day" }), readings).meter_open).toBe("");
    expect(prefillMeters(draft({ id: "e1" }), readings).meter_open).toBe("");
    expect(prefillMeters(draft({ work_date: "2026-11-18" }), readings).meter_open).toBe("");
    expect(prefillMeters(draft({ equipment_id: "bobcat" }), readings).meter_open).toBe("");
    expect(prefillMeters(draft(), null).meter_open).toBe("");
  });

  it("keeps what the crew typed", () => {
    const typed = draft({ meter_open: "998", meter_close: "" });
    expect(prefillMeters(typed, readings)).toEqual(typed);
    // typed over a Komtrax value: kept, and no longer counted as Komtrax's
    const overwritten = prefillMeters(draft({ meter_open: "998", meter_close: "1009.9", meter_auto: { open: "1000", close: "1009.9" } }), readings);
    expect(overwritten).toMatchObject({ meter_open: "998", meter_close: "1009.9", meter_auto: null });
    expect(meterNote(overwritten, readings)).toBe("Komtrax read 1000 → 1009.9 that day.");
  });

  it("clears its own values when the date moves to a day with no readings, refills when it moves back", () => {
    const filled = prefillMeters(draft(), readings);
    const moved = prefillMeters({ ...filled, work_date: "2026-11-18" }, readings);
    expect(moved).toMatchObject({ meter_open: "", meter_close: "", meter_auto: null });
    expect(prefillMeters({ ...moved, work_date: "2026-11-19" }, readings).meter_close).toBe("1009.9");
  });
});
