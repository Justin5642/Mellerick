import { TimeEntriesRepository, type TimeSource } from "./timeEntries";
import { VariationsRepository } from "./variations";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import { withoutMissingOptionalColumns } from "../optionalColumns";

// Time against a variation (0120, draft — Justin, 25 Nov 2026): the crew clock
// on to a variation, switch to one while clocked on, or move an entry on or off
// one — all through the outbox, so it works offline.

function seqIds(prefix = "id"): IdGen {
  let n = 0;
  return { newId: () => `${prefix}-${++n}` };
}
const fixedTime = (iso = "2026-07-21T12:00:00.000Z", ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => iso });
function captureOutbox(): { outbox: Outbox; ops: Operation[] } {
  const ops: Operation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op)) } as unknown as Outbox;
  return { outbox, ops };
}
const writes = (ops: Operation[]) => ops.filter((o): o is WriteOperation => o.kind === "write");

describe("TimeEntriesRepository — variations", () => {
  it("clockIn tags the variation and waits for the op it is given; untagged payloads are unchanged", async () => {
    const { outbox, ops } = captureOutbox();
    await new TimeEntriesRepository(outbox, seqIds(), fixedTime()).clockIn({ jobId: "j1", staffId: "s1", variationId: "v1", dependsOn: "var-op" });
    const [w] = writes(ops);
    expect(w.payload).toMatchObject({ variation_id: "v1" });
    expect(w.dependsOn).toBe("var-op");

    const plain = captureOutbox();
    await new TimeEntriesRepository(plain.outbox, seqIds(), fixedTime()).clockIn({ jobId: "j1", staffId: "s1" });
    expect(writes(plain.ops)[0].payload).not.toHaveProperty("variation_id");
    expect(writes(plain.ops)[0].dependsOn).toBeUndefined();
  });

  it("switchClock clocks off and on at the same instant, the clock-on waiting for the clock-off", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new TimeEntriesRepository(outbox, seqIds(), fixedTime()).switchClock({
      open: { id: "e1", jobId: "j1", staffId: "s1", clockInIso: "2026-07-21T09:00:00.000Z" },
      atIso: "2026-07-21T11:30:00.000Z",
      costCenterId: "cc1",
      variationId: "v1",
    });
    const [off, on] = writes(ops);
    expect(off).toMatchObject({ op: "update", rowId: "e1", payload: { clock_out: "2026-07-21T11:30:00.000Z", hours: 2.5 } });
    expect(on).toMatchObject({
      op: "insert",
      rowId: id,
      dependsOn: off.id,
      payload: { job_id: "j1", staff_id: "s1", clock_in: "2026-07-21T11:30:00.000Z", cost_center_id: "cc1", variation_id: "v1" },
    });
  });

  it("switching back to the stage sends no variation", async () => {
    const { outbox, ops } = captureOutbox();
    await new TimeEntriesRepository(outbox, seqIds(), fixedTime()).switchClock({
      open: { id: "e1", jobId: "j1", staffId: "s1", clockInIso: "2026-07-21T09:00:00.000Z" },
      atIso: "2026-07-21T11:00:00.000Z",
      costCenterId: "cc1",
      variationId: null,
    });
    expect(writes(ops)[1].payload).not.toHaveProperty("variation_id");
  });

  it("a switch can't end an entry over 24 hours old — nothing is queued", async () => {
    const { outbox, ops } = captureOutbox();
    await expect(
      new TimeEntriesRepository(outbox, seqIds(), fixedTime("2026-07-23T12:00:00.000Z")).switchClock({
        open: { id: "e1", jobId: "j1", staffId: "s1", clockInIso: "2026-07-21T09:00:00.000Z" },
        atIso: "2026-07-23T11:00:00.000Z",
        costCenterId: null,
        variationId: "v1",
      })
    ).rejects.toThrow(/24 hours/);
    expect(ops).toHaveLength(0);
  });

  it("setVariation is a one-column update, null to move back to the stage", async () => {
    const { outbox, ops } = captureOutbox();
    const repo = new TimeEntriesRepository(outbox, seqIds(), fixedTime());
    await repo.setVariation("e1", "v1");
    await repo.setVariation("e1", null);
    expect(writes(ops).map((w) => [w.rowId, w.op, w.payload])).toEqual([
      ["e1", "update", { variation_id: "v1" }],
      ["e1", "update", { variation_id: null }],
    ]);
  });

  it("a new variation from the picker is a custom one with no price, its op id handed back for the clock-on to wait for", async () => {
    const { outbox, ops } = captureOutbox();
    const r = await new VariationsRepository(outbox, seqIds("v"), fixedTime()).submitVariation({
      jobId: "j1",
      variationTypeId: null,
      customName: "Hit rock",
      description: null,
      quantity: 1,
      unit: "unit",
      loggedBy: "s1",
      dependsOn: "off-op",
    });
    const [w] = writes(ops);
    expect(r).toEqual({ id: w.rowId, opId: w.id });
    expect(w.dependsOn).toBe("off-op");
    expect(Object.keys(w.payload)).not.toEqual(expect.arrayContaining(["rate"]));
    expect(w.payload).not.toHaveProperty("total_amount");
  });
});

describe("a queued clock-on on a database without 0120", () => {
  it("drops variation_id and keeps the rest, so the clock-on still lands", () => {
    const payload = { job_id: "j1", staff_id: "s1", clock_in: "x", variation_id: "v1" };
    expect(
      withoutMissingOptionalColumns("time_entries", payload, { code: "PGRST204", message: "Could not find the 'variation_id' column of 'time_entries'" })
    ).toEqual({ job_id: "j1", staff_id: "s1", clock_in: "x" });
    expect(withoutMissingOptionalColumns("time_entries", payload, { code: "PGRST204", message: "Could not find the 'hours' column" })).toBeNull();
  });
});
