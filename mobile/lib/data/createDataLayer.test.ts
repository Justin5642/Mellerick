import { createDataLayer } from "./createDataLayer";
import { InMemoryOutboxStore } from "./outbox/store";
import type { SupabaseGateway, ApiBridge } from "./gateway";
import type { Connectivity } from "./net/connectivity";
import type { IdGen } from "./ids";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
function makeGateway(): jest.Mocked<SupabaseGateway> {
  return {
    insertRow: jest.fn().mockResolvedValue(undefined),
    updateRow: jest.fn().mockResolvedValue(undefined),
    deleteRow: jest.fn().mockResolvedValue(undefined),
    uploadObject: jest.fn().mockResolvedValue(undefined),
    removeObject: jest.fn().mockResolvedValue(undefined),
    cleanupAttachment: jest.fn().mockResolvedValue(undefined),
    listStagedAttachments: jest.fn().mockResolvedValue([]),
  };
}
const makeApi = (): jest.Mocked<ApiBridge> => ({ callSideEffect: jest.fn().mockResolvedValue(undefined) });

// Toggleable connectivity: a test flips `online` and fires reconnection.
function controllableNet() {
  let online = false;
  let cb: (() => void) | undefined;
  const connectivity: Connectivity = {
    isOnline: async () => online,
    onOnline: (fn) => {
      cb = fn;
      return () => {};
    },
  };
  return {
    connectivity,
    reconnect: () => {
      online = true;
      cb?.();
    },
    setOnline: (v: boolean) => (online = v),
  };
}

