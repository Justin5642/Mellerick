import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation, SideEffectOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

const CERTIFICATE_BUCKET = "backflow-certificates";

/** One device group's readings on a test certificate (stored as jsonb). */
export type BackflowTestResultGroup = Record<string, unknown>;

export interface LogTestInput {
  deviceId: string;
  testedBy: string | null;
  testType: string;
  testDate: string; // YYYY-MM-DD
  result: "pass" | "fail";
  mainsPressureKpa?: number | null;
  permissionToTurnOffWater?: boolean | null;
  strainerInstalled?: boolean | null;
  strainerCleaned?: boolean | null;
  isolatingValvesPadlocked?: boolean | null;
  compliesWithAsNzs?: boolean | null;
  reasonForFailure?: string | null;
  repairScheduledDate?: string | null;
  testKitSerialNumber?: string | null;
  testKitCalibrationDate?: string | null;
  testerName: string;
  testerLicenceNumber?: string | null;
  testerPhone?: string | null;
  remarks?: string | null;
  testResults: BackflowTestResultGroup[];
  /** A durable local PNG (already copied out of the volatile cache dir). */
  signature?: { localUri: string } | null;
}

export interface RegisterDeviceInput {
  customerId: string;
  siteId?: string | null;
  waterAuthority: string;
  deviceType: string;
  protectionType?: string | null;
  make?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  sizeMm?: number | null;
  locationDescription?: string | null;
  waterAuthorityPropertyNumber?: string | null;
  waterMeterNumber?: string | null;
  fireServiceMeterNumber?: string | null;
  testFrequencyMonths?: number;
  notes?: string | null;
  createdBy?: string | null;
}

// Offline-first backflow writes. Both routes through the durable outbox with a
// client-UUID PK so work done in the field with no signal replays idempotently:
//   • registerDevice — plain insert.
//   • logTest — the compliance path. Safe to make offline now that the submit
//     endpoint is idempotent (Q3): the signature rides the attachment queue
//     (upload-before-row), and the water-authority email is a side-effect GATED
//     on the row insert, so it can never fire early nor double-send on retry.
export class BackflowRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async registerDevice(input: RegisterDeviceInput): Promise<string> {
    const rowId = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "backflow_device",
      op: "insert",
      table: "backflow_devices",
      payload: {
        customer_id: input.customerId,
        site_id: input.siteId ?? null,
        water_authority: input.waterAuthority,
        device_type: input.deviceType,
        protection_type: input.protectionType ?? null,
        make: input.make ?? null,
        model: input.model ?? null,
        serial_number: input.serialNumber ?? null,
        size_mm: input.sizeMm ?? null,
        location_description: input.locationDescription ?? null,
        water_authority_property_number: input.waterAuthorityPropertyNumber ?? null,
        water_meter_number: input.waterMeterNumber ?? null,
        fire_service_meter_number: input.fireServiceMeterNumber ?? null,
        test_frequency_months: input.testFrequencyMonths ?? 12,
        notes: input.notes ?? null,
        created_by: input.createdBy ?? null,
        is_active: true, // so it appears in the active-devices list immediately
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return rowId;
  }

  /**
   * Log a backflow test and queue its water-authority submission. Returns the
   * client-generated test id so the screen can navigate optimistically.
   */
  async logTest(input: LogTestInput): Promise<{ id: string }> {
    const rowId = this.ids.newId();
    const opId = this.ids.newId();
    // Object key derived from the row id (not a timestamp) so a replay re-uploads
    // to the SAME key instead of orphaning a second copy.
    const signaturePath = input.signature ? `${input.deviceId}/signatures/${rowId}.png` : null;
    const failed = input.result === "fail";

    const payload: Record<string, unknown> = {
      device_id: input.deviceId,
      tested_by: input.testedBy ?? null,
      test_type: input.testType,
      test_date: input.testDate,
      result: input.result,
      mains_pressure_kpa: input.mainsPressureKpa ?? null,
      permission_to_turn_off_water: input.permissionToTurnOffWater ?? null,
      strainer_installed: input.strainerInstalled ?? null,
      strainer_cleaned: input.strainerCleaned ?? null,
      isolating_valves_padlocked: input.isolatingValvesPadlocked ?? null,
      complies_with_as_nzs_3500_1: input.compliesWithAsNzs ?? null,
      // Failure detail belongs only to a failing test (matches the web).
      reason_for_failure: failed ? input.reasonForFailure ?? null : null,
      repair_scheduled_date: failed ? input.repairScheduledDate ?? null : null,
      test_kit_serial_number: input.testKitSerialNumber ?? null,
      test_kit_calibration_date: input.testKitCalibrationDate ?? null,
      tester_name: input.testerName,
      tester_licence_number: input.testerLicenceNumber ?? null,
      tester_phone: input.testerPhone ?? null,
      remarks: input.remarks ?? null,
      test_results: input.testResults,
      signature_storage_path: signaturePath,
    };
    if (input.signature) payload.bucket = CERTIFICATE_BUCKET; // transport-only; stripped before the row write

    const write: WriteOperation = {
      kind: "write",
      id: opId,
      rowId,
      aggregate: "backflow_test",
      op: "insert",
      table: "backflow_tests",
      payload,
      ...(input.signature ? { attachmentLocalPath: input.signature.localUri, attachmentPathField: "signature_storage_path" } : {}),
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);

    // The compliance email. Gated on the insert so it can never reference a row
    // that doesn't exist yet; the endpoint itself is idempotent (Q3), so even a
    // retried side-effect cannot email the water authority twice.
    const submit: SideEffectOperation = {
      kind: "side_effect",
      id: this.ids.newId(),
      effect: "backflow-submit",
      coalesceKey: `backflow-submit:${rowId}`,
      payload: { testId: rowId },
      dependsOn: opId,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(submit);

    return { id: rowId };
  }
}
