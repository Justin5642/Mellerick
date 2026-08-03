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
function fakeAdmin(failures: Record<string, string> = {}) {
  const make = (table: string) => {
    const result: Result = failures[table]
      ? { data: null, error: { message: failures[table] } }
      : { data: [], error: null };

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
