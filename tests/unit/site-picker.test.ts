import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compareSites, filterSites, siteDetail, siteMatches, type PickerSite } from "@/lib/site-picker";

const S = (name: string, address_line1: string | null = null, suburb: string | null = null, postcode: string | null = null) => ({
  id: name,
  name,
  address_line1,
  suburb,
  postcode,
});

const sites = [
  S("Lot 10", "10 Smith St", "Epping", "3076"),
  S("lot 2", "2 Smith St", "Epping", "3076"),
  S("Warehouse", "55 High St", "Thomastown", "3074"),
  S("Asbury Estate", "1 Asbury Rd", "Doreen"),
  S("Lot 1", null, "Mernda"),
];

describe("filterSites — A–Z", () => {
  it("sorts by name, ignoring case, numbers by value", () => {
    expect(filterSites(sites).map((s) => s.name)).toEqual(["Asbury Estate", "Lot 1", "lot 2", "Lot 10", "Warehouse"]);
  });

  it("does not reorder the list it was given", () => {
    const before = sites.map((s) => s.name);
    filterSites(sites);
    expect(sites.map((s) => s.name)).toEqual(before);
  });

  it("breaks a name tie by suburb", () => {
    const a: PickerSite = { name: "Home", suburb: "Preston" };
    const b: PickerSite = { name: "home", suburb: "Bundoora" };
    expect([a, b].sort(compareSites)).toEqual([b, a]);
  });
});

describe("filterSites — search", () => {
  it("shows everything for an empty or blank query", () => {
    expect(filterSites(sites, "  ")).toHaveLength(sites.length);
  });

  it("matches name, street, suburb and postcode, case-blind", () => {
    expect(filterSites(sites, "warehouse").map((s) => s.name)).toEqual(["Warehouse"]);
    expect(filterSites(sites, "HIGH st").map((s) => s.name)).toEqual(["Warehouse"]);
    expect(filterSites(sites, "mernda").map((s) => s.name)).toEqual(["Lot 1"]);
    expect(filterSites(sites, "3074").map((s) => s.name)).toEqual(["Warehouse"]);
  });

  it("needs every word to match somewhere, in any order", () => {
    expect(filterSites(sites, "smith 10").map((s) => s.name)).toEqual(["Lot 10"]);
    expect(filterSites(sites, "epping, smith").map((s) => s.name)).toEqual(["lot 2", "Lot 10"]);
    expect(filterSites(sites, "smith doreen")).toEqual([]);
  });

  it("copes with missing address parts", () => {
    expect(siteMatches({ name: "Shed" }, "shed")).toBe(true);
    expect(siteMatches({ name: "Shed", suburb: null }, "epping")).toBe(false);
  });
});

describe("siteDetail", () => {
  it("joins the street and suburb it has", () => {
    expect(siteDetail(S("x", "2 Smith St", "Epping"))).toBe("2 Smith St, Epping");
    expect(siteDetail(S("x", null, "Epping"))).toBe("Epping");
    expect(siteDetail(S("x", " ", null))).toBe("");
  });
});

describe("lib/site-picker.ts and mobile/lib/sitePicker.ts", () => {
  it("are identical apart from comments", () => {
    const body = (f: string) => readFileSync(f, "utf8").replace(/^\/\/.*$/gm, "").trim();
    expect(body("mobile/lib/sitePicker.ts")).toBe(body("lib/site-picker.ts"));
  });
});
