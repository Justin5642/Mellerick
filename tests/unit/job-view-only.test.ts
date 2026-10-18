import { describe, it, expect } from "vitest";
import { isJobViewOnly, VIEW_ONLY_TABS } from "@/lib/job-view-only";

describe("isJobViewOnly — the web job page matches the database's write rule (0074)", () => {
  it("is view-only for a technician who is not on the crew", () => {
    expect(isJobViewOnly(false, ["someone-else"], "me")).toBe(true);
    expect(isJobViewOnly(false, [], "me")).toBe(true);
  });

  it("is editable for any technician on the crew, not just the first", () => {
    expect(isJobViewOnly(false, ["lead", "me"], "me")).toBe(false);
  });

  it("is always editable for office and admin", () => {
    expect(isJobViewOnly(true, [], "me")).toBe(false);
  });

  it("keeps only the read-only tabs, and none of the action tabs", () => {
    expect(VIEW_ONLY_TABS).toEqual(["overview", "documents", "photos", "notes"]);
    for (const action of ["time", "variations", "expenses", "equipment", "items", "signature", "po", "costing"]) {
      expect(VIEW_ONLY_TABS).not.toContain(action);
    }
  });
});
