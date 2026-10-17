import { TransientSyncError, isTransientFailure, isTransientStatus, syncError } from "./errors";
import { RequestTimeoutError } from "../../fetchWithTimeout";

// Which failures may spend an operation's dead-letter budget. Getting this
// wrong in the "transient" direction makes a poison write retry forever;
// getting it wrong the other way dead-letters good work in a dead zone — the
// bug being fixed. Both directions are pinned.

describe("isTransientStatus", () => {
  it.each([0, 408, 429, 500, 502, 503, 504])("%i is transient", (status) => {
    expect(isTransientStatus(status)).toBe(true);
  });
  it.each([400, 401, 403, 404, 409, 422])("%i is a rejection", (status) => {
    expect(isTransientStatus(status)).toBe(false);
  });
  it("an unknown status is a rejection — when in doubt, count it", () => {
    expect(isTransientStatus(undefined)).toBe(false);
    expect(isTransientStatus(null)).toBe(false);
  });
});

describe("isTransientFailure", () => {
  it.each([
    new Error("TypeError: Network request failed"),
    new Error("Failed to fetch"),
    new Error("sync-billing: timed out after 30000ms"),
    new RequestTimeoutError(30_000),
    new TransientSyncError("anything"),
    Object.assign(new Error("Aborted"), { name: "AbortError" }),
  ])("%s is transient", (e) => {
    expect(isTransientFailure(e)).toBe(true);
  });

  it.each([
    new Error("time_entries insert: new row violates row-level security policy for table \"time_entries\""),
    new Error("inventory insert: duplicate key value violates unique constraint \"inventory_sku_key\""),
    new Error("time_entries update affected no rows (id x) — the row is missing or RLS denied it."),
    new Error("sync-billing: HTTP 404"),
  ])("%s is a rejection", (e) => {
    expect(isTransientFailure(e)).toBe(false);
  });
});

describe("syncError", () => {
  it("builds a TransientSyncError for a transient status and a plain Error otherwise", () => {
    expect(syncError("x", 0)).toBeInstanceOf(TransientSyncError);
    expect(syncError("x", 503)).toBeInstanceOf(TransientSyncError);
    expect(syncError("x", 403)).not.toBeInstanceOf(TransientSyncError);
    expect(syncError("x")).not.toBeInstanceOf(TransientSyncError);
  });
});
