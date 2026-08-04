import { unwrap, unwrapRows, unwrapCount } from "./unwrap";

// The THIRD spelling of the same bug, found only because a converted module was
// re-read rather than trusted.
//
// A `select("*", { count: "exact", head: true })` query returns a count and NO
// data, so neither unwrap nor unwrapRows can express it. The reports dashboard
// read it as `jobCounts[i].count ?? 0` — meaning a failed per-status count
// rendered as "0 jobs in this status", which is a plausible-looking number on a
// management dashboard and wrong in exactly the way that gets believed.
describe("unwrapCount — a failed count is not zero", () => {
  it("returns the count on success", () => {
    expect(unwrapCount({ count: 7, error: null }, "countJobs")).toBe(7);
  });

  it("returns 0 when the query succeeded and genuinely matched nothing", () => {
    expect(unwrapCount({ count: 0, error: null }, "countJobs")).toBe(0);
  });

  it("treats a null count on a SUCCESSFUL query as 0", () => {
    expect(unwrapCount({ count: null, error: null }, "countJobs")).toBe(0);
  });

  // THE BUG. Previously this produced 0 and the dashboard displayed it.
  it("THROWS on error rather than reporting zero", () => {
    expect(() =>
      unwrapCount({ count: null, error: { message: "permission denied for table jobs", code: "42501" } }, "getReportSummary(jobCounts)")
    ).toThrow(/getReportSummary\(jobCounts\): permission denied/);
  });
});

// Every read module discarded the Supabase error and returned `data ?? []`, so a
// failed query rendered as an empty list. The Staff screen showed "No staff." on
// an admin account while jobs in the same session had staff assigned — the query
// was failing and nothing said so.
//
// The distinction these tests pin down is the whole point: an EMPTY result and a
// FAILED result must not look the same to a caller. A technician who sees "no
// jobs assigned" because a query failed goes home.

describe("unwrapRows", () => {
  it("returns rows on success", () => {
    expect(unwrapRows({ data: [{ id: "1" }], error: null }, "listX")).toEqual([{ id: "1" }]);
  });

  it("returns [] for a genuinely empty result — empty is not an error", () => {
    expect(unwrapRows({ data: [], error: null }, "listX")).toEqual([]);
  });

  it("returns [] when a successful query yields null rather than an array", () => {
    expect(unwrapRows({ data: null, error: null }, "listX")).toEqual([]);
  });

  // THE BUG. Previously this path returned [] and the screen showed its empty
  // state, which is a lie.
  it("THROWS on error instead of silently returning an empty list", () => {
    expect(() =>
      unwrapRows({ data: null, error: { message: 'column "nope" does not exist' } }, "listStaff")
    ).toThrow(/listStaff: column "nope" does not exist/);
  });

  it("names the calling function, because the Postgres message alone does not", () => {
    // "permission denied for table profiles" is useless across 28 read sites.
    try {
      unwrapRows({ data: null, error: { message: "permission denied for table profiles" } }, "listStaff");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("listStaff");
    }
  });

  it("carries code, details and hint through, since those are what identify the cause", () => {
    try {
      unwrapRows(
        {
          data: null,
          error: {
            message: "could not find a relationship",
            code: "PGRST200",
            details: "Searched for a foreign key between profiles and staff_cost_profiles",
            hint: "Verify the foreign key",
          },
        },
        "listStaff"
      );
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("PGRST200");
      expect(msg).toContain("foreign key between profiles and staff_cost_profiles");
      expect(msg).toContain("Verify the foreign key");
    }
  });
});

// PostgREST's .single() reports "no rows" as an ERROR (PGRST116), not as
// data:null. That makes "this job does not exist" indistinguishable from "this
// query is broken" unless we special-case it — and getting it wrong turns every
// legitimately-absent row into a thrown error and a red screen.
//
// This matters more than it looks: getJob() is reachable for a job the caller
// may not have (a technician opening a search result), where absent is a NORMAL
// answer the caller handles by falling through to the network.
describe("unwrap — PostgREST 'no rows' is absence, not failure", () => {
  it("returns null for PGRST116 instead of throwing", () => {
    expect(
      unwrap({ data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } }, "getJob")
    ).toBeNull();
  });

  it("still throws for every OTHER error code — absence is the only exemption", () => {
    expect(() =>
      unwrap({ data: null, error: { message: "permission denied", code: "42501" } }, "getJob")
    ).toThrow(/getJob: permission denied/);
  });

  it("does not treat a message that merely mentions rows as absence — the CODE decides", () => {
    // Guarding against a substring check: only the code PGRST116 means absence.
    expect(() =>
      unwrap({ data: null, error: { message: "no rows in relation jobs", code: "42P01" } }, "getJob")
    ).toThrow(/42P01/);
  });

  it("unwrapRows turns PGRST116 into [] rather than null", () => {
    expect(
      unwrapRows({ data: null, error: { message: "no rows", code: "PGRST116" } }, "listX")
    ).toEqual([]);
  });
});

describe("unwrap", () => {
  it("passes a single row through", () => {
    expect(unwrap({ data: { id: "1" }, error: null }, "getX")).toEqual({ id: "1" });
  });

  it("returns null for an absent row — the caller decides what missing means", () => {
    // maybeSingle() legitimately returns null. Only an ERROR is exceptional.
    expect(unwrap({ data: null, error: null }, "getX")).toBeNull();
  });

  it("throws on error", () => {
    expect(() => unwrap({ data: null, error: { message: "boom" } }, "getX")).toThrow(/getX: boom/);
  });
});
