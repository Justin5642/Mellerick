import { describe, it, expect } from "vitest";
import { invoiceJobSite, quoteJobSite, siteLines, xeroReference } from "@/lib/job-site";

const pony = {
  name: "Lot 2, 9 Pony Promenade, Seymour",
  address_line1: "Lot 2, 9 Pony Promenade",
  address_line2: null,
  suburb: "Seymour",
  state: "VIC",
  postcode: "3660",
};

describe("siteLines", () => {
  it("keeps the lot number and hides a name that only repeats the address", () => {
    expect(siteLines(pony)).toEqual(["Lot 2, 9 Pony Promenade", "Seymour VIC 3660"]);
  });
  it("shows a name that adds something", () => {
    expect(
      siteLines({ name: "Melton highway and Calder Park Drive, Sydenham", address_line1: "Calder Park Drive", suburb: "Sydenham", state: "VIC", postcode: "" })
    ).toEqual(["Melton highway and Calder Park Drive, Sydenham", "Calder Park Drive", "Sydenham VIC"]);
  });
  it("doesn't repeat a suburb already in the street line", () => {
    expect(siteLines({ name: "3 Muir Way, Mernda VIC 3754", address_line1: "3 Muir Way, Mernda VIC 3754", suburb: "Mernda", state: "VIC", postcode: "3754" })).toEqual([
      "3 Muir Way, Mernda VIC 3754",
    ]);
  });
  it("is empty without a site", () => {
    expect(siteLines(null)).toEqual([]);
  });
});

describe("invoiceJobSite", () => {
  it("uses the job's site", () => {
    expect(invoiceJobSite({ jobs: { job_number: 566, sites: pony } })).toEqual({
      jobNumber: 566,
      lines: ["Lot 2, 9 Pony Promenade", "Seymour VIC 3660"],
    });
  });
  it("falls back to the quote's site when there is no job", () => {
    expect(invoiceJobSite({ jobs: null, quotes: { sites: pony } })?.lines).toEqual(["Lot 2, 9 Pony Promenade", "Seymour VIC 3660"]);
  });
  it("is null with neither", () => {
    expect(invoiceJobSite({ jobs: null, quotes: null })).toBeNull();
  });
});

describe("quoteJobSite / xeroReference", () => {
  it("builds the quote site", () => {
    expect(quoteJobSite({ sites: pony, jobs: null })?.lines[0]).toBe("Lot 2, 9 Pony Promenade");
  });
  it("puts the job number and the address in the Xero reference", () => {
    expect(xeroReference(invoiceJobSite({ jobs: { job_number: 566, sites: pony } }))).toBe(
      "Job #566 · Lot 2, 9 Pony Promenade, Seymour VIC 3660"
    );
    expect(xeroReference(null)).toBeUndefined();
  });
});
