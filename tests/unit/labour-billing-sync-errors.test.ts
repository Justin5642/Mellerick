import { describe, it, expect } from "vitest";
import { syncJobBilling } from "@/lib/labour-billing-sync";

// syncJobBilling recomputes every auto billing item on a job. It reads three
// tables up front and, until now, discarded the error on all three. Two of those
// silences change what a CUSTOMER IS CHARGED:
//
//   • billing_rate_config fails  -> rateConfigRow is null -> the code cannot
//     distinguish "no rate row configured" from "the read failed", so it falls
//     back to DEFAULT_LABOUR_RATE_CONFIG and a hardcoded $180 call-out. The job
//     silently re-prices at defaults. Nobody is told; the invoice looks normal.
//
//   • time_entries fails         -> entries is null -> billable is [] -> the
//     reconcile takes its delete path and removes the job's ENTIRE auto labour
//     billing. A transient network blip erases work that was actually done.
//
// The route calls this without a try/catch, so throwing surfaces as a 500 and
// the caller learns the reconcile did not happen — which is the honest outcome.
// Silently producing a WRONG invoice is the one thing it must not do.
//
// London-school: the Supabase client is the seam, faked here so each read can be
// failed independently without a database.

type Result = { data: unknown; error: { message: string } | null };

/**
 * Minimal Supabase-shaped fake. `failures` maps a table name to the error it
 * should return; every other table resolves empty-and-successful.
 */
function fakeAdmin(failures: Record<string, string> = {}, rows: Record<string, unknown[]> = {}) {
  const make = (table: string) => {
    const result: Result = failures[table]
      ? { data: null, error: { message: failures[table] } }
      : { data: rows[table] ?? [], error: null };

    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "delete", "insert", "update", "upsert"]) {
      builder[method] = () => builder;
    }
    // maybeSingle/single resolve to a single row rather than a list.
    builder.maybeSingle = () => Promise.resolve(failures[table] ? result : { data: null, error: null });
    builder.single = builder.maybeSingle;
    builder.then = (resolve: (v: Result) => unknown) => resolve(result);
    return builder;
  };
  return { from: (table: string) => make(table) } as never;
}

describe("syncJobBilling — a failed read must not silently change the price", () => {
  it("THROWS when billing_rate_config fails, rather than pricing the job at defaults", async () => {
    await expect(
      syncJobBilling(fakeAdmin({ billing_rate_config: "permission denied for table billing_rate_config" }), "job-1")
    ).rejects.toThrow(/billing_rate_config/);
  });

  it("THROWS when time_entries fails, rather than deleting the job's labour billing", async () => {
    // This is the destructive one: [] drives the reconcile down its delete path.
    await expect(
      syncJobBilling(fakeAdmin({ time_entries: "network error" }), "job-1")
    ).rejects.toThrow(/time_entries/);
  });

  // ---------------------------------------------------------------------
  // THE SECOND Promise.all — unreachable by every test above.
  //
  // syncJobBilling reads THREE tables up front and then, 50 lines later, reads
  // TWO more: staff_cost_profiles and equipment. The commit that added
  // requireRead() to the first three left the second pair untouched, and no test
  // noticed because the fixture could not get there: with time_entries resolving
  // to [], `billable` is empty, `staffIds.length === 0`, and the whole block is
  // skipped.
  //
  // So these need a billable entry. That is the entire reason this bug survived
  // a commit whose message was "two silent failures that changed what a customer
  // was charged".
  // ---------------------------------------------------------------------
  const BILLABLE_ENTRY = {
    id: "te-1",
    staff_id: "staff-1",
    clock_in: "2026-08-05T09:00:00.000Z",
    clock_out: "2026-08-05T12:00:00.000Z",
    entry_type: "work",
    rate_override: null,
  };

  function withBillableWork(failures: Record<string, string> = {}) {
    return fakeAdmin(failures, {
      time_entries: [BILLABLE_ENTRY],
      billing_rate_config: [],
      job_items: [],
    });
  }

  it("THROWS when staff_cost_profiles fails, rather than billing an apprentice at the qualified rate", async () => {
    // The consequence of the silence: profileByStaff stays empty, so tradeLevel
    // falls to "qualified" and staffChargeOutRate to null. An apprentice's hours
    // are then charged at rateConfig.qualifiedBaseRate instead of loaded cost
    // plus margin, and any staffer's per-person charge_out_rate is ignored. The
    // wrong unit_price reaches the customer with nothing logged.
    await expect(
      syncJobBilling(withBillableWork({ staff_cost_profiles: "permission denied" }), "job-1")
    ).rejects.toThrow(/staff_cost_profiles/);
  });

  it("THROWS when the equipment read fails, rather than costing the vehicle at zero", async () => {
    // vehicleCostByStaff stays empty, so an apprentice's loaded cost is computed
    // with vehicle_cost_per_hour = 0 and the job is UNDER-priced. Quieter than
    // the case above and just as wrong.
    await expect(
      syncJobBilling(withBillableWork({ equipment: "boom" }), "job-1")
    ).rejects.toThrow(/equipment/);
  });

  it("the fixture actually reaches that code — guards against this test rotting back", async () => {
    // If a refactor makes `billable` empty again, the two assertions above would
    // pass for the wrong reason: no read happens, so no read can fail. This
    // proves the path is live by failing a table only read INSIDE that block.
    let sawStaffCostProfiles = false;
    const spy = fakeAdmin({}, { time_entries: [BILLABLE_ENTRY] });
    const inner = (spy as unknown as { from: (t: string) => unknown }).from;
    (spy as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      if (t === "staff_cost_profiles") sawStaffCostProfiles = true;
      return inner(t);
    };
    await syncJobBilling(spy, "job-1").catch(() => {});
    expect(sawStaffCostProfiles, "staff_cost_profiles was never read — the fixture no longer reaches it").toBe(true);
  });

  it("THROWS when the existing job_items read fails", async () => {
    // Without this, existingAutoItems is [] and every item is treated as new —
    // duplicating the whole job's labour lines instead of updating them.
    await expect(
      syncJobBilling(fakeAdmin({ job_items: "boom" }), "job-1")
    ).rejects.toThrow(/job_items/);
  });

  it("names the failing table, because three reads share one call site", async () => {
    try {
      await syncJobBilling(fakeAdmin({ billing_rate_config: "boom" }), "job-1");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("syncJobBilling");
      expect((e as Error).message).toContain("billing_rate_config");
    }
  });

  it("still succeeds when every read works and there is simply nothing to bill", async () => {
    // A genuinely empty job must NOT throw — empty and failed have to stay
    // distinguishable, which is the entire point.
    await expect(syncJobBilling(fakeAdmin(), "job-1")).resolves.toBeDefined();
  });
});
