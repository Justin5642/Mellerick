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
    upsertRow: jest.fn().mockResolvedValue(undefined),
    updateRow: jest.fn().mockResolvedValue(undefined),
    deleteRow: jest.fn().mockResolvedValue(undefined),
    uploadObject: jest.fn().mockResolvedValue(undefined),
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

describe("createDataLayer (end-to-end offline → reconnect)", () => {
  it("queues an offline clock-in and never touches the gateway while offline", async () => {
    const net = controllableNet(); // starts offline
    const gw = makeGateway();
    const layer = createDataLayer({ store: new InMemoryOutboxStore(), gateway: gw, api: makeApi(), connectivity: net.connectivity, ids: seqIds() });
    layer.engine.start();

    await layer.timeEntries.clockIn({ jobId: "j1", staffId: "s1" });
    await layer.engine.flush(); // offline → no-op

    expect(gw.upsertRow).not.toHaveBeenCalled();
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
    expect(gw.upsertRow).not.toHaveBeenCalled();

    net.reconnect(); // engine's onOnline fires a drain
    await flushMicrotasks();

    expect(gw.upsertRow).toHaveBeenCalledWith("time_entries", expect.objectContaining({ id: rowId, job_id: "j1", staff_id: "s1" }));
    expect(api.callSideEffect).toHaveBeenCalledWith("sync-billing", { entryId: rowId });
    expect(await layer.outbox.pendingCount()).toBe(0); // fully drained
  });
});

// Let the fire-and-forget drain kicked by reconnect() settle.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
