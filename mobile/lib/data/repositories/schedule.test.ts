import { ScheduleRepository } from "./schedule";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation, SideEffectOperation } from "../outbox/types";
import type { TimeSource } from "../time";
import { buildScheduleColumns, moveSchedule, scheduleDays } from "../../scheduling";

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

  it("setCrew sets a whole crew without touching assigned_to or the times", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).setCrew("j1", ["t1", "t2", "t1"]);
    expect(writes(ops)).toHaveLength(0); // no jobs write: assigned_to would collapse the crew (0059)
    const assign = sides(ops).find((o) => o.effect === "assign-technicians")!;
    expect(assign.payload).toEqual({ jobId: "j1", staffIds: ["t1", "t2"] }); // de-duplicated
    expect(assign.coalesceKey).toBe("assign-technicians:j1");
  });

  it("setCrew with nobody unassigns the whole crew", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).setCrew("j1", []);
    expect(sides(ops)[0].payload).toEqual({ jobId: "j1", staffIds: [] });
  });

  it("schedule writes the window and both 0071 flags in ONE job update, then assign-technicians gated on it", async () => {
    const { outbox, ops } = captureOutbox();
    const cols = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    await makeRepo(outbox).schedule("j1", ["t1", "t2"], cols, "cc-1");

    const w = writes(ops);
    expect(w).toHaveLength(1);
    expect(w[0].payload).toEqual({
      scheduled_start: cols.scheduled_start,
      scheduled_end: cols.scheduled_end,
      schedule_daily: true,
      schedule_all_day: true,
      scheduled_cost_center_id: "cc-1",
    });
    expect(w[0].payload).not.toHaveProperty("assigned_to"); // derived from job_assignments (0059)
    const assign = sides(ops).find((o) => o.effect === "assign-technicians")!;
    expect(assign.dependsOn).toBe(w[0].id);
    expect(assign.payload).toEqual({ jobId: "j1", staffIds: ["t1", "t2"] });
  });

  it("schedule of a single day writes schedule_daily false (a once-daily job rescheduled to one day stops repeating)", async () => {
    const { outbox, ops } = captureOutbox();
    const cols = buildScheduleColumns({ startDateKey: "2026-10-21", endDateKey: "2026-10-21", startTime: "09:00", endTime: "11:00", allDay: false });
    await makeRepo(outbox).schedule("j1", ["t1"], cols);
    expect(writes(ops)[0].payload).toMatchObject({ schedule_daily: false, schedule_all_day: false, scheduled_cost_center_id: null });
  });

  it("reschedule of a daily job with moveSchedule keeps its booked-day count", async () => {
    const { outbox, ops } = captureOutbox();
    const job = buildScheduleColumns({ startDateKey: "2026-10-19", endDateKey: "2026-10-21", startTime: "", endTime: "", allDay: true });
    const moved = moveSchedule(job, "2026-10-22")!;
    await makeRepo(outbox).reschedule("j1", moved.scheduled_start, moved.scheduled_end, { scheduleDaily: true });

    const payload = writes(ops)[0].payload as { scheduled_start: string; scheduled_end: string };
    expect(payload).toEqual({ ...moved, schedule_daily: true });
    expect(scheduleDays({ ...payload, schedule_daily: true })).toHaveLength(3); // Thu, Fri, Mon
  });

  it("reschedule can drop the All day flag when the block moves off the standard shift", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).reschedule("j1", "2026-07-29T23:00:00.000Z", "2026-07-30T01:00:00.000Z", { scheduleAllDay: false });
    expect(writes(ops)[0].payload).toEqual({
      scheduled_start: "2026-07-29T23:00:00.000Z",
      scheduled_end: "2026-07-30T01:00:00.000Z",
      schedule_all_day: false,
    });
  });

  it("clearSchedule nulls the window and resets both flags", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).clearSchedule("j1");
    expect(writes(ops)[0].payload).toEqual({
      scheduled_start: null,
      scheduled_end: null,
      schedule_daily: false,
      schedule_all_day: false,
    });
    expect(sides(ops)[0].coalesceKey).toBe("sync-calendar:j1");
  });
});
