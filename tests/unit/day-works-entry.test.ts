import { describe, it, expect } from "vitest";
import { buildHireEntryRow, clashWarning, dayWorksWriteError, decodeSignaturePng } from "@/lib/day-works-entry";

// The rules the web Day Works form and the phone's API routes share
// (lib/day-works-entry.ts). The web form's messages are kept word for word.

const wet = { hire_type: "wet" as const, hire_unit: "hour" as const };

describe("buildHireEntryRow", () => {
  const input = { equipment_id: "m1", ...wet, work_date: "2026-11-16", hours: "6.5", days: "3", km: "40", pickup: "Depot", dropoff: "Site", description: "  Trenching " };

  it("keeps only the fields for the entry's unit", () => {
    const r = buildHireEntryRow(input, wet);
    expect(r).toEqual({
      ok: true,
      row: { equipment_id: "m1", ...wet, work_date: "2026-11-16", hours: 6.5, days: null, meter_open: null, meter_close: null, km: null, pickup: null, dropoff: null, description: "Trenching" },
    });
  });

  it("keeps km, from and to for a float; blank text becomes null", () => {
    const r = buildHireEntryRow({ ...input, hire_type: "float", hire_unit: "move", pickup: " ", description: "" }, { hire_type: "float", hire_unit: "move" });
    expect(r.ok && r.row).toMatchObject({ km: 40, pickup: null, dropoff: "Site", hours: null, description: null });
  });

  it("refuses with the web form's words", () => {
    expect(buildHireEntryRow(input, null)).toEqual({ ok: false, error: "Pick the machine and how it's hired." });
    expect(buildHireEntryRow({ ...input, hire_type: "dry", hire_unit: "day" }, wet)).toEqual({ ok: false, error: "Pick the machine and how it's hired." });
    expect(buildHireEntryRow({ ...input, work_date: "" }, wet)).toEqual({ ok: false, error: "Pick the date." });
    expect(buildHireEntryRow({ ...input, hours: "x" }, wet)).toEqual({ ok: false, error: "Check the numbers entered." });
    expect(buildHireEntryRow({ ...input, hire_type: "dry", hire_unit: "day", days: 1.5 }, { hire_type: "dry", hire_unit: "day", whole_days_only: true })).toEqual({
      ok: false,
      error: "This machine is hired in full days only.",
    });
  });
});

describe("dayWorksWriteError — fixed sentences only", () => {
  it("passes the trigger's own sentences through, and nothing else", () => {
    expect(dayWorksWriteError({ code: "42501", message: "This Day Works entry is signed and locked. Ask the office if it needs changing." })).toEqual({
      status: 403,
      error: "This Day Works entry is signed and locked. Ask the office if it needs changing.",
    });
    expect(dayWorksWriteError({ code: "XX000", message: "relation hire_entries column secret_rate" }).error).toBe("Couldn't save the entry. Try again.");
    expect(dayWorksWriteError({ code: "23505", message: "duplicate key hire_entries_one_per_machine_day" }).status).toBe(409);
  });
});

describe("clashWarning", () => {
  it("names the attachment and machines for this entry only", () => {
    const clashes = [{ attachment: "Trencher", work_date: "2026-11-16", machines: ["Bobcat (this job)", "PC18 (job #812)"], entry_ids: ["e1"] }];
    expect(clashWarning(clashes, "e1")).toMatch(/Trencher is ticked on Bobcat \(this job\) and PC18 \(job #812\)/);
    expect(clashWarning(clashes, "e2")).toBeNull();
  });
});

describe("decodeSignaturePng", () => {
  it("accepts a PNG with or without its data: prefix, and refuses anything else", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    expect(decodeSignaturePng(png).ok).toBe(true);
    expect(decodeSignaturePng(`data:image/png;base64,${png}`).ok).toBe(true);
    expect(decodeSignaturePng("").ok).toBe(false);
    expect(decodeSignaturePng("/9j/4AAQSkZJRgABAQAAAQABAAD").ok).toBe(false);
    expect(decodeSignaturePng("not base64!").ok).toBe(false);
  });
});
