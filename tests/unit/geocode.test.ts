import { describe, it, expect } from "vitest";
import { ADDRESS_SEARCH_LIMIT, isPreciseEnough, shapeAddressSuggestions, siteAddress } from "@/lib/geocode";

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

describe("shapeAddressSuggestions — the map dialog's address search", () => {
  const house = { lat: "-37.65", lon: "145.02", display_name: "12, Smith Street, Epping, City of Whittlesea, Victoria, 3076, Australia", class: "place", type: "house", addresstype: "place" };
  const street = { lat: "-37.651", lon: "145.03", display_name: "Smith Street, Epping, City of Whittlesea, Victoria, 3076, Australia", class: "highway", type: "residential", addresstype: "road" };
  const suburb = { lat: "-37.64", lon: "145.01", display_name: "Epping, City of Whittlesea, Victoria, 3076, Australia", class: "boundary", type: "administrative", addresstype: "suburb" };

  it("keeps street and suburb matches, labelled approximate, after the precise ones", () => {
    const out = shapeAddressSuggestions([street, suburb, house]);
    expect(out.map((o) => [o.label, o.precise])).toEqual([
      ["12 Smith Street, Epping, City of Whittlesea", true],
      ["Smith Street, Epping, City of Whittlesea", false],
      ["Epping, City of Whittlesea, Victoria", false],
    ]);
    expect(out[0]).toMatchObject({ lat: -37.65, lng: 145.02, display: house.display_name });
  });

  it("drops rows with no usable point or name, and near-duplicates", () => {
    const out = shapeAddressSuggestions([
      house,
      { ...house, lat: "-37.650001" },
      { ...house, lat: "nope" },
      { ...house, lat: undefined },
      { ...house, lat: "-37.7", display_name: "  " },
    ]);
    expect(out).toHaveLength(1);
  });

  it("stops at the limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...street, lat: String(-37.6 - i * 0.01) }));
    expect(shapeAddressSuggestions(rows)).toHaveLength(ADDRESS_SEARCH_LIMIT);
    expect(shapeAddressSuggestions(rows, 2)).toHaveLength(2);
  });

  it("joins a unit/house number range to its street", () => {
    const [r] = shapeAddressSuggestions([{ ...house, display_name: "3/15, High Street, Kew, Melbourne, Victoria" }]);
    expect(r.label).toBe("3/15 High Street, Kew, Melbourne");
  });
});
