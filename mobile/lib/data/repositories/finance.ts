import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation, Aggregate } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

// GST is hard-coded 10% across the web app (the invoices.tax_rate column exists
// but is ignored). Mirror that exactly so totals match.
export const GST_RATE = 0.1;

export interface LineItemInput {
  name: string;
  description?: string | null;
  quantity: number;
  unitPrice: number;
}

// Pure totals math — identical to the web (subtotal = Σ qty*unit; gst = 10%).
// The DB computes invoice_items.total as a GENERATED column, so we never send
// per-line totals; the client value is display-only until the row round-trips.
export function computeTotals(items: LineItemInput[]): { subtotal: number; gst: number; total: number } {
  const subtotal = items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
  const gst = subtotal * GST_RATE;
  return { subtotal, gst, total: subtotal + gst };
}

export interface CreateInvoiceInput {
  customerId: string;
  jobId?: string | null;
  title: string;
  dueDateIso?: string | null;
  notes?: string | null;
  workDescription?: string | null;
  items: LineItemInput[];
  /** Create-from-job reconciliation (requires jobId): mark these approved
   * variations billed (set their invoice_id) and clear the job's
   * ready_to_invoice flag so it drops off the queue — mirrors the web
   * invoices/new "create from job" flow. */
  reconcile?: { markVariationIds: string[] } | null;
}
export interface EditInvoiceInput {
  invoiceId: string;
  title: string;
  dueDateIso?: string | null;
  notes?: string | null;
  workDescription?: string | null;
  /** Ids of the invoice_items currently on the invoice — deleted then replaced. */
  existingItemIds: string[];
  items: LineItemInput[];
}
export interface CreateQuoteInput {
  customerId: string;
  title: string;
  validUntilIso?: string | null;
  notes?: string | null;
  items: LineItemInput[];
}
export interface EditQuoteInput {
  quoteId: string;
  title: string;
  validUntilIso?: string | null;
  notes?: string | null;
  existingItemIds: string[];
  items: LineItemInput[];
}
export interface PricingItemInput {
  name: string;
  description?: string | null;
  category: string;
  pricingType: string;
  unitPrice: number;
  unit?: string | null;
}

