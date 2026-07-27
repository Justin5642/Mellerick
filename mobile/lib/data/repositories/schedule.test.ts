import { ScheduleRepository } from "./schedule";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation, SideEffectOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-26T00:00:00.000Z" });
function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}
const writes = (ops: Operation[]) => ops.filter((o): o is WriteOperation => o.kind === "write");
const sides = (ops: Operation[]) => ops.filter((o): o is SideEffectOperation => o.kind === "side_effect");
const makeRepo = (outbox: Outbox) => new ScheduleRepository(outbox, seqIds(), fixedTime());

describe("ScheduleRepository", () => {
  it("reassign enqueues a jobs update with only assigned_to + a coalesced sync-calendar gated on it", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).reassign("j1", "tech-1");

    const w = writes(ops)[0];
    expect(w).toMatchObject({ table: "jobs", op: "update", aggregate: "job", rowId: "j1" });
    expect(w.payload).toEqual({ assigned_to: "tech-1" }); // preserve-on-update: times untouched

    const cal = sides(ops)[0];
    expect(cal.effect).toBe("sync-calendar");
    expect(cal.coalesceKey).toBe("sync-calendar:j1");
    expect(cal.dependsOn).toBe(w.id); // runs after the job update
    expect(cal.payload).toEqual({ jobId: "j1" });
  });

  it("reassign to null unassigns the job", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).reassign("j1", null);
    expect(writes(ops)[0].payload).toEqual({ assigned_to: null });
  });

  it("reschedule enqueues a jobs update with start+end + a sync-calendar", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).reschedule("j1", "2026-07-29T23:00:00.000Z", "2026-07-30T01:00:00.000Z");

    const w = writes(ops)[0];
    expect(w.payload).toEqual({ scheduled_start: "2026-07-29T23:00:00.000Z", scheduled_end: "2026-07-30T01:00:00.000Z" });
    // no assigned_to in a reschedule (preserve-on-update)
    expect(w.payload).not.toHaveProperty("assigned_to");
    expect(sides(ops)[0].coalesceKey).toBe("sync-calendar:j1");
  });

  it("reschedule with a null end sends scheduled_end: null", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).reschedule("j1", "2026-07-29T23:00:00.000Z", null);
    expect(writes(ops)[0].payload).toEqual({ scheduled_start: "2026-07-29T23:00:00.000Z", scheduled_end: null });
  });
});
