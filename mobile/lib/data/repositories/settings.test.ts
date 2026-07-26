import { SettingsRepository } from "./settings";
import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { Operation, WriteOperation } from "../outbox/types";
import type { TimeSource } from "../time";

function seqIds(): IdGen {
  let n = 0;
  return { newId: () => `id-${++n}` };
}
const fixedTime = (ms = 1_000): TimeSource => ({ nowMs: () => ms, nowIso: () => "2026-07-27T00:00:00.000Z" });
function captureOutbox(): { outbox: Outbox; ops: WriteOperation[] } {
  const ops: WriteOperation[] = [];
  const outbox = { enqueue: jest.fn(async (op: Operation) => void ops.push(op as WriteOperation)) } as unknown as Outbox;
  return { outbox, ops };
}
const makeRepo = (outbox: Outbox) => new SettingsRepository(outbox, seqIds(), fixedTime());

describe("SettingsRepository — variation types", () => {
  it("createVariationType inserts an active row with all fields mapped", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await makeRepo(outbox).createVariationType({ name: "Rock Removal", unit: "m³", rate: 120, autoApprove: false });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "variation_types", op: "insert", aggregate: "variation_type", rowId: "id-1" });
    expect(ops[0].payload).toEqual({ name: "Rock Removal", unit: "m³", rate: 120, auto_approve: false, is_active: true });
  });

  it("updateVariationType edits fields but NOT is_active (preserve-on-update)", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).updateVariationType("v1", { name: "Rock", unit: "t", rate: 90, autoApprove: true });
    expect(ops[0]).toMatchObject({ op: "update", rowId: "v1" });
    expect(ops[0].payload).toEqual({ name: "Rock", unit: "t", rate: 90, auto_approve: true });
    expect(ops[0].payload).not.toHaveProperty("is_active");
  });

  it("setVariationTypeActive soft-deactivates / reactivates", async () => {
    const b1 = captureOutbox();
    await makeRepo(b1.outbox).setVariationTypeActive("v1", false);
    expect(b1.ops[0].payload).toEqual({ is_active: false });
    const b2 = captureOutbox();
    await makeRepo(b2.outbox).setVariationTypeActive("v1", true);
    expect(b2.ops[0].payload).toEqual({ is_active: true });
  });
});

describe("SettingsRepository — cost centre templates", () => {
  it("createCostCentreTemplate inserts an active row into cost_center_templates", async () => {
    const { outbox, ops } = captureOutbox();
    const id = await makeRepo(outbox).createCostCentreTemplate({ groupName: "Excavation", name: "Rock", code: "EX-01" });
    expect(id).toBe("id-1");
    expect(ops[0]).toMatchObject({ table: "cost_center_templates", op: "insert", aggregate: "cost_center_template", rowId: "id-1" });
    expect(ops[0].payload).toEqual({ group_name: "Excavation", name: "Rock", code: "EX-01", is_active: true });
  });

  it("setCostCentreTemplateActive toggles is_active", async () => {
    const { outbox, ops } = captureOutbox();
    await makeRepo(outbox).setCostCentreTemplateActive("t1", false);
    expect(ops[0]).toMatchObject({ table: "cost_center_templates", op: "update", rowId: "t1", payload: { is_active: false } });
  });
});
