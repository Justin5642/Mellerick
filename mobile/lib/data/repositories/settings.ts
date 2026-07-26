import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface VariationTypeInput {
  name: string;
  unit: string;
  rate: number;
  autoApprove: boolean;
}

// Offline-first write path for admin Settings config. variation_types has a
// normal uuid id PK, so it routes through the durable outbox like the other
// aggregates. Deactivation is a soft-delete (is_active=false) to preserve
// history on existing job_variations that reference the type.
export class SettingsRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async createVariationType(input: VariationTypeInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("insert", id, {
      name: input.name,
      unit: input.unit,
      rate: input.rate,
      auto_approve: input.autoApprove,
      is_active: true,
    });
    return id;
  }

  /** Edit name/unit/rate/auto_approve. Preserve-on-update: is_active untouched. */
  async updateVariationType(id: string, input: VariationTypeInput): Promise<void> {
    await this.write("update", id, {
      name: input.name,
      unit: input.unit,
      rate: input.rate,
      auto_approve: input.autoApprove,
    });
  }

  async setVariationTypeActive(id: string, isActive: boolean): Promise<void> {
    await this.write("update", id, { is_active: isActive });
  }

  private async write(op: WriteOp, rowId: string, payload: Record<string, unknown>): Promise<void> {
    const write: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "variation_type",
      op,
      table: "variation_types",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
  }
}
