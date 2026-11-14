import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeSiteNotes,
  findDuplicateSite,
  normaliseState,
  streetKey,
  validateSiteAddress,
} from "@/lib/site-address";

const good = { address_line1: " 12  Smith St ", suburb: "Nutfield", state: "vic", postcode: "3099" };

describe("validateSiteAddress", () => {
  it("accepts a full address, tidies it and defaults the name to the street", () => {
    const r = validateSiteAddress(good);
    expect(r).toEqual({
      ok: true,
      value: { name: "12 Smith St", address_line1: "12 Smith St", address_line2: null, suburb: "Nutfield", state: "VIC", postcode: "3099" },
    });
  });

  it("keeps a typed site name and line 2", () => {
    const r = validateSiteAddress({ ...good, name: "Lot 12 Riverside", address_line2: "Unit 3" });
    expect(r.ok && r.value.name).toBe("Lot 12 Riverside");
    expect(r.ok && r.value.address_line2).toBe("Unit 3");
  });

  it("requires street, suburb, state and postcode", () => {
    const r = validateSiteAddress({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["address_line1", "postcode", "state", "suburb"]);
  });

  it("rejects a street with no street name, a bad state and a bad postcode", () => {
    const r = validateSiteAddress({ address_line1: "12", suburb: "Nutfield", state: "Vicc", postcode: "30999" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.address_line1).toMatch(/street name/);
      expect(r.errors.state).toMatch(/Australian state/);
      expect(r.errors.postcode).toMatch(/4 digits/);
      expect(r.message).toBe(r.errors.address_line1);
    }
  });

  it("normalises full state names", () => {
    expect(normaliseState("Victoria")).toBe("VIC");
    expect(normaliseState("new south wales")).toBe("NSW");
    expect(normaliseState("XYZ")).toBeNull();
  });
});

describe("findDuplicateSite", () => {
  const sites = [
    { id: "a", address_line1: "12 Smith Street", suburb: "NUTFIELD", postcode: "3099", is_active: true },
    { id: "b", address_line1: "5 Pony Promenade", suburb: "Donnybrook", postcode: "3064", is_active: false },
  ];

  it("matches regardless of case, spacing, punctuation and St/Street", () => {
    expect(findDuplicateSite({ address_line1: "12, smith st.", suburb: " nutfield ", postcode: "3099" }, sites)?.id).toBe("a");
  });

  it("treats a missing postcode on either side as no conflict", () => {
    expect(findDuplicateSite({ address_line1: "12 Smith St", suburb: "Nutfield" }, sites)?.id).toBe("a");
  });

  it("does not match a different postcode, suburb or number", () => {
    expect(findDuplicateSite({ address_line1: "12 Smith St", suburb: "Nutfield", postcode: "3000" }, sites)).toBeNull();
    expect(findDuplicateSite({ address_line1: "12 Smith St", suburb: "Doreen", postcode: "3099" }, sites)).toBeNull();
    expect(findDuplicateSite({ address_line1: "14 Smith St", suburb: "Nutfield", postcode: "3099" }, sites)).toBeNull();
  });

  it("ignores archived sites", () => {
    expect(findDuplicateSite({ address_line1: "5 Pony Prom", suburb: "Donnybrook", postcode: "3064" }, sites)).toBeNull();
  });

  it("compares unit numbers whether written 3/12 or Unit 3, 12", () => {
    expect(streetKey({ address_line1: "3/12 Smith St" })).toBe(streetKey({ address_line1: "Unit 3, 12 Smith Street" }));
  });
});

describe("composeSiteNotes", () => {
  it("labels the contact and access notes, and is null when both are blank", () => {
    expect(composeSiteNotes({ contact: "Dave 0400 000 000", access: "Gate code 1234" })).toBe(
      "Site contact: Dave 0400 000 000\nAccess: Gate code 1234"
    );
    expect(composeSiteNotes({ contact: " ", access: "" })).toBeNull();
  });
});

describe("lib/site-address.ts and mobile/lib/siteAddress.ts", () => {
  // The phone and the website must agree on what a valid address and a
  // duplicate site are. Only the header comment may differ.
  it("are identical below the header", () => {
    const body = (p: string) => readFileSync(join(process.cwd(), p), "utf8").split("\n").slice(6).join("\n");
    expect(body("mobile/lib/siteAddress.ts")).toBe(body("lib/site-address.ts"));
  });
});
