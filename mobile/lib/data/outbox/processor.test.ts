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
    expect(gw.insertRow).not.toHaveBeenCalled();
    expect(await outbox.pendingCount()).toBe(1); // still queued
  });

  it("replays an insert as an idempotent upsert keyed on the client id, then marks it done", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("te-1", { payload: { job_id: "j1", hours: 2 } }));
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.insertRow).toHaveBeenCalledWith("time_entries", { id: "te-1", job_id: "j1", hours: 2 });
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
    gw.insertRow.mockImplementation(async () => void order.push("insert"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(order).toEqual(["upload", "insert"]);
    expect(gw.uploadObject).toHaveBeenCalledWith("job-photos", "job/p.jpg", "/tmp/p.jpg");
    // the internal `bucket` key is not written to the row
    expect(gw.insertRow.mock.calls[0][1]).not.toHaveProperty("bucket");
  });

  it("uploads a receipt attachment using a custom attachmentPathField and keeps that column on the row", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("exp-1", {
        aggregate: "job_expense",
        table: "job_expenses",
        attachmentLocalPath: "/tmp/r.jpg",
        attachmentPathField: "receipt_storage_path",
        payload: { bucket: "job-documents", receipt_storage_path: "j1/expense-exp-1.jpg", supplier_name: "Reece" },
      })
    );
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    // uploads to the receipt_storage_path value (NOT storage_path, which is absent)
    expect(gw.uploadObject).toHaveBeenCalledWith("job-documents", "j1/expense-exp-1.jpg", "/tmp/r.jpg");
    // the real receipt_storage_path column survives; only bucket is stripped
    expect(gw.insertRow).toHaveBeenCalledWith("job_expenses", {
      id: "exp-1",
      receipt_storage_path: "j1/expense-exp-1.jpg",
      supplier_name: "Reece",
    });
    expect(gw.insertRow.mock.calls[0][1]).not.toHaveProperty("bucket");
  });

  it("removes the receipt object on an expense delete via the custom attachmentPathField", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("del-e", {
        aggregate: "job_expense",
        table: "job_expenses",
        op: "delete",
        rowId: "exp-9",
        attachmentPathField: "receipt_storage_path",
        payload: { bucket: "job-documents", receipt_storage_path: "j1/expense-exp-9.jpg" },
      })
    );
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.removeObject).toHaveBeenCalledWith("job-documents", "j1/expense-exp-9.jpg");
    expect(gw.deleteRow).toHaveBeenCalledWith("job_expenses", "exp-9");
  });

  it("removes the Storage object before the row on a photo delete, then cleans up nothing (no attachment)", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("del-1", { aggregate: "job_photo", table: "job_photos", op: "delete", rowId: "photo-7", payload: { bucket: "job-photos", storage_path: "j1/photo-7.jpg" } })
    );
    const gw = makeGateway();
    const order: string[] = [];
    gw.removeObject.mockImplementation(async () => void order.push("removeObject"));
    gw.deleteRow.mockImplementation(async () => void order.push("deleteRow"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(order).toEqual(["removeObject", "deleteRow"]);
    expect(gw.removeObject).toHaveBeenCalledWith("job-photos", "j1/photo-7.jpg");
    expect(gw.deleteRow).toHaveBeenCalledWith("job_photos", "photo-7");
  });

  it("does NOT remove any Storage object on a delete without a storage_path (e.g. a time entry)", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("del-2", { op: "delete", rowId: "te-1" }));
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.removeObject).not.toHaveBeenCalled();
    expect(gw.deleteRow).toHaveBeenCalledWith("time_entries", "te-1");
  });

  it("cleans up the local attachment only AFTER a successful attachment write", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("photo-1", { aggregate: "job_photo", table: "job_photos", attachmentLocalPath: "/doc/outbox/p.jpg", payload: { bucket: "job-photos", storage_path: "j1/p.jpg", photo_type: "before" } })
    );
    const gw = makeGateway();
    const order: string[] = [];
    gw.uploadObject.mockImplementation(async () => void order.push("upload"));
    gw.insertRow.mockImplementation(async () => void order.push("insert"));
    gw.cleanupAttachment.mockImplementation(async () => void order.push("cleanup"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(order).toEqual(["upload", "insert", "cleanup"]); // cleanup last
    expect(gw.cleanupAttachment).toHaveBeenCalledWith("/doc/outbox/p.jpg");
  });

  it("keeps the local attachment when the metadata write fails (so the retry can re-upload)", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("photo-2", { aggregate: "job_photo", table: "job_photos", attachmentLocalPath: "/doc/outbox/q.jpg", payload: { bucket: "job-photos", storage_path: "j1/q.jpg" } })
    );
    const gw = makeGateway();
    gw.insertRow.mockRejectedValueOnce(new Error("network down"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.cleanupAttachment).not.toHaveBeenCalled(); // file preserved for retry
    expect(await outbox.failedCount()).toBe(1);
  });

  it("an upload-only op uploads the object, writes NO row, and cleans up the local file", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(
      write("up-1", { aggregate: "job", table: "", op: "upload", attachmentLocalPath: "/doc/outbox/v.m4a", payload: { bucket: "job-audio", storage_path: "j1/v.m4a" } })
    );
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.uploadObject).toHaveBeenCalledWith("job-audio", "j1/v.m4a", "/doc/outbox/v.m4a");
    expect(gw.insertRow).not.toHaveBeenCalled(); // no metadata row for an upload-only op
    expect(gw.updateRow).not.toHaveBeenCalled();
    expect(gw.cleanupAttachment).toHaveBeenCalledWith("/doc/outbox/v.m4a");
    expect(await outbox.pendingCount()).toBe(0);
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
    gw.insertRow.mockImplementation(async () => void order.push("write"));
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
    expect(gw.insertRow).toHaveBeenCalledWith("time_entries", { id: "te-1", job_id: "j1" });
    expect(gw.updateRow).toHaveBeenCalledWith("time_entries", "te-1", { clock_out: "12:00" });
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("reclaims a crash-stranded inflight op and processes it on the next drain", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("te-1", { payload: { job_id: "j1" } }));
    await outbox.markInflight("te-1"); // simulate a crash mid-dispatch on a prior run
    const gw = makeGateway();
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(gw.insertRow).toHaveBeenCalledWith("time_entries", { id: "te-1", job_id: "j1" });
    expect(await outbox.pendingCount()).toBe(0); // recovered and completed
  });

  it("backs off a failed op (leaves it outstanding) without dropping it", async () => {
    const store = new InMemoryOutboxStore();
    const outbox = new Outbox(store, fixedClock());
    await outbox.enqueue(write("a"));
    const gw = makeGateway();
    gw.insertRow.mockRejectedValueOnce(new Error("network down"));
    await new Processor(outbox, gw, makeApi(), online(true)).drain();
    expect(await outbox.failedCount()).toBe(1); // still there, backed off
  });
});

