import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, deleteUser, adminClient, type Role } from "./helpers";

// Regression cover for the 0027/0028 financial-table restrictions: technicians
// must not read the priced tables.
//
// WHY THIS FILE WAS REWRITTEN. It used to be:
//
//     const { data } = await users.technician!.client.from(table).select("id");
//     expect(data ?? []).toHaveLength(0);
//
// against tables it never seeded. Every one of them was EMPTY, so the assertion
// was trivially true — it passed identically with the policies in place, with
// them deleted, and against a database where the table did not exist. It was
// green throughout the period in which two money leaks were live in production.
//
// supabase/tests/money_boundary_sweep.sql:37-40 states the rule this now
// follows: "an empty table proves nothing here." The distinction that matters:
//
//     readable, 0 rows   -- the grant exists but RLS returns nothing. SAFE.
//     READABLE WITH DATA -- a leak
//
// and you cannot tell those apart without data. So every negative assertion here
// is paired with a POSITIVE CONTROL proving the row exists and is visible to
// somebody. If a policy is too tight, or the fixture silently fails to load, the
// positive control goes red instead of the suite going quietly green.

const users: Partial<Record<Role, { client: SupabaseClient; id: string }>> = {};

const RESTRICTED_TABLES = ["invoices", "quotes", "pricing_items", "job_items"] as const;

// Seeded by supabase/ci/seed-roles.sql, and assigned to the CI technician so the
// technician legitimately reads the JOB while the money hanging off it is still
// refused. A fixture where they cannot see the job at all would make these pass
// for the wrong reason.
const SEEDED_JOB = "cccccccc-0000-0000-0000-000000000001";

beforeAll(async () => {
  assertLocalStack();
  users.office = await makeUser("office", "rls-fin-office@test.local");
  users.technician = await makeUser("technician", "rls-fin-tech@test.local");
});

afterAll(async () => {
  for (const u of Object.values(users)) if (u) await deleteUser(u.id);
});

describe("the fixture itself", () => {
  // If this fails, every assertion below is meaningless — and would otherwise
  // pass. Its absence is what made the previous version of this file worthless.
  it("has money rows to hide, seeded and visible to the service role", async () => {
    const admin = adminClient();
    for (const table of RESTRICTED_TABLES) {
      const { data, error } = await admin.from(table).select("id");
      expect(error, `${table} unreadable even as the service role`).toBeNull();
      expect(
        (data ?? []).length,
        `${table} is EMPTY — a technician reading 0 rows from it proves nothing`
      ).toBeGreaterThan(0);
    }
  });
});

describe("financial tables are office/admin-only for SELECT (migrations 0027/0028)", () => {
  for (const table of RESTRICTED_TABLES) {
    it(`${table}: a technician reads no rows, though rows exist`, async () => {
      const { data } = await users.technician!.client.from(table).select("id");
      expect(data ?? []).toHaveLength(0);
    });

    // THE POSITIVE CONTROL. Without it, "technician sees 0" is equally satisfied
    // by a broken policy, an empty table, a dropped table, or a failed fixture.
    it(`${table}: office DOES read them, so the zero above means RLS and not absence`, async () => {
      const { data, error } = await users.office!.client.from(table).select("id");
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });
  }
});

describe("time_entries — the one money-bearing table a technician may read", () => {
  // 0045 revoked table-level SELECT and re-granted every column except
  // rate_override, because a technician legitimately sees their OWN entries
  // here. The column grant is therefore the only thing protecting the value.
  it("a technician can read their own entry", async () => {
    const { error } = await users.technician!.client
      .from("time_entries")
      .select("id, job_id, clock_in")
      .eq("job_id", SEEDED_JOB);
    expect(error).toBeNull();
  });

  it("a technician CANNOT read rate_override, even on their own entry", async () => {
    const { data, error } = await users.technician!.client
      .from("time_entries")
      .select("id, rate_override")
      .eq("job_id", SEEDED_JOB);

    // A column-level revoke makes the whole statement fail rather than returning
    // the column as null — which is precisely why 0045 chose a revoke over a
    // view, and why it cannot be bypassed by querying the base table.
    expect(error, "rate_override was READABLE by a technician").not.toBeNull();
    expect(data).toBeNull();
  });

  it("SELECT * is refused for authenticated, which is why the app must name columns", async () => {
    // The production outage of 4 Aug 2026: `*` expands to every column including
    // the revoked one, so the statement is refused outright and the web app's
    // clock-in silently recorded nothing. Pinned here so nobody "fixes" 0045 by
    // re-granting the table.
    const { error } = await users.technician!.client.from("time_entries").select("*");
    expect(error).not.toBeNull();
  });
});
