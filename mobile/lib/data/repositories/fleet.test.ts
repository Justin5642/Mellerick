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

  it("assignEquipment updates only assigned_to (assign + unassign)", async () => {
    const b1 = captureOutbox();
    await new EquipmentRepository(b1.outbox, seqIds(), fixedTime()).assignEquipment("e1", "tech-1");
    expect(b1.ops[0]).toMatchObject({ op: "update", rowId: "e1", payload: { assigned_to: "tech-1" } });
    expect(Object.keys(b1.ops[0].payload)).toEqual(["assigned_to"]); // preserve-on-update

    const b2 = captureOutbox();
    await new EquipmentRepository(b2.outbox, seqIds(), fixedTime()).assignEquipment("e1", null);
    expect(b2.ops[0].payload).toEqual({ assigned_to: null });
  });

  it("addEquipmentExpense (with receipt) uploads before the row: idempotent key + transport bucket", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await new EquipmentRepository(outbox, seqIds(), fixedTime()).addEquipmentExpense({
      equipmentId: "eq1",
      loggedBy: "u1",
      category: "service",
      supplierName: "Ultra Tune",
      amount: 350,
      gstAmount: 35,
      expenseDate: "2026-07-20",
      receipt: { localUri: "file:///doc/r.jpg" },
    });
    expect(res).toEqual({ id: "id-1", receiptStoragePath: "eq1/expense-id-1.jpg" });
    const w = ops[0];
    expect(w).toMatchObject({ table: "equipment_expenses", op: "insert", aggregate: "equipment_expense", rowId: "id-1" });
    expect(w.attachmentLocalPath).toBe("file:///doc/r.jpg");
    expect(w.attachmentPathField).toBe("receipt_storage_path");
    expect(w.payload).toMatchObject({
      equipment_id: "eq1",
      category: "service",
      supplier_name: "Ultra Tune",
      amount: 350,
      gst_amount: 35,
      logged_by: "u1",
      expense_date: "2026-07-20",
      bucket: "equipment-documents",
      receipt_storage_path: "eq1/expense-id-1.jpg",
    });
  });

  it("addEquipmentExpense (no receipt / no date) omits attachment + lets the DB default the date", async () => {
    const { outbox, ops } = captureOutbox();
    const res = await new EquipmentRepository(outbox, seqIds(), fixedTime()).addEquipmentExpense({ equipmentId: "eq1", loggedBy: "u1", category: "fuel", amount: 90, gstAmount: 9 });
    expect(res.receiptStoragePath).toBeNull();
    expect(ops[0].attachmentLocalPath).toBeUndefined();
    expect(ops[0].payload).not.toHaveProperty("receipt_storage_path");
    expect(ops[0].payload).not.toHaveProperty("expense_date");
    expect(ops[0].payload).not.toHaveProperty("bucket");
  });

  it("removeEquipmentExpense carries the receipt key for cleanup, or a plain delete without one", async () => {
    const b1 = captureOutbox();
    await new EquipmentRepository(b1.outbox, seqIds(), fixedTime()).removeEquipmentExpense({ id: "x1", receiptStoragePath: "eq1/expense-x1.jpg" });
    expect(b1.ops[0]).toMatchObject({ op: "delete", rowId: "x1", attachmentPathField: "receipt_storage_path", payload: { bucket: "equipment-documents", receipt_storage_path: "eq1/expense-x1.jpg" } });

    const b2 = captureOutbox();
    await new EquipmentRepository(b2.outbox, seqIds(), fixedTime()).removeEquipmentExpense({ id: "x2" });
    expect(b2.ops[0].attachmentPathField).toBeUndefined();
    expect(b2.ops[0].payload).toEqual({});
  });

  it("addEquipmentUsage inserts general (job_id null) usage; date optional", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await new EquipmentRepository(outbox, seqIds(), fixedTime()).addEquipmentUsage({ equipmentId: "eq1", loggedBy: "u1", hours: 6.5, usageDate: "2026-07-25", notes: "site A" });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "equipment_usage_log", op: "insert", aggregate: "equipment_usage", rowId: "id-1" });
    expect(ops[0].payload).toEqual({ equipment_id: "eq1", hours: 6.5, logged_by: "u1", notes: "site A", job_id: null, usage_date: "2026-07-25" });

    const b2 = captureOutbox();
    await new EquipmentRepository(b2.outbox, seqIds(), fixedTime()).addEquipmentUsage({ equipmentId: "eq1", loggedBy: "u1", hours: 3 });
    expect(b2.ops[0].payload).not.toHaveProperty("usage_date"); // DB default current_date
  });

  it("addEquipmentUsage links usage to a job when jobId is supplied", async () => {
    const { outbox, ops } = captureOutbox();
    await new EquipmentRepository(outbox, seqIds(), fixedTime()).addEquipmentUsage({ equipmentId: "eq1", loggedBy: "u1", hours: 4, jobId: "job9" });
    expect(ops[0].payload).toMatchObject({ equipment_id: "eq1", hours: 4, logged_by: "u1", job_id: "job9" });
  });

  it("removeEquipmentUsage is a plain delete", async () => {
    const { outbox, ops } = captureOutbox();
    await new EquipmentRepository(outbox, seqIds(), fixedTime()).removeEquipmentUsage("u9");
    expect(ops[0]).toMatchObject({ table: "equipment_usage_log", op: "delete", rowId: "u9" });
  });
});