// Offline-first write path for the financial builders. Every mutation is a
// durable outbox operation (ordered + retried). A created invoice/quote starts
// in "draft" and its line items depend on the parent row, so a partial failure
// leaves a safe draft rather than a live document with missing items — the
// mitigation Avi chose over the web's non-transactional client-side
// delete-reinsert. FLAGGED (Justin): an atomic Postgres RPC is the true fix.
export class FinanceRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  // ----- invoices -----
  async createInvoice(input: CreateInvoiceInput): Promise<string> {
    const invoiceId = this.ids.newId();
    const { subtotal, gst, total } = computeTotals(input.items);
    const parentOp = await this.write("invoice", "insert", "invoices", invoiceId, {
      customer_id: input.customerId,
      job_id: input.jobId ?? null,
      title: input.title,
      due_date: input.dueDateIso ?? null,
      notes: input.notes ?? null,
      work_description: input.workDescription ?? null,
      subtotal,
      tax_amount: gst,
      total,
      status: "draft",
    });
    await this.insertItems("invoice", "invoice_items", "invoice_id", invoiceId, input.items, parentOp);
    // Create-from-job reconciliation: mark the pulled-in variations billed and
    // clear the job's ready_to_invoice, both gated on the invoice row landing
    // first (so a partial failure never marks a variation billed against a
    // non-existent invoice). Only runs when a jobId + reconcile were supplied.
    if (input.jobId && input.reconcile) {
      for (const vid of input.reconcile.markVariationIds) {
        await this.write("job_variation", "update", "job_variations", vid, { invoice_id: invoiceId }, parentOp);
      }
      await this.write("job", "update", "jobs", input.jobId, { ready_to_invoice: false }, parentOp);
    }
    return invoiceId;
  }

  async editInvoice(input: EditInvoiceInput): Promise<void> {
    const { subtotal, gst, total } = computeTotals(input.items);
    // NOTE: work_description is intentionally NOT in this payload — the mobile
    // edit form doesn't manage it, and including it would UPDATE it to null and
    // wipe a customer-facing "Work Carried Out" set on the web. Preserve-on-update.
    const parentOp = await this.write("invoice", "update", "invoices", input.invoiceId, {
      title: input.title,
      due_date: input.dueDateIso ?? null,
      notes: input.notes ?? null,
      subtotal,
      tax_amount: gst,
      total,
    });
    // delete-all-then-reinsert (matches web) — but ordered + durable via the
    // outbox, both gated on the parent update so they never run before it.
    for (const oldId of input.existingItemIds) {
      await this.write("invoice", "delete", "invoice_items", oldId, {}, parentOp);
    }
    await this.insertItems("invoice", "invoice_items", "invoice_id", input.invoiceId, input.items, parentOp);
  }

  // ----- quotes -----
  async createQuote(input: CreateQuoteInput): Promise<string> {
    const quoteId = this.ids.newId();
    const { subtotal, gst, total } = computeTotals(input.items);
    const parentOp = await this.write("quote", "insert", "quotes", quoteId, {
      customer_id: input.customerId,
      title: input.title,
      valid_until: input.validUntilIso ?? null,
      notes: input.notes ?? null,
      subtotal,
      tax_amount: gst,
      total,
      status: "draft",
    });
    await this.insertItems("quote", "quote_items", "quote_id", quoteId, input.items, parentOp);
    return quoteId;
  }

  async editQuote(input: EditQuoteInput): Promise<void> {
    const { subtotal, gst, total } = computeTotals(input.items);
    const parentOp = await this.write("quote", "update", "quotes", input.quoteId, {
      title: input.title,
      valid_until: input.validUntilIso ?? null,
      notes: input.notes ?? null,
      subtotal,
      tax_amount: gst,
      total,
    });
    for (const oldId of input.existingItemIds) {
      await this.write("quote", "delete", "quote_items", oldId, {}, parentOp);
    }
    await this.insertItems("quote", "quote_items", "quote_id", input.quoteId, input.items, parentOp);
  }

  /** Accept / decline / re-open a quote (direct status update — mobile-doable). */
  async setQuoteStatus(quoteId: string, status: "draft" | "sent" | "accepted" | "declined"): Promise<void> {
    await this.write("quote", "update", "quotes", quoteId, { status });
  }

  // ----- pricing catalogue -----
  async createPricingItem(input: PricingItemInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("pricing_item", "insert", "pricing_items", id, {
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      pricing_type: input.pricingType,
      unit_price: input.unitPrice,
      unit: input.unit ?? "each",
      is_active: true,
    });
    return id;
  }

  async updatePricingItem(id: string, input: PricingItemInput): Promise<void> {
    await this.write("pricing_item", "update", "pricing_items", id, {
      name: input.name,
      description: input.description ?? null,
      category: input.category,
      pricing_type: input.pricingType,
      unit_price: input.unitPrice,
      unit: input.unit ?? "each",
    });
  }

  /** Soft-delete: catalogue items are deactivated, not hard-deleted. */
  async deactivatePricingItem(id: string): Promise<void> {
    await this.write("pricing_item", "update", "pricing_items", id, { is_active: false });
  }

  /** Restore a previously-deactivated catalogue item. */
  async reactivatePricingItem(id: string): Promise<void> {
    await this.write("pricing_item", "update", "pricing_items", id, { is_active: true });
  }

  private async insertItems(
    aggregate: Aggregate,
    table: string,
    parentKey: string,
    parentId: string,
    items: LineItemInput[],
    dependsOn: string
  ): Promise<void> {
    for (const item of items) {
      await this.write(
        aggregate,
        "insert",
        table,
        this.ids.newId(),
        {
          [parentKey]: parentId,
          name: item.name,
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          // total is a DB GENERATED column — never sent.
        },
        dependsOn
      );
    }
  }

  private async write(
    aggregate: Aggregate,
    op: WriteOp,
    table: string,
    rowId: string,
    payload: Record<string, unknown>,
    dependsOn?: string
  ): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate,
      op,
      table,
      payload,
      dependsOn: dependsOn ?? null,
      status: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: this.time.nowMs(),
    };
    await this.outbox.enqueue(write);
    return id;
  }
}
