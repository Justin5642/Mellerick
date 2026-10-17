import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { canEditTimeEntry } from "@/lib/time-entry-access";

// The Time tab's edit dialog only opened for your own entries (or for an
// admin), but the stage picker under every entry was live for everyone — any
// user could move a colleague's hours onto another stage. One rule now gates
// both.

describe("canEditTimeEntry", () => {
  it("lets you change your own entry", () => {
    expect(canEditTimeEntry({ staff_id: "me" }, "me", false)).toBe(true);
  });
  it("does not let a non-admin change someone else's", () => {
    expect(canEditTimeEntry({ staff_id: "them" }, "me", false)).toBe(false);
    expect(canEditTimeEntry({ staff_id: "them" }, "me", undefined)).toBe(false);
  });
  it("lets an admin change anyone's", () => {
    expect(canEditTimeEntry({ staff_id: "them" }, "me", true)).toBe(true);
  });
});

describe("components/job/job-time.tsx uses it for the stage picker", () => {
  const src = readFileSync("components/job/job-time.tsx", "utf8");

  it("disables the picker for entries the viewer cannot edit", () => {
    expect(src).toMatch(/disabled=\{!canEdit \|\| assigningId === entry\.id\}/);
  });

  it("re-checks before writing, not only in the render", () => {
    const fn = src.slice(src.indexOf("async function assignCostCenter"), src.indexOf("setAssigningId(entryId)"));
    expect(fn).toMatch(/canEditTimeEntry\(/);
  });
});
