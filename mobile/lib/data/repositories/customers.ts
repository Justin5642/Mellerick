import type { Outbox } from "../outbox/outbox";
import type { IdGen } from "../ids";
import type { WriteOp, WriteOperation, Aggregate } from "../outbox/types";
import { systemTime, type TimeSource } from "../time";

export interface CustomerInput {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  abn?: string | null;
  notes?: string | null;
}
export interface SiteInput {
  customerId: string;
  name: string;
  addressLine1: string;
  addressLine2?: string | null;
  suburb: string;
  state: string;
  postcode: string;
  notes?: string | null;
}

// Offline-first write path for customers + sites, via the durable outbox.
export class CustomersRepository {
  constructor(
    private outbox: Outbox,
    private ids: IdGen,
    private time: TimeSource = systemTime
  ) {}

  async createCustomer(input: CustomerInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("customer", "insert", "customers", id, this.customerPayload(input, true));
    return id;
  }

  async updateCustomer(id: string, input: CustomerInput): Promise<void> {
    await this.write("customer", "update", "customers", id, this.customerPayload(input, false));
  }

  /** Soft-delete: customers are deactivated, not hard-deleted. */
  async deactivateCustomer(id: string): Promise<void> {
    await this.write("customer", "update", "customers", id, { is_active: false });
  }

  async createSite(input: SiteInput): Promise<string> {
    const id = this.ids.newId();
    await this.write("site", "insert", "sites", id, this.sitePayload(input));
    return id;
  }

  async updateSite(id: string, input: SiteInput): Promise<void> {
    await this.write("site", "update", "sites", id, this.sitePayload(input));
  }

  async removeSite(id: string): Promise<void> {
    await this.write("site", "delete", "sites", id, {});
  }

  private customerPayload(input: CustomerInput, isNew: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      name: input.name,
      company: input.company ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      mobile: input.mobile ?? null,
      abn: input.abn ?? null,
      notes: input.notes ?? null,
    };
    if (isNew) payload.is_active = true;
    return payload;
  }

  private sitePayload(input: SiteInput): Record<string, unknown> {
    return {
      customer_id: input.customerId,
      name: input.name,
      address_line1: input.addressLine1,
      address_line2: input.addressLine2 ?? null,
      suburb: input.suburb,
      state: input.state,
      postcode: input.postcode,
      notes: input.notes ?? null,
    };
  }

  private async write(aggregate: Aggregate, op: WriteOp, table: string, rowId: string, payload: Record<string, unknown>): Promise<string> {
    const id = this.ids.newId();
    const write: WriteOperation = {
      kind: "write",
      id,
      rowId,
      aggregate,
      op,
      table,
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
