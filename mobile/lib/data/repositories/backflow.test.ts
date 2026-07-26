import { BackflowRepository } from "./backflow";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
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

describe("BackflowRepository.registerDevice", () => {
  it("inserts a backflow_devices row via the outbox with a client-UUID PK and is_active true", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new BackflowRepository(outbox, seqIds(), fixedTime()).registerDevice({
      customerId: "c1",
      siteId: "s1",
      waterAuthority: "yarra_valley_water",
      deviceType: "rpzd",
      serialNumber: "SN-1",
      sizeMm: 20,
      testFrequencyMonths: 12,
      createdBy: "u1",
    });
    expect(id).toBe("id-1");
    const w = writes(ops)[0];
    expect(w).toMatchObject({ table: "backflow_devices", op: "insert", aggregate: "backflow_device", rowId: "id-1" });
    expect(w.id).not.toBe(w.rowId); // op id distinct from row id
    expect(w.payload).toMatchObject({
      customer_id: "c1",
      site_id: "s1",
      water_authority: "yarra_valley_water",
      device_type: "rpzd",
      serial_number: "SN-1",
      size_mm: 20,
      test_frequency_months: 12,
      created_by: "u1",
      is_active: true,
    });
  });

  it("defaults optional fields to null and test_frequency_months to 12", async () => {
    const { outbox, ops } = captureOutbox();
    await new BackflowRepository(outbox, seqIds(), fixedTime()).registerDevice({
      customerId: "c1",
      waterAuthority: "south_east_water",
      deviceType: "dcv",
    });
    const w = writes(ops)[0];
    expect(w.payload.site_id).toBeNull();
    expect(w.payload.serial_number).toBeNull();
    expect(w.payload.test_frequency_months).toBe(12);
    expect(w.payload.is_active).toBe(true);
  });
});
