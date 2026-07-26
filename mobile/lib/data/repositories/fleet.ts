import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface EquipmentInput {
  name: string;
  category: string; // vehicle | machinery | tool | other
  registration?: string | null;
  purchaseCost: number;
  purchaseDate?: string | null;
  estimatedLifeYears: number;
  insuranceAnnual: number;
  maintenanceAnnual: number;
  registrationAnnual: number;
  otherAnnualCosts: number;
  fuelCostPerHour: number;
  targetHoursPerYear: number;
  notes?: string | null;
}

// Offline-first write path for fleet/equipment (office/admin). All cost fields
// are money — rendered via MoneyText on the read side.
export class EquipmentRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async createEquipment(input: EquipmentInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("insert", id, { ...this.payload(input), is_active: true });
    return id;
  }

  async updateEquipment(id: string, input: EquipmentInput): Promise<void> {
    // Omit purchase_date — the mobile form doesn't manage it, and sending it
    // would UPDATE it to null and wipe a date set on the web. Preserve-on-update.
    const { purchase_date: _omit, ...patch } = this.payload(input);
    void _omit;
    await this.write("update", id, patch);
  }

  async deactivateEquipment(id: string): Promise<void> {
    await this.write("update", id, { is_active: false });
  }

  private payload(input: EquipmentInput): Record<string, unknown> {
    return {
      name: input.name,
      category: input.category,
      registration: input.registration ?? null,
      purchase_cost: input.purchaseCost,
      purchase_date: input.purchaseDate ?? null,
      estimated_life_years: input.estimatedLifeYears,
      insurance_annual: input.insuranceAnnual,
      maintenance_annual: input.maintenanceAnnual,
      registration_annual: input.registrationAnnual,
      other_annual_costs: input.otherAnnualCosts,
      fuel_cost_per_hour: input.fuelCostPerHour,
      target_hours_per_year: input.targetHoursPerYear,
      notes: input.notes ?? null,
    };
  }

  private async write(op: WriteOp, rowId: string, payload: Record<string, unknown>): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate: "equipment",
      op,
      table: "equipment",
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
