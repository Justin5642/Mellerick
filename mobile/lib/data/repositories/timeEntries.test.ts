import { TimeEntriesRepository, hoursBetween, type TimeSource } from "./timeEntries";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation, SideEffectOperation } from "../outbox/types";

// Deterministic id sequence: id-1, id-2, ... so we can reason about which call
// produced which id (rowId, then op id, then side-effect id).
function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (iso = "2026-07-21T09:00:00.000Z", ms = 1_000): TimeSource => ({
  nowMs: () => ms,
  nowIso: () => iso,
});

// Capture what the repository enqueues without exercising outbox internals.
function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}
const writes = (ops: Operation[]) => ops.filter((o): o is WriteOperation => o.kind === "write");
const sides = (ops: Operation[]) => ops.filter((o): o is SideEffectOperation => o.kind === "side_effect");

describe("hoursBetween", () => {
  it("computes whole and fractional hours to 2dp", () => {
    expect(hoursBetween("2026-07-21T09:00:00Z", "2026-07-21T11:00:00Z")).toBe(2);
    expect(hoursBetween("2026-07-21T09:00:00Z", "2026-07-21T09:45:00Z")).toBe(0.75);
    expect(hoursBetween("2026-07-21T09:00:00Z", "2026-07-21T09:20:00Z")).toBe(0.33);
  });
  it("is null when the end is not strictly after the start", () => {
    expect(hoursBetween("2026-07-21T09:00:00Z", "2026-07-21T09:00:00Z")).toBeNull();
    expect(hoursBetween("2026-07-21T11:00:00Z", "2026-07-21T09:00:00Z")).toBeNull();
  });
});

describe("TimeEntriesRepository", () => {
  it("clockIn enqueues an insert with a client-UUID PK and returns that id", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime());
    const id = await repo.clockIn({ jobId: "j1", staffId: "s1" });

    expect(id).toBe("id-1");
    const [w] = writes(ops);
    expect(w.op).toBe("insert");
    expect(w.table).toBe("time_entries");
    expect(w.rowId).toBe("id-1"); // the row PK
    expect(w.id).not.toBe(w.rowId); // op id is distinct from row id
    expect(w.payload).toEqual({
      job_id: "j1",
      staff_id: "s1",
      clock_in: "2026-07-21T09:00:00.000Z",
      auto_clocked: false,
    });
  });

  it("clockIn queues a sync-billing side-effect keyed on the entry, depending on the write", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime());
    await repo.clockIn({ jobId: "j1", staffId: "s1" });

    const [w] = writes(ops);
    const [s] = sides(ops);
    expect(s.effect).toBe("sync-billing");
    expect(s.coalesceKey).toBe("sync-billing:id-1");
    expect(s.payload).toEqual({ entryId: "id-1" });
    expect(s.dependsOn).toBe(w.id); // fires only after the row is written
  });

  it("clockOut enqueues an update with computed hours + a dependent billing sync", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime("2026-07-21T11:30:00.000Z"));
    await repo.clockOut({ entryId: "te-9", clockInIso: "2026-07-21T09:00:00.000Z" });

    const [w] = writes(ops);
    expect(w.op).toBe("update");
    expect(w.rowId).toBe("te-9");
    expect(w.payload).toEqual({ clock_out: "2026-07-21T11:30:00.000Z", hours: 2.5 });
    expect(sides(ops)[0].coalesceKey).toBe("sync-billing:te-9");
    expect(sides(ops)[0].dependsOn).toBe(w.id);
  });

  it("addManual writes every column incl. hours + edited_by/at, and returns the new id", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime("2026-07-21T12:00:00.000Z"));
    const id = await repo.addManual({
      jobId: "j1",
      staffId: "s1",
      entryType: "work",
      clockInIso: "2026-07-21T08:00:00.000Z",
      clockOutIso: "2026-07-21T10:00:00.000Z",
      costCenterId: "cc-1",
    });

    expect(id).toBe("id-1");
    const [w] = writes(ops);
    expect(w.op).toBe("insert");
    expect(w.payload).toEqual({
      job_id: "j1",
      staff_id: "s1",
      entry_type: "work",
      clock_in: "2026-07-21T08:00:00.000Z",
      clock_out: "2026-07-21T10:00:00.000Z",
      hours: 2,
      cost_center_id: "cc-1",
      auto_clocked: false,
      edited_by: "s1",
      edited_at: "2026-07-21T12:00:00.000Z",
    });
    expect(sides(ops)).toHaveLength(1);
  });

  it("addManual leaves hours null for a still-open entry", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime());
    await repo.addManual({
      jobId: "j1",
      staffId: "s1",
      entryType: "work",
      clockInIso: "2026-07-21T08:00:00.000Z",
      clockOutIso: null,
      costCenterId: null,
    });
    expect(writes(ops)[0].payload.hours).toBeNull();
    expect(writes(ops)[0].payload.clock_out).toBeNull();
  });

  it("editEntry updates the row with editor + recomputed hours and resyncs billing", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime("2026-07-21T12:00:00.000Z"));
    await repo.editEntry({
      entryId: "te-3",
      editorId: "s2",
      clockInIso: "2026-07-21T08:00:00.000Z",
      clockOutIso: "2026-07-21T09:30:00.000Z",
      costCenterId: null,
    });
    const [w] = writes(ops);
    expect(w.op).toBe("update");
    expect(w.rowId).toBe("te-3");
    expect(w.payload).toEqual({
      clock_in: "2026-07-21T08:00:00.000Z",
      clock_out: "2026-07-21T09:30:00.000Z",
      hours: 1.5,
      cost_center_id: null,
      edited_by: "s2",
      edited_at: "2026-07-21T12:00:00.000Z",
    });
    expect(sides(ops)).toHaveLength(1);
  });

  it("assignCostCenter updates only cost_center_id and does NOT resync billing", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime());
    await repo.assignCostCenter("te-5", "cc-2");
    expect(writes(ops)[0].payload).toEqual({ cost_center_id: "cc-2" });
    expect(sides(ops)).toHaveLength(0); // parity with web: no billing resync
  });

  it("remove enqueues a delete and does NOT resync billing", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime());
    await repo.remove("te-7");
    expect(writes(ops)[0]).toMatchObject({ op: "delete", rowId: "te-7", table: "time_entries" });
    expect(sides(ops)).toHaveLength(0);
  });
});