// The queue previously grew for the life of the install: nothing removed
// completed operations, while nextReady() SELECTs the whole table and parses
// every row inside the drain loop. Draining is the natural moment to prune —
// it already runs whenever there is work, and the pass has just finished, so
// nothing is mid-flight.
describe("Processor — prunes completed work after a drain", () => {
  it("removes completed operations older than the retention window", async () => {
    const store = new InMemoryOutboxStore();
    // Clock far past the retention window so anything created at t=0 is eligible.
    const box = new Outbox(store, fixedClock(30 * 24 * 60 * 60 * 1000));
    const proc = new Processor(box, makeGateway(), makeApi(), online(true));

    await box.enqueue(write("a"));
    await proc.drain();

    // 'a' dispatched, was marked done, and then pruned in the same pass.
    expect(await store.all()).toEqual([]);
  });

  it("does not prune a completed op a queued dependent still needs", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, fixedClock(30 * 24 * 60 * 60 * 1000));
    const gateway = makeGateway();
    // The dependent fails, so it stays live and must keep its dependency.
    gateway.updateRow.mockRejectedValue(new Error("offline mid-pass"));
    const proc = new Processor(box, gateway, makeApi(), online(true));

    await box.enqueue(write("insert-op"));
    await box.enqueue(write("update-op", { op: "update", dependsOn: "insert-op" }));
    await proc.drain();

    const ids = (await store.all()).map((o) => o.id).sort();
    expect(ids).toEqual(["insert-op", "update-op"]);
  });
});

describe("Processor — reclaims orphaned attachment files", () => {
  const OLD = Date.now() - 2 * 60 * 60 * 1000; // beyond the grace period

  it("deletes a staged file no operation references", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, fixedClock(0));
    const gateway = makeGateway();
    gateway.listStagedAttachments.mockResolvedValue([{ uri: "orphan.jpg", modifiedAt: OLD }]);
    const proc = new Processor(box, gateway, makeApi(), online(true));

    await proc.drain();

    expect(gateway.cleanupAttachment).toHaveBeenCalledWith("orphan.jpg");
  });

  it("keeps the file of a dead operation, which retryDead still needs", async () => {
    const store = new InMemoryOutboxStore();
    const box = new Outbox(store, fixedClock(0));
    const gateway = makeGateway();
    gateway.listStagedAttachments.mockResolvedValue([{ uri: "dead-photo.jpg", modifiedAt: OLD }]);
    const proc = new Processor(box, gateway, makeApi(), online(true));

    await box.enqueue(write("d", { attachmentLocalPath: "dead-photo.jpg" }));
    await store.update("d", { status: "dead" });
    await proc.drain();

    expect(gateway.cleanupAttachment).not.toHaveBeenCalledWith("dead-photo.jpg");
  });
});
