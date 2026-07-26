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

// equipment_expenses.category is CHECK-constrained to exactly these values.
export type EquipmentExpenseCategory = "service" | "repair" | "fuel" | "tyres" | "registration" | "insurance" | "other";

export interface EquipmentExpenseInput {
  equipmentId: string;
  loggedBy: string;
  category: EquipmentExpenseCategory;
  supplierName?: string | null;
  description?: string | null;
  invoiceNumber?: string | null;
  expenseDate?: string | null; // YYYY-MM-DD; omit → DB default current_date
  amount: number;
  gstAmount: number;
  receipt?: { localUri: string; ext?: string } | null;
}

// Equipment expense receipts share the web's private equipment-documents bucket.
const EQUIP_RECEIPT_BUCKET = "equipment-documents";

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

  /** Assign (or unassign, with null) equipment to a staff member. A vehicle
   * assigned to someone folds its $/hour into that person's loaded cost rate
   * (see costing/staff-efficiency). Preserve-on-update: only assigned_to. */
  async assignEquipment(id: string, assignedTo: string | null): Promise<void> {
    await this.write("update", id, { assigned_to: assignedTo });
  }

  // Log an actual dated spend against a vehicle/equipment item. With a receipt,
  // the object uploads to Storage first (attachmentPathField → receipt_storage_path),
  // key derived from the client rowId → idempotent replay. Same pattern as job
  // expenses (see JobBillingRepository.addExpense).
  async addEquipmentExpense(input: EquipmentExpenseInput): Promise<{ id: string; receiptStoragePath: string | null }> {
    const rowId = this.ids.newId();
    const receiptStoragePath = input.receipt ? `${input.equipmentId}/expense-${rowId}.${input.receipt.ext ?? "jpg"}` : null;
    const payload: Record<string, unknown> = {
      equipment_id: input.equipmentId,
      category: input.category,
      supplier_name: input.supplierName ?? null,
      description: input.description ?? null,
      invoice_number: input.invoiceNumber ?? null,
      amount: input.amount,
      gst_amount: input.gstAmount,
      logged_by: input.loggedBy,
    };
    if (input.expenseDate) payload.expense_date = input.expenseDate; // else DB default current_date
    if (input.receipt) {
      payload.bucket = EQUIP_RECEIPT_BUCKET; // transport-only; stripped before the row
      payload.receipt_storage_path = receiptStoragePath;
    }
    const op: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId,
      aggregate: "equipment_expense",
      op: "insert",
      table: "equipment_expenses",
      attachmentLocalPath: input.receipt ? input.receipt.localUri : undefined,
      attachmentPathField: input.receipt ? "receipt_storage_path" : undefined,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
    return { id: rowId, receiptStoragePath };
  }

  async removeEquipmentExpense(input: { id: string; receiptStoragePath?: string | null }): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (input.receiptStoragePath) {
      payload.bucket = EQUIP_RECEIPT_BUCKET;
      payload.receipt_storage_path = input.receiptStoragePath;
    }
    const op: WriteOperation = {
      kind: "write",
      id: this.ids.newId(),
      rowId: input.id,
      aggregate: "equipment_expense",
      op: "delete",
      table: "equipment_expenses",
      attachmentPathField: input.receiptStoragePath ? "receipt_storage_path" : undefined,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(op);
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
