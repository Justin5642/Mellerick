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
const effects = (ops: Operation[]) => ops.filter((o) => o.kind === "side_effect");

const TEST_INPUT = {
  deviceId: "dev-1",
  testedBy: "u1",
  testType: "annual",
  testDate: "2026-07-27",
  result: "pass" as const,
  mainsPressureKpa: 500,
  permissionToTurnOffWater: true,
  strainerInstalled: true,
  strainerCleaned: true,
  isolatingValvesPadlocked: false,
  compliesWithAsNzs: true,
  testKitSerialNumber: "KIT-9",
  testKitCalibrationDate: "2026-01-01",
  testerName: "Tech One",
  testerLicenceNumber: "LIC-1",
  testerPhone: "0400000000",
  remarks: "all good",
  testResults: [{ group_label: "Main Device", check_valve_1_kpa: 12 }],
};

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

// Q3 is now answered (the submit endpoint is idempotent + force-gated), so logging
// a TEST can finally be offline-durable: the row replays on a client-UUID PK, the
// signature rides the attachment queue, and the water-authority submit is a
// side-effect GATED on the row landing — and can never double-email on retry.
describe("BackflowRepository.logTest (offline-durable, Q3 unblocked)", () => {
  it("inserts the test on a client-UUID PK and maps every compliance field", async () => {
    const { outbox, ops } = captureOutbox();
    const { id } = await new BackflowRepository(outbox, seqIds(), fixedTime()).logTest(TEST_INPUT);

    expect(id).toBe("id-1");
    const w = writes(ops)[0];
    expect(w).toMatchObject({ table: "backflow_tests", op: "insert", aggregate: "backflow_test", rowId: "id-1" });
    expect(w.payload).toMatchObject({
      device_id: "dev-1",
      tested_by: "u1",
      test_type: "annual",
      test_date: "2026-07-27",
      result: "pass",
      mains_pressure_kpa: 500,
      permission_to_turn_off_water: true,
      strainer_installed: true,
      complies_with_as_nzs_3500_1: true,
      test_kit_serial_number: "KIT-9",
      tester_name: "Tech One",
      remarks: "all good",
      test_results: [{ group_label: "Main Device", check_valve_1_kpa: 12 }],
      signature_storage_path: null,
    });
    // A passing test carries no failure fields.
    expect(w.payload.reason_for_failure).toBeNull();
    expect(w.payload.repair_scheduled_date).toBeNull();
  });

  it("queues the water-authority submit GATED on the test row landing", async () => {
    const { outbox, ops } = captureOutbox();
    await new BackflowRepository(outbox, seqIds(), fixedTime()).logTest(TEST_INPUT);

    const insert = writes(ops)[0];
    const submit = effects(ops)[0];
    expect(submit).toMatchObject({
      kind: "side_effect",
      effect: "backflow-submit",
      coalesceKey: "backflow-submit:id-1",
      payload: { testId: "id-1" },
      dependsOn: insert.id, // must never fire before the row exists
    });
  });

  it("routes the signature through the attachment queue keyed by the row id", async () => {
    const { outbox, ops } = captureOutbox();
    await new BackflowRepository(outbox, seqIds(), fixedTime()).logTest({
      ...TEST_INPUT,
      signature: { localUri: "file:///durable/sig.png" },
    });
    const w = writes(ops)[0];
    expect(w.attachmentLocalPath).toBe("file:///durable/sig.png");
    expect(w.attachmentPathField).toBe("signature_storage_path");
    expect(w.payload).toMatchObject({
      bucket: "backflow-certificates",
      signature_storage_path: "dev-1/signatures/id-1.png", // derived from the row id → idempotent replay
    });
  });

  it("records the failure fields only when the test FAILS", async () => {
    const { outbox, ops } = captureOutbox();
    await new BackflowRepository(outbox, seqIds(), fixedTime()).logTest({
      ...TEST_INPUT,
      result: "fail",
      reasonForFailure: "check valve 1 leaking",
      repairScheduledDate: "2026-08-01",
    });
    expect(writes(ops)[0].payload).toMatchObject({
      result: "fail",
      reason_for_failure: "check valve 1 leaking",
      repair_scheduled_date: "2026-08-01",
    });
  });
});
