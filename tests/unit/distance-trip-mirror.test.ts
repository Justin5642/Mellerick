import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distanceNote, floatTripEnds, kmFieldText, truckLoadTripEnds } from "@/lib/distance-trip";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n");

describe("lib/distance-trip.ts and mobile/lib/distanceTrip.ts", () => {
  it("are identical from the first export on, with no imports", () => {
    const fromFirstExport = (p: string) => {
      const lines = read(p);
      const first = lines.findIndex((l) => l.startsWith("export "));
      expect(first).toBeGreaterThan(-1);
      expect(lines.some((l) => l.startsWith("import "))).toBe(false);
      return lines.slice(first).join("\n");
    };
    expect(fromFirstExport("mobile/lib/distanceTrip.ts")).toBe(fromFirstExport("lib/distance-trip.ts"));
  });
});

describe("trip ends", () => {
  it("float: pick-up → drop-off, an empty end is the job site", () => {
    expect(floatTripEnds("Epping depot", "Lot 4")).toEqual({ from: "Epping depot", to: "Lot 4" });
    expect(floatTripEnds(" Epping depot ", "")).toEqual({ from: "Epping depot", to: "site" });
    expect(floatTripEnds("", "Kew")).toEqual({ from: "site", to: "Kew" });
    expect(floatTripEnds("", " ")).toHaveProperty("error");
  });

  it("material in: the quarry → the job site, unless From / To are typed", () => {
    expect(truckLoadTripEnds({ direction: "material_in", place: "Boral Wollert", from_text: "", to_text: "" })).toEqual({ from: "Boral Wollert", to: "site" });
    expect(truckLoadTripEnds({ direction: "material_in", place: "Boral Wollert", from_text: "Hanson Epping", to_text: "Lot 9" })).toEqual({ from: "Hanson Epping", to: "Lot 9" });
    expect(truckLoadTripEnds({ direction: "material_in", place: "", from_text: "", to_text: "" })).toHaveProperty("error");
  });

  it("spoil out: the job site → the tip", () => {
    expect(truckLoadTripEnds({ direction: "spoil_out", place: "Wollert tip", from_text: "", to_text: "" })).toEqual({ from: "site", to: "Wollert tip" });
    expect(truckLoadTripEnds({ direction: "spoil_out", place: "", from_text: "", to_text: "" })).toHaveProperty("error");
  });

  it("reads the answer", () => {
    const r = { km: 23.4, from: { label: "Boral Wollert", precise: true }, to: { label: "12 Smith St", precise: true }, approximate: false };
    expect(distanceNote(r)).toBe("≈ 23.4 km by road from Boral Wollert to 12 Smith St");
    expect(distanceNote({ ...r, approximate: true })).toMatch(/approximate/);
    expect(kmFieldText(23.4)).toBe("23.4");
    expect(kmFieldText(18)).toBe("18");
  });
});
