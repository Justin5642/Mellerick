import { describe, it, expect } from "vitest";
import { isPreciseEnough, siteAddress } from "@/lib/geocode";

describe("siteAddress", () => {
  it("builds a full Australian address", () => {
    expect(siteAddress({ address_line1: "21 Quinlan Rd", suburb: "Epping", state: "VIC", postcode: "3076" })).toBe(
      "21 Quinlan Rd, Epping VIC 3076, Australia"
    );
  });
  it("drops unit prefixes Nominatim cannot match", () => {
    expect(siteAddress({ address_line1: "3/15 Smith St", suburb: "Preston" })).toBe("15 Smith St, Preston, Australia");
    expect(siteAddress({ address_line1: "Unit 4, 9 High St", suburb: "Kew" })).toBe("9 High St, Kew, Australia");
  });
  it("is null without a street line", () => {
    expect(siteAddress({ suburb: "Epping" })).toBeNull();
  });
});

describe("isPreciseEnough — only building/address-level results drive a 150 m geofence", () => {
  it("rejects a land-use zone (an estate's centroid), whatever its type", () => {
    expect(isPreciseEnough({ class: "landuse", type: "residential" })).toBe(false);
    expect(isPreciseEnough({ class: "landuse", type: "commercial" })).toBe(false);
  });

  it("accepts a house or building", () => {
    expect(isPreciseEnough({ class: "place", type: "house", addresstype: "place" })).toBe(true);
    expect(isPreciseEnough({ class: "building", type: "yes" })).toBe(true);
  });
  it("rejects a street, suburb or postcode match", () => {
    expect(isPreciseEnough({ class: "highway", type: "residential", addresstype: "road" })).toBe(false);
    expect(isPreciseEnough({ class: "boundary", type: "administrative", addresstype: "suburb" })).toBe(false);
    expect(isPreciseEnough({ class: "place", type: "postcode", addresstype: "postcode" })).toBe(false);
  });
});
