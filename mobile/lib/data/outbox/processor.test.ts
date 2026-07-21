import { Processor } from "./processor";
import { Outbox, type Clock } from "./outbox";
import { InMemoryOutboxStore } from "./store";
import type { SupabaseGateway, ApiBridge } from "../gateway";
import type { Connectivity } from "../net/connectivity";
import type { WriteOperation, SideEffectOperation } from "./types";

function fixedClock(t = 1000): Clock {
  return { now: () => t };
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
const online = (v: boolean): Connectivity => ({ isOnline: async () => v, onOnline: () => () => {} });

function write(id: string, o: Partial<WriteOperation> = {}): WriteOperation {
  return { kind: "write", id, rowId: id, aggregate: "time_entry", op: "insert", table: "time_entries", payload: {}, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 0, ...o };
}
function side(id: string, key: string, o: Partial<SideEffectOperation> = {}): SideEffectOperation {
  return { kind: "side_effect", id, effect: "sync-billing", coalesceKey: key, payload: {}, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 0, ...o };
}

describe("Processor", () => {
  it("does nothing when offline (no gateway calls)", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("a"));
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(false)).drain();
    expect(gw.upsertRow).not.toHaveBeenCalled();
    expect(await outbox.pendingCount()).toBe(1); // still queued
  });

  it("replays an insert as an idempotent upsert keyed on the client id, then marks it done", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("te-1", { payload: { job_id: "j1", hours: 2 } }));
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.upsertRow).toHaveBeenCalledWith("time_entries", { id: "te-1", job_id: "j1", hours: 2 });
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("uploads an attachment BEFORE inserting its metadata row", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("photo-1", { aggregate: "job_photo", table: "job_photos", attachmentLocalPath: "/tmp/p.jpg", payload: { bucket: "job-photos", storage_path: "job/p.jpg" } })
    );
    const gw = makeGateway();
    const order: string[] = [];
    gw.uploadObject.mockImplementation(async () => void order.push("upload"));
    gw.upsertRow.mockImplementation(async () => void order.push("insert"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(order).toEqual(["upload", "insert"]);
    expect(gw.uploadObject).toHaveBeenCalledWith("job-photos", "job/p.jpg", "/tmp/p.jpg");
    // the internal `bucket` key is not written to the row
    expect(gw.upsertRow.mock.calls[0][1]).not.toHaveProperty("bucket");
  });

  it("fires a queued side-effect via the api bridge", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(side("s1", "sync-billing:j1", { payload: { entryId: "te-1" } }));
    const api = makeApi();
    await new Processor(outbox, makeGateway(), api, online(true)).drain();
    expect(api.callSideEffect).toHaveBeenCalledWith("sync-billing", { entryId: "te-1" });
  });

  it("processes a write BEFORE its dependent side-effect", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("te-1", { createdAt: 1 }));
    await outbox.enqueue(side("s1", "sync-billing:j1", { createdAt: 2, dependsOn: "te-1" }));
    const gw = makeGateway();
    const api = makeApi();
    const order: string[] = [];
    gw.upsertRow.mockImplementation(async () => void order.push("write"));
    api.callSideEffect.mockImplementation(async () => void order.push("sideeffect"));
    await new Processor(outbox, gw, api, online(true)).drain();
    expect(order).toEqual(["write", "sideeffect"]);
  });

  it("keeps BOTH an insert and a later update to the SAME row (distinct op ids, shared rowId)", async () => {
    // Regression: op id must be distinct from the target row id, or an offline
    // clock-in (insert) then clock-out (update) to the same row would collide
    // in the store and lose the insert.
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("op-ins", { rowId: "te-1", op: "insert", createdAt: 1, payload: { job_id: "j1" } }));
    await outbox.enqueue(write("op-upd", { rowId: "te-1", op: "update", createdAt: 2, payload: { clock_out: "12:00" } }));
    expect(await outbox.pendingCount()).toBe(2); // neither replaced the other
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.upsertRow).toHaveBeenCalledWith("time_entries", { id: "te-1", job_id: "j1" });
    expect(gw.updateRow).toHaveBeenCalledWith("time_entries", "te-1", { clock_out: "12:00" });
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("backs off a failed op (leaves it outstanding) without dropping it", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("a"));
    const gw = makeGateway();
    gw.upsertRow.mockRejectedValueOnce(new Error("network down"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(await outbox.failedCount()).toBe(1); // still there, backed off
  });
});
