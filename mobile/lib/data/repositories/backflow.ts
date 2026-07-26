import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

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

// Offline-first registration of a backflow device (the one backflow WRITE that
// isn't compliance-gated). Routes through the durable outbox with a client-UUID
// PK so a device registered in the field with no signal replays idempotently.
// (Logging a TEST — which carries a certificate upload + a water-authority
// submit that must be dedupe-guarded, see Q3 — is a separate follow-up.)
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
}
