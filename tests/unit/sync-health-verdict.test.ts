import { describe, it, expect } from "vitest";
// No @ts-expect-error here: allowJs resolves the .mjs and infers `verdict`, so
// suppressing would itself be an error (TS2578, "unused directive") — which is
// exactly how CI caught it.
import { verdict } from "../../scripts/check-sync-health.mjs";

// WHY THIS TEST EXISTS
//
// On 2026-08-04 PowerSync replication was dead for 24 hours and nothing
// reported it. `npm run check:sync` is the answer to that — but a health check
// is a peculiar kind of code: its HEALTHY path runs every time and proves
// itself, while its ALARM paths only ever run during an outage. That is the
// worst possible moment to discover a typo in the branch that was supposed to
// tell you about the outage.
//
// A monitor that fails silently is worse than no monitor, because it converts
// "nobody is looking" into "everybody believes it is fine". So the alarm paths
// get tested here, where they run on every commit.

describe("sync health verdict", () => {
  it("is healthy when a slot is active and its WAL is reserved", () => {
    expect(verdict([{ slot_name: "powersync_x", active: true, wal_status: "reserved" }])).toEqual({
      healthy: true,
      reason: "ok",
    });
  });

  it("is UNHEALTHY when no slot exists at all", () => {
    // Nothing replicating. Devices keep serving the snapshot they already hold.
    expect(verdict([])).toEqual({ healthy: false, reason: "no-slot" });
  });

  it("is UNHEALTHY when a slot exists but has no reader attached", () => {
    expect(verdict([{ slot_name: "powersync_x", active: false, wal_status: "reserved" }])).toEqual({
      healthy: false,
      reason: "no-reader",
    });
  });

  it("is UNHEALTHY when a slot has been invalidated — the actual 24-hour outage", () => {
    expect(verdict([{ slot_name: "powersync_x", active: false, wal_status: "lost" }])).toEqual({
      healthy: false,
      reason: "invalidated",
    });
  });

  // ORDERING MATTERS, and this is the case that justifies the test file.
  //
  // An invalidated slot is ALSO inactive, so a naive check reports it as
  // "no reader attached". That sends the reader hunting for a credential or
  // connection problem — which is exactly the wrong trail, and exactly the
  // trail that was followed for two password rotations before the dashboard
  // logs revealed `wal_removed`. Invalidation must win.
  it("reports invalidation, NOT 'no reader', when a slot is both lost and inactive", () => {
    expect(verdict([{ slot_name: "powersync_x", active: false, wal_status: "lost" }]).reason).toBe("invalidated");
  });

  it("reports the worst state when several slots disagree", () => {
    // A redeploy leaves the old slot behind; the new one may be healthy while
    // the old one is lost. Reporting "healthy" because one of them is fine
    // would hide a slot still pinning WAL.
    const slots = [
      { slot_name: "powersync_new", active: true, wal_status: "reserved" },
      { slot_name: "powersync_old", active: false, wal_status: "lost" },
    ];
    expect(verdict(slots)).toEqual({ healthy: false, reason: "invalidated" });
  });

  it("treats a non-array result as unhealthy rather than assuming the best", () => {
    // A parsing change upstream must never silently read as "all good".
    expect(verdict(undefined as never).healthy).toBe(false);
    expect(verdict(null as never).healthy).toBe(false);
  });
});
