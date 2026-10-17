import { runSignOut, unsyncedWarning, type SignOutFlowDeps } from "./signOutFlow";
import type { DataLayer } from "./data/createDataLayer";

// Sign-out used to abandon unsynced work silently and leave the queue for the
// next person to replay. Now it says what would be lost, and only a confirmed
// sign-out discards it.

function fakeLayer(unsynced: number) {
  const log: string[] = [];
  const layer = {
    outbox: { unsyncedCountFor: jest.fn().mockResolvedValue(unsynced) },
    engine: { stop: jest.fn(() => log.push("engine.stop")), start: jest.fn(() => log.push("engine.start")) },
    clearLocalWorkFor: jest.fn(async (id: string) => void log.push(`clear(${id})`)),
  };
  return { layer: layer as unknown as DataLayer, raw: layer, log };
}

function deps(over: Partial<SignOutFlowDeps> & { log: string[] }): SignOutFlowDeps {
  const { log } = over;
  return {
    userId: "alice",
    layer: null,
    confirm: jest.fn().mockResolvedValue(true),
    signOut: jest.fn(async () => void log.push("signOut")),
    countClockActions: jest.fn().mockResolvedValue(0),
    clearClockActions: jest.fn(async () => void log.push("clearClock")),
    ...over,
  };
}

describe("runSignOut", () => {
  it("signs straight out, without asking, when nothing is unsynced", async () => {
    const { layer, log } = fakeLayer(0);
    const d = deps({ layer, log });
    await expect(runSignOut(d)).resolves.toBe(true);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(log).toEqual(["engine.stop", "clear(alice)", "clearClock", "signOut", "engine.start"]);
  });

  it("WARNS with the count (outbox + queued clock events) before signing out", async () => {
    const { layer, log } = fakeLayer(3);
    const d = deps({ layer, log, countClockActions: jest.fn().mockResolvedValue(2) });
    await runSignOut(d);
    expect(d.confirm).toHaveBeenCalledWith(unsyncedWarning(5));
    expect(unsyncedWarning(5)).toMatch(/^5 items haven't synced/);
  });

  it("does NOTHING when the person chooses to stay signed in — the work is kept", async () => {
    const { layer, raw, log } = fakeLayer(2);
    const d = deps({ layer, log, confirm: jest.fn().mockResolvedValue(false) });
    await expect(runSignOut(d)).resolves.toBe(false);
    expect(raw.clearLocalWorkFor).not.toHaveBeenCalled();
    expect(d.signOut).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  it("asks when the count cannot be read — better a needless question than silent deletion", async () => {
    const { layer, raw, log } = fakeLayer(0);
    raw.outbox.unsyncedCountFor.mockRejectedValue(new Error("sqlite closed"));
    const d = deps({ layer, log, confirm: jest.fn().mockResolvedValue(false) });
    await runSignOut(d);
    expect(d.confirm).toHaveBeenCalled();
  });

  it("still signs out if clearing fails, and always restarts the engine", async () => {
    const { layer, raw, log } = fakeLayer(0);
    raw.clearLocalWorkFor.mockRejectedValue(new Error("boom"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps({ layer, log });
    await runSignOut(d);
    warn.mockRestore();
    expect(d.signOut).toHaveBeenCalled();
    expect(raw.engine.start).toHaveBeenCalled();
  });

  it("works before the data layer is ready", async () => {
    const log: string[] = [];
    const d = deps({ layer: null, log });
    await expect(runSignOut(d)).resolves.toBe(true);
    expect(log).toEqual(["clearClock", "signOut"]);
  });

  it("singular wording for one item", () => {
    expect(unsyncedWarning(1)).toMatch(/^1 item hasn't synced/);
  });
});
