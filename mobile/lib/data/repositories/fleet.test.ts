import { EquipmentRepository } from "./fleet";
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

const base = {
  name: "Ute", category: "vehicle", purchaseCost: 40000, estimatedLifeYears: 8,
  insuranceAnnual: 1200, maintenanceAnnual: 900, registrationAnnual: 800, otherAnnualCosts: 0,
  fuelCostPerHour: 6, targetHoursPerYear: 1200,
};

describe("EquipmentRepository", () => {
  it("createEquipment inserts active equipment with all cost columns mapped", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new EquipmentRepository(outbox, seqIds(), fixedTime()).createEquipment(base);
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "equipment", op: "insert", rowId: "id-1" });
    expect(ops[0].payload).toMatchObject({ name: "Ute", category: "vehicle", purchase_cost: 40000, estimated_life_years: 8, insurance_annual: 1200, fuel_cost_per_hour: 6, target_hours_per_year: 1200, is_active: true });
  });

  it("updateEquipment omits is_active; deactivate soft-deletes", async () => {
    const b1 = captureOutbox();
    await new EquipmentRepository(b1.outbox, seqIds(), fixedTime()).updateEquipment("e1", base);
    expect(b1.ops[0].payload).not.toHaveProperty("is_active");
    expect(b1.ops[0]).toMatchObject({ op: "update", rowId: "e1" });

    const b2 = captureOutbox();
    await new EquipmentRepository(b2.outbox, seqIds(), fixedTime()).deactivateEquipment("e1");
    expect(b2.ops[0]).toMatchObject({ op: "update", rowId: "e1", payload: { is_active: false } });
  });
});
