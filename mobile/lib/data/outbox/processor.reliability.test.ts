import { Processor } from "./processor";
import { Outbox, MAX_ATTEMPTS, type Clock } from "./outbox";
import { InMemoryOutboxStore } from "./store";
import { TransientSyncError } from "./errors";
import type { SupabaseGateway, ApiBridge } from "../gateway";
import type { Connectivity } from "../net/connectivity";
import type { WriteOperation } from "./types";

// The processor's half of two audit findings: it CLASSIFIES each failure
// (transient vs rejection) for the outbox, and it adopts pre-ownership
// operations before selecting any.

function steppingClock(): Clock & { advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
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
const online: Connectivity = { isOnline: async () => true, onOnline: () => () => {} };
function write(id: string, o: Partial<WriteOperation> = {}): WriteOperation {
  return { kind: "write", id, rowId: id, aggregate: "time_entry", op: "insert", table: "time_entries", payload: {}, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 0, ...o };
}

async function failRepeatedly(error: Error, times: number) {
  const clock = steppingClock();
  const store = new InMemoryOutboxStore();
  const outbox = new Outbox(store, clock);
  await outbox.enqueue(write("a"));
  const gw = makeGateway();
  gw.insertRow.mockRejectedValue(error);
  const proc = new Processor(outbox, gw, makeApi(), online);
  for (let i = 0; i < times; i++) {
    await proc.drain();
    clock.advance(10 * 60 * 1000); // past any backoff
  }
  return { outbox, store };
}

describe("Processor — failure classification", () => {
  it("a long run of NETWORK failures never dead-letters the write", async () => {
    const { outbox, store } = await failRepeatedly(new Error("TypeError: Network request failed"), MAX_ATTEMPTS * 2);
    expect(await outbox.deadCount()).toBe(0);
    expect((await store.all())[0].attempts).toBe(0);
  });

  it("a gateway TransientSyncError (status 0 / 5xx) is not counted either", async () => {
    const { outbox } = await failRepeatedly(new TransientSyncError("time_entries insert: 503"), MAX_ATTEMPTS * 2);
    expect(await outbox.deadCount()).toBe(0);
  });

  it("a REJECTION still dead-letters after MAX_ATTEMPTS (negative control)", async () => {
    const { outbox } = await failRepeatedly(new Error("time_entries insert: new row violates row-level security policy"), MAX_ATTEMPTS);
    expect(await outbox.deadCount()).toBe(1);
  });
});

describe("Processor — ownership", () => {
  it("adopts operations queued by the previous build, then drains them for the signed-in user", async () => {
    const store = new InMemoryOutboxStore();
    await store.insert(write("legacy")); // no userId — written before ownership existed
    const outbox = new Outbox(store, steppingClock(), undefined, () => "alice");
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online).drain();
    expect(gw.insertRow).toHaveBeenCalledTimes(1);
    expect((await store.all())[0]).toEqual(expect.objectContaining({ userId: "alice", status: "done" }));
  });

  it("leaves another user's queued work alone", async () => {
    const store = new InMemoryOutboxStore();
    await store.insert(write("bobs", { userId: "bob" }));
    const outbox = new Outbox(store, steppingClock(), undefined, () => "alice");
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online).drain();
    expect(gw.insertRow).not.toHaveBeenCalled();
    expect((await store.all())[0].status).toBe("pending");
  });
});
