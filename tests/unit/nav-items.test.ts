import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_ITEMS, navItemsFor, mayOpen } from "../../lib/nav-items";

// A technician signed into the web app was shown clickable links to every
// office screen, because navItems was an unfiltered const and the role was
// spent on a text label. RLS refuses the money either way — that boundary is
// migrations 0027/0028/0034/0035/0038/0042/0045 and is not this file's job —
// but three tables still carry the wide-open baseline policy, so what was
// reachable was the staff roster with colleague emails and phone numbers, the
// whole customer book, and every job and schedule.
//
// Hiding a link only changes what is CLICKABLE, so middleware.ts refuses the
// route as well. Both read this module, and these tests pin the rule they share.

describe("navItemsFor", () => {
  it("gives office and admin everything", () => {
    expect(navItemsFor("office")).toHaveLength(NAV_ITEMS.length);
    expect(navItemsFor("admin")).toHaveLength(NAV_ITEMS.length);
  });

  it("gives a technician only the screens they work from", () => {
    expect(navItemsFor("technician").map((i) => i.href).sort()).toEqual([
      "/dashboard/backflow",
      "/dashboard/jobs",
      "/dashboard/my-jobs",
    ]);
  });

  it("treats an unknown or missing role as NOT a technician", () => {
    // Deliberate: the only role that loses access is the one named. A profile
    // row that failed to load must not silently strip an office user's
    // navigation — and it cannot leak money, because RLS is the boundary.
    expect(navItemsFor(undefined)).toHaveLength(NAV_ITEMS.length);
    expect(navItemsFor("")).toHaveLength(NAV_ITEMS.length);
  });
});

describe("mayOpen", () => {
  it("refuses a technician the screens behind the money and the roster", () => {
    for (const path of [
      "/dashboard/staff",
      "/dashboard/customers",
      "/dashboard/invoices",
      "/dashboard/reports",
      "/dashboard/pricing",
      "/dashboard/settings",
      "/dashboard/schedule",
    ]) {
      expect(mayOpen("technician", path), path).toBe(false);
    }
  });

  it("allows a technician their own screens, including nested routes", () => {
    // A job detail page is /dashboard/jobs/<id> — refusing that would stop a
    // technician opening the job they are standing in front of.
    expect(mayOpen("technician", "/dashboard/jobs")).toBe(true);
    expect(mayOpen("technician", "/dashboard/jobs/abc-123")).toBe(true);
    expect(mayOpen("technician", "/dashboard/my-jobs")).toBe(true);
    expect(mayOpen("technician", "/dashboard/backflow/xyz/test/new")).toBe(true);
  });

  it("does not let a prefix match open a different section", () => {
    // "/dashboard/jobs" must not admit "/dashboard/jobs-report" — the check is
    // on a path SEGMENT, not a string prefix.
    expect(mayOpen("technician", "/dashboard/jobs-report")).toBe(false);
    expect(mayOpen("technician", "/dashboard/my-jobs-archive")).toBe(false);
  });

  it("refuses the bare dashboard, which is an office KPI screen", () => {
    expect(mayOpen("technician", "/dashboard")).toBe(false);
  });
});

describe("the sidebar and the middleware cannot drift apart", () => {
  // The whole point of extracting this module. If someone re-adds a local list
  // to either consumer, the two stop agreeing about what a technician may open
  // and the redirect starts contradicting the navigation.
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("both import the shared rule rather than defining their own", () => {
    expect(read("components/app-sidebar.tsx")).toContain('from "@/lib/nav-items"');
    expect(read("middleware.ts")).toContain('from "@/lib/nav-items"');
  });

  it("middleware still gates /dashboard and still redirects somewhere a technician can go", () => {
    const src = read("middleware.ts");
    expect(src).toMatch(/mayOpen\(/);
    const target = src.match(/url\.pathname = "([^"]+)"/)?.[1];
    expect(target).toBeDefined();
    expect(mayOpen("technician", target!)).toBe(true);
  });
});
