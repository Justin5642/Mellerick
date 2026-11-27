import { ScheduleRepository } from "./schedule";
import type { Outbox } from "../outbox/outbox";
import type { Operation, SideEffectOperation } from "../outbox/types";
import { queuedMissedFlags } from "../../missedQueue";

// "Didn't make it" (0121 (draft)): a coalesced side effect per booking, never a
// job_bookings write (RLS lets only office/admin write bookings).

function capture(pendingInsert: string | null = null) {
  const ops: Operation[] = [];
  const outbox = {
    enqueue: jest.fn(async (op: Operation) => void ops.push(op)),
    pendingInsertOpId: jest.fn(async () => pendingInsert),
  } as unknown as Outbox;
  let n = 0;
  const repo = new ScheduleRepository(outbox, { newId: () => `id-${++n}` }, { nowMs: () => 5, nowIso: () => "x" });
  return { repo, ops, outbox };
}

describe("ScheduleRepository — didn't make it", () => {
  it("flags through a booking-missed side effect, coalesced per booking", async () => {
    const { repo, ops } = capture();
    await repo.flagMissed("j1", "b1", "weather", "rained out");
    expect(ops).toHaveLength(1);
    const op = ops[0] as SideEffectOperation;
    expect(op.kind).toBe("side_effect");
    expect(op.effect).toBe("booking-missed");
    expect(op.coalesceKey).toBe("booking-missed:b1");
    expect(op.payload).toEqual({ jobId: "j1", bookingId: "b1", reason: "weather", note: "rained out" });
    expect(op.dependsOn).toBeNull();
  });

  it("an undo is { clear: true } on the same key", async () => {
    const { repo, ops } = capture();
    await repo.clearMissed("j1", "b1");
    const op = ops[0] as SideEffectOperation;
    expect(op.coalesceKey).toBe("booking-missed:b1");
    expect(op.payload).toEqual({ jobId: "j1", bookingId: "b1", clear: true });
  });

  it("waits for the booking's own insert when it hasn't synced", async () => {
    const { repo, ops } = capture("insert-op");
    await repo.flagMissed("j1", "b1", "weather", null);
    expect((ops[0] as SideEffectOperation).dependsOn).toBe("insert-op");
  });
});

describe("queuedMissedFlags", () => {
  const op = (over: Partial<SideEffectOperation>): SideEffectOperation => ({
    kind: "side_effect",
    id: "o",
    effect: "booking-missed",
    coalesceKey: "k",
    payload: {},
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    ...over,
  });

  it("the latest queued change per booking; done and dead ones don't count", () => {
    const flags = queuedMissedFlags([
      op({ payload: { bookingId: "b1", reason: "weather", note: null }, createdAt: 1 }),
      op({ payload: { bookingId: "b2", clear: true }, createdAt: 2 }),
      op({ payload: { bookingId: "b3", reason: "other", note: "x" }, status: "done" }),
      op({ payload: { bookingId: "b4", reason: "other", note: "x" }, status: "dead" }),
      op({ effect: "sync-calendar", payload: { bookingId: "b5", reason: "weather" } }),
    ]);
    expect([...flags.entries()]).toEqual([
      ["b1", { reason: "weather", note: null }],
      ["b2", null],
    ]);
  });
});