// Controllable clock so a test can jump past a failed op's exponential backoff
// and force a retry drain.
function controllableClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createDataLayer (end-to-end offline → reconnect)", () => {
  it("queues an offline clock-in and never touches the gateway while offline", async () => {
    const net = controllableNet(); // starts offline
    const gw = makeGateway();
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api: makeApi(), connectivity: net.connectivity, ids: seqIds() });
    layer.engine.start();

    await layer.timeEntries.clockIn({ jobId: "j1", staffId: "s1" });
    await layer.engine.flush(); // offline → no-op

    expect(gw.insertRow).not.toHaveBeenCalled();
    // one write + one billing side-effect are queued and outstanding
    expect(await layer.outbox.pendingCount()).toBe(2);
  });

  it("flushes the queued clock-in through every layer to the gateway on reconnect", async () => {
    const net = controllableNet();
    const gw = makeGateway();
    const api = makeApi();
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api, connectivity: net.connectivity, ids: seqIds() });
    layer.engine.start();

    const rowId = await layer.timeEntries.clockIn({ jobId: "j1", staffId: "s1" });
    await layer.engine.flush(); // still offline
    expect(gw.insertRow).not.toHaveBeenCalled();

    net.reconnect(); // engine's onOnline fires a drain
    await flushMicrotasks();

    expect(gw.insertRow).toHaveBeenCalledWith("time_entries", expect.objectContaining({ id: rowId, job_id: "j1", staff_id: "s1" }));
    expect(api.callSideEffect).toHaveBeenCalledWith("sync-billing", { entryId: rowId });
    expect(await layer.outbox.pendingCount()).toBe(0); // fully drained
  });

  it("flushes an offline photo through upload-before-row-then-cleanup on reconnect", async () => {
    const net = controllableNet();
    const gw = makeGateway();
    const order: string[] = [];
    gw.uploadObject.mockImplementation(async () => void order.push("upload"));
    gw.insertRow.mockImplementation(async () => void order.push("insert"));
    gw.cleanupAttachment.mockImplementation(async () => void order.push("cleanup"));
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api: makeApi(), connectivity: net.connectivity, ids: seqIds() });
    layer.engine.start();

    const { id, storagePath } = await layer.photos.add({ jobId: "j1", uploadedBy: "u1", photoType: "before", localUri: "file:///doc/outbox/x.jpg" });
    await layer.engine.flush(); // offline
    expect(gw.uploadObject).not.toHaveBeenCalled();

    net.reconnect();
    await flushMicrotasks();

    expect(order).toEqual(["upload", "insert", "cleanup"]); // strict ordering end-to-end
    expect(gw.uploadObject).toHaveBeenCalledWith("job-photos", storagePath, "file:///doc/outbox/x.jpg");
    expect(gw.insertRow).toHaveBeenCalledWith("job_photos", { id, storage_path: storagePath, job_id: "j1", uploaded_by: "u1", photo_type: "before" });
    expect(await layer.outbox.pendingCount()).toBe(0);
  });

  // D69 CRITICAL regression, exercised through the WHOLE stack (repo → outbox →
  // processor → gateway), not just the outbox unit test: an offline clock-in then
  // clock-out of the same entry, where the insert transiently fails on reconnect.
  // Without the update-before-insert guard the clock-out would run against a row
  // that doesn't exist (a 0-row no-op marked done) and the worked hours would be
  // silently lost. The guard must make the clock-out wait for the insert.
  it("never loses a clock-out when the clock-in insert transiently fails on reconnect (D69, end-to-end)", async () => {
    const net = controllableNet();
    const gw = makeGateway();
    const clock = controllableClock();
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api: makeApi(), connectivity: net.connectivity, ids: seqIds(), clock });
    layer.engine.start();

    const rowId = await layer.timeEntries.clockIn({ jobId: "j1", staffId: "s1" });
    await layer.timeEntries.clockOut({ entryId: rowId, clockInIso: "2026-07-27T00:00:00.000Z" });

    gw.insertRow.mockRejectedValueOnce(new Error("transient 500")); // insert fails first try
    net.reconnect();
    await flushMicrotasks();
    expect(gw.updateRow).not.toHaveBeenCalled(); // THE FIX: no 0-row clock-out on the missing row

    clock.advance(10_000); // past the insert's backoff
    await layer.engine.flush();
    await flushMicrotasks();

    expect(gw.insertRow).toHaveBeenCalledWith("time_entries", expect.objectContaining({ id: rowId, job_id: "j1" }));
    expect(gw.updateRow).toHaveBeenCalledWith("time_entries", rowId, expect.objectContaining({ clock_out: expect.any(String) }));
    expect(await layer.outbox.pendingCount()).toBe(0); // fully drained, hours preserved
  });

  it("retries a transiently-failed write without dropping or duplicating it (idempotent, end-to-end)", async () => {
    const net = controllableNet();
    const gw = makeGateway();
    const clock = controllableClock();
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api: makeApi(), connectivity: net.connectivity, ids: seqIds(), clock });
    layer.engine.start();

    const rowId = await layer.timeEntries.clockIn({ jobId: "j1", staffId: "s1" });
    gw.insertRow.mockRejectedValueOnce(new Error("transient"));
    net.reconnect();
    await flushMicrotasks();
    expect(await layer.outbox.pendingCount()).toBeGreaterThan(0); // failed once, still queued

    clock.advance(10_000);
    await layer.engine.flush();
    await flushMicrotasks();

    // Every insert attempt targets the SAME client id, and the gateway treats a
    // duplicate key as success, so a retry can't create a duplicate row — nor
    // overwrite server-side edits made between the attempts (Q2).
    const inserts = gw.insertRow.mock.calls.filter(([t]) => t === "time_entries");
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    expect(inserts.every(([, row]) => (row as { id: string }).id === rowId)).toBe(true);
    expect(await layer.outbox.pendingCount()).toBe(0);
  });

  it("keeps the local file and does not write the row when a photo upload fails (end-to-end)", async () => {
    const net = controllableNet();
    const gw = makeGateway();
    const clock = controllableClock();
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api: makeApi(), connectivity: net.connectivity, ids: seqIds(), clock });
    layer.engine.start();

    const { id } = await layer.photos.add({ jobId: "j1", uploadedBy: "u1", photoType: "before", localUri: "file:///doc/outbox/x.jpg" });
    gw.uploadObject.mockRejectedValueOnce(new Error("storage 500"));
    net.reconnect();
    await flushMicrotasks();

    // Upload failed → the metadata row must NOT be written (no orphan pointing at a
    // missing object), and the local file must NOT be cleaned up (kept for retry).
    expect(gw.insertRow).not.toHaveBeenCalled();
    expect(gw.cleanupAttachment).not.toHaveBeenCalled();

    clock.advance(10_000);
    await layer.engine.flush();
    await flushMicrotasks();

    expect(gw.uploadObject).toHaveBeenCalledTimes(2); // failed, then succeeded
    expect(gw.insertRow).toHaveBeenCalledWith("job_photos", expect.objectContaining({ id }));
    expect(gw.cleanupAttachment).toHaveBeenCalledTimes(1); // file dropped only after success
    expect(await layer.outbox.pendingCount()).toBe(0);
  });
});

// Let the fire-and-forget drain kicked by reconnect() settle.
// Lets fire-and-forget drains settle. The count is a budget, not a contract:
// a drain awaits once per queued operation plus its end-of-pass housekeeping
// (pruneCompleted, reclaimOrphanAttachments), so the ceiling has to sit well
// above the longest chain any test here builds. It was 20, which the
// housekeeping pushed past — tests then failed on a retry that had not been
// given room to run, rather than on anything the product did wrong.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}
