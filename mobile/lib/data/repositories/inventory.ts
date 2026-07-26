import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface InventoryInput {
  name: string;
  sku?: string | null;
  description?: string | null;
  category?: string | null;
  unit?: string | null;
  quantityOnHand: number;
  reorderLevel: number;
  unitCost: number;
  unitSell: number;
  supplier?: string | null;
}

// Offline-first write path for inventory (office/admin). unit_cost/unit_sell are
// dollar columns — rendered via MoneyText on the read side.
export class InventoryRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async createItem(input: InventoryInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("insert", id, { ...this.payload(input), is_active: true });
    return id;
  }

  async updateItem(id: string, input: InventoryInput): Promise<void> {
    await this.write("update", id, this.payload(input));
  }

  async deactivateItem(id: string): Promise<void> {
    await this.write("update", id, { is_active: false });
  }

  /** Quick stock adjustment without opening the full editor. */
  async adjustQuantity(id: string, quantityOnHand: number): Promise<void> {
    await this.write("update", id, { quantity_on_hand: quantityOnHand });
  }

  private payload(input: InventoryInput): Record<string, unknown> {
    return {
      name: input.name,
      sku: input.sku ?? null,
      description: input.description ?? null,
      category: input.category ?? null,
      unit: input.unit ?? "each",
      quantity_on_hand: input.quantityOnHand,
      reorder_level: input.reorderLevel,
      unit_cost: input.unitCost,
      unit_sell: input.unitSell,
      supplier: input.supplier ?? null,
    };
  }

  private async write(op: WriteOp, rowId: string, payload: Record<string, unknown>): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate: "inventory",
      op,
      table: "inventory",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return id;
  }
}
