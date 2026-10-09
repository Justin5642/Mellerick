// PowerSyncProvider's connect/disconnect transitions, driven with fakes. The
// provider imports the native PowerSync module, so its logic lives in
// powersyncTransition.ts precisely so these can run.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import type { LocalReads, LocalRole } from "./reads/source";
import { runTransition, type TransitionDeps, type TransitionState } from "./powersyncTransition";
import type { SyncMarker } from "./syncMarker";

interface Fake extends TransitionDeps {
  log: string[];
  marker: SyncMarker | null;
  seam: (LocalReads & { assumed: boolean }) | null;
  releaseSync: () => void;
}

function fake(marker: SyncMarker | null, opts: { firstSyncPending?: boolean } = {}): Fake {
  let release: () => void = () => {};
  const f: Fake = {
    log: [],
    marker,
    seam: null,
    releaseSync: () => release(),
    connect: async () => {
      f.log.push("connect");
    },
    disconnectAndClear: async () => {
      f.log.push(`wipe(marker=${f.marker ? "present" : "cleared"})`);
    },
    waitForFirstSync: () =>
      opts.firstSyncPending ? new Promise<void>((r) => (release = r)) : Promise.resolve(),
    makeLocalReads: (role: () => LocalRole, o?: { assumeSynced?: boolean }) =>
      ({
        hasSynced: () => o?.assumeSynced === true,
        role,
        getAll: async () => [],
        getOptional: async () => null,
        assumed: o?.assumeSynced === true,
      }) as LocalReads & { assumed: boolean },
    setLocalReads: (db) => {
      f.seam = db as Fake["seam"];
      f.log.push(db ? `seam(${(db as Fake["seam"])!.assumed ? "provisional" : "confirmed"},${db.role()})` : "seam(null)");
    },
    readMarker: async () => f.marker,
    writeMarker: async (m) => {
      f.marker = m;
      f.log.push(`marker(${m.userId},${m.role})`);
    },
    clearMarker: async () => {
      f.marker = null;
      f.log.push("clearMarker");
    },
  };
  return f;
}

const fresh = (): TransitionState => ({ connected: null, synced: null, trusted: null });
const tick = () => new Promise((r) => setImmediate(r));

describe("cold start with a persisted full-sync marker", () => {
  it("serves local reads BEFORE the first sync of this connection completes", async () => {
    const f = fake({ userId: "u1", role: "technician" }, { firstSyncPending: true });
    const done = runTransition(f, fresh(), { userId: "u1", role: "technician" }, () => true);
    await tick();
    // The provisional seam is live while waitForFirstSync is still pending —
    // My Jobs' first render reads the mirror, offline included.
    expect(f.seam?.assumed).toBe(true);
    expect(f.seam?.hasSynced()).toBe(true);
    expect(f.seam?.role()).toBe("technician");
    expect(f.log).toEqual(["seam(null)", "seam(provisional,technician)", "connect"]);

    f.releaseSync();
    await done;
    expect(f.seam?.assumed).toBe(false); // replaced by the confirmed seam
    expect(f.log.slice(-2)).toEqual(["seam(confirmed,technician)", "marker(u1,technician)"]);
  });

  it("keeps the first-ever-sync behaviour when there is no marker", async () => {
    const f = fake(null, { firstSyncPending: true });
    const done = runTransition(f, fresh(), { userId: "u1", role: "technician" }, () => true);
    await tick();
    expect(f.seam).toBeNull(); // nothing local until the sync lands
    f.releaseSync();
    await done;
    expect(f.seam?.assumed).toBe(false);
    expect(f.marker).toEqual({ userId: "u1", role: "technician" }); // next cold start is fast
  });

  it("wipes a mirror the marker attributes to a different role, clearing the marker FIRST", async () => {
    const f = fake({ userId: "u1", role: "office" }, { firstSyncPending: true });
    void runTransition(f, fresh(), { userId: "u1", role: "technician" }, () => true);
    await tick();
    expect(f.seam).toBeNull();
    expect(f.log).toEqual(["seam(null)", "clearMarker", "wipe(marker=cleared)", "connect"]);
  });

  it("wipes a mirror the marker attributes to a different user", async () => {
    const f = fake({ userId: "u2", role: "technician" }, { firstSyncPending: true });
    void runTransition(f, fresh(), { userId: "u1", role: "technician" }, () => true);
    await tick();
    expect(f.seam).toBeNull();
    expect(f.log).toContain("wipe(marker=cleared)");
  });

  it("does not register any seam for a superseded transition", async () => {
    const f = fake({ userId: "u1", role: "technician" });
    await runTransition(f, fresh(), { userId: "u1", role: "technician" }, () => false);
    expect(f.seam).toBeNull();
    expect(f.marker).toEqual({ userId: "u1", role: "technician" }); // untouched, not re-written
    expect(f.log).not.toContain("marker(u1,technician)");
  });

  it("re-registers the provisional seam on the next transition if the first was superseded", async () => {
    const f = fake({ userId: "u1", role: "technician" }, { firstSyncPending: true });
    const state = fresh();
    let current = false;
    void runTransition(f, state, { userId: "u1", role: "technician" }, () => current);
    await tick();
    expect(f.seam).toBeNull();
    current = true;
    void runTransition(f, state, { userId: "u1", role: "technician" }, () => current);
    await tick();
    expect(f.seam?.assumed).toBe(true);
    expect(f.log.filter((l) => l === "connect")).toHaveLength(1); // no reconnect, no wipe
  });
});

describe("in-session changes", () => {
  it("a role change wipes the mirror and clears the marker before reconnecting", async () => {
    const f = fake(null);
    const state = fresh();
    await runTransition(f, state, { userId: "u1", role: "office" }, () => true);
    expect(f.marker).toEqual({ userId: "u1", role: "office" });
    f.log.length = 0;
    await runTransition(f, state, { userId: "u1", role: "technician" }, () => true);
    expect(f.log.slice(0, 3)).toEqual(["seam(null)", "clearMarker", "wipe(marker=cleared)"]);
    expect(f.marker).toEqual({ userId: "u1", role: "technician" });
  });

  it("sign-out (or deactivation → no role) wipes and clears the marker", async () => {
    const f = fake(null);
    const state = fresh();
    await runTransition(f, state, { userId: "u1", role: "technician" }, () => true);
    await runTransition(f, state, { userId: null, role: null }, () => true);
    expect(f.seam).toBeNull();
    expect(f.marker).toBeNull();
    expect(f.log.slice(-3)).toEqual(["seam(null)", "clearMarker", "wipe(marker=cleared)"]);
  });

  it("a cold start with no session does NOT clear the marker (auth may still be loading)", async () => {
    const f = fake({ userId: "u1", role: "technician" });
    await runTransition(f, fresh(), { userId: null, role: null }, () => true);
    expect(f.marker).toEqual({ userId: "u1", role: "technician" });
    expect(f.log).toEqual([]);
  });

  it("a repeat transition for an already-synced identity is a no-op", async () => {
    const f = fake(null);
    const state = fresh();
    await runTransition(f, state, { userId: "u1", role: "admin" }, () => true);
    f.log.length = 0;
    await runTransition(f, state, { userId: "u1", role: "admin" }, () => true);
    expect(f.log).toEqual([]);
  });
});
