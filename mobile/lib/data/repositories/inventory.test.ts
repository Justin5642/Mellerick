import { InventoryRepository } from "./inventory";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-26T00:00:00.000Z" });
function captureOutbox(): { outbox: Outbox; ops: WriteOperation[] } {
  const ops: WriteOperation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op as WriteOperation)) } as unknown as Outbox;
  return { outbox, ops };
}

describe("InventoryRepository", () => {
  it("createItem inserts an active item with mapped columns incl. both dollar fields", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new InventoryRepository(outbox, seqIds(), fixedTime()).createItem({
      name: "Valve", sku: "V-1", category: "parts", quantityOnHand: 10, reorderLevel: 3, unitCost: 5, unitSell: 12,
    });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "inventory", op: "insert", rowId: "id-1" });
    expect(ops[0].payload).toMatchObject({ name: "Valve", sku: "V-1", quantity_on_hand: 10, reorder_level: 3, unit_cost: 5, unit_sell: 12, unit: "each", is_active: true });
  });

  it("updateItem does not touch is_active; deactivate soft-deletes; adjustQuantity sets only qty", async () => {
    const b1 = captureOutbox();
    await new InventoryRepository(b1.outbox, seqIds(), fixedTime()).updateItem("i1", { name: "X", quantityOnHand: 1, reorderLevel: 0, unitCost: 0, unitSell: 0 });
    expect(b1.ops[0].payload).not.toHaveProperty("is_active");

    const b2 = captureOutbox();
    await new InventoryRepository(b2.outbox, seqIds(), fixedTime()).deactivateItem("i1");
    expect(b2.ops[0]).toMatchObject({ op: "update", rowId: "i1", payload: { is_active: false } });

    const b3 = captureOutbox();
    await new InventoryRepository(b3.outbox, seqIds(), fixedTime()).adjustQuantity("i1", 42);
    expect(b3.ops[0].payload).toEqual({ quantity_on_hand: 42 });
  });
});
