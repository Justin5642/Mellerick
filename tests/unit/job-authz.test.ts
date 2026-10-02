import { describe, it, expect } from "vitest";
import { isOfficeOrAdmin, canManageJobBilling, canManageTimeEntryBilling } from "@/lib/api/job-authz";
import { mockClient } from "@/tests/helpers/supabase-mock";
import type { SupabaseClient } from "@supabase/supabase-js";

// Detroit-ish: exercise the real per-record authorization logic against a
// lightweight in-memory Supabase stub. These rules gate service-role financial
// writes, so their correctness matters as much as the pricing math.

function client(tables: Record<string, { data?: unknown }>) {
  return mockClient(tables) as unknown as SupabaseClient;
}

describe("isOfficeOrAdmin", () => {
  it("is true for admin and office, false for technician/unknown", async () => {
    expect(await isOfficeOrAdmin(client({ profiles: { data: { role: "admin" } } }), "u")).toBe(true);
    expect(await isOfficeOrAdmin(client({ profiles: { data: { role: "office" } } }), "u")).toBe(true);
    expect(await isOfficeOrAdmin(client({ profiles: { data: { role: "technician" } } }), "u")).toBe(false);
    expect(await isOfficeOrAdmin(client({ profiles: { data: null } }), "u")).toBe(false);
  });
});

describe("canManageJobBilling", () => {
  it("allows office/admin on any job", async () => {
    const c = client({ profiles: { data: { role: "office" } }, job_assignments: { data: null } });
    expect(await canManageJobBilling(c, "u1", "job1")).toBe(true);
  });

  it("allows a technician who is the job's (sole) assignee", async () => {
    const own = client({ profiles: { data: { role: "technician" } }, job_assignments: { data: { staff_id: "u1" } } });
    expect(await canManageJobBilling(own, "u1", "job1")).toBe(true);

    const other = client({ profiles: { data: { role: "technician" } }, job_assignments: { data: null } });
    expect(await canManageJobBilling(other, "u1", "job1")).toBe(false);
  });

  // The point of migration 0059: a crew job has more than one assignee, and
  // billing self-heal must not be limited to whichever one jobs.assigned_to
  // happens to report as "primary".
  it("allows a technician who is a SECONDARY assignee, not just the primary", async () => {
    const secondary = client({
      profiles: { data: { role: "technician" } },
      job_assignments: { data: { staff_id: "u1" } }, // the row matching THIS user, regardless of who's primary
    });
    expect(await canManageJobBilling(secondary, "u1", "job1")).toBe(true);
  });

  it("denies a technician when they have no assignment row for the job", async () => {
    const c = client({ profiles: { data: { role: "technician" } }, job_assignments: { data: null } });
    expect(await canManageJobBilling(c, "u1", "missing")).toBe(false);
  });
});

describe("canManageTimeEntryBilling", () => {
  it("reports not-found (allowed:false, jobId:null) for an unknown entry", async () => {
    const c = client({ time_entries: { data: null } });
    expect(await canManageTimeEntryBilling(c, "u1", "missing")).toEqual({ allowed: false, jobId: null });
  });

  it("resolves the entry's job then applies the job rule for a technician", async () => {
    const own = client({
      time_entries: { data: { job_id: "job1" } },
      profiles: { data: { role: "technician" } },
      job_assignments: { data: { staff_id: "u1" } },
    });
    expect(await canManageTimeEntryBilling(own, "u1", "te1")).toEqual({ allowed: true, jobId: "job1" });

    const other = client({
      time_entries: { data: { job_id: "job1" } },
      profiles: { data: { role: "technician" } },
      job_assignments: { data: null },
    });
    expect(await canManageTimeEntryBilling(other, "u1", "te1")).toEqual({ allowed: false, jobId: "job1" });
  });
});
