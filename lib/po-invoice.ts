// "Invoice this PO" (Justin, 16 Nov 2026): one job can carry several builder
// POs (e.g. Sewer and Stormwater done the same day) — the figures stay
// together on the job, but each PO is invoiced to the builder separately.
// These are the starting line items for one PO's invoice, ex GST: one line per
// priced cost-centre line when they add up to the PO's value, otherwise one
// line for the PO's value. The office can still edit everything.

export interface PoForInvoice {
  po_number: string;
  total_value: number;
  lines: { name: string; allocated_amount: number | null; sort_order?: number | null }[];
}

export interface InvoiceLineDraft {
  name: string;
  description: string;
  quantity: string;
  unit_price: string;
}

const cents = (n: number) => Math.round(n * 100);

export function poInvoiceLines(po: PoForInvoice): InvoiceLineDraft[] {
  const value = Number(po.total_value) || 0;
  const priced = [...po.lines]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .filter((l) => Number(l.allocated_amount) > 0);
  const sum = priced.reduce((s, l) => s + cents(Number(l.allocated_amount)), 0);
  if (priced.length > 0 && sum === cents(value)) {
    return priced.map((l) => ({
      name: l.name,
      description: `PO ${po.po_number}`,
      quantity: "1",
      unit_price: (Number(l.allocated_amount)).toFixed(2),
    }));
  }
  return [{ name: `PO ${po.po_number}`, description: "", quantity: "1", unit_price: value.toFixed(2) }];
}

// Which builder PO an invoice is for (1 Nov 2026): only POs with a value are
// offered, and the picker shows only when the job has more than one.

export interface JobPo {
  id: string;
  po_number: string;
  total_value: number | string | null;
}

/** The job's POs that carry a value, in the order given. */
export function pricedPos<T extends JobPo>(pos: T[]): T[] {
  return pos.filter((p) => Number(p.total_value) > 0);
}

/** The PO whose number is on the invoice (customer_po), if it is one of these. */
export function poForCustomerPo<T extends JobPo>(pos: T[], customerPo: string | null | undefined): T | null {
  const v = (customerPo ?? "").trim();
  return v ? pos.find((p) => p.po_number === v) ?? null : null;
}

/** A progress claim is against one PO only when the job has a choice of them. */
export function claimBuilderPo(pos: JobPo[], picked: JobPo | null): { poNumber: string; value: number } | null {
  return pos.length > 1 && picked ? { poNumber: picked.po_number, value: Number(picked.total_value) } : null;
}

// Has this PO been invoiced? (Emma, 25 Nov 2026: the sewer PO for Lot 827 was
// invoiced and pushed to Xero, yet the job still offered it to invoice.) An
// invoice is against a PO when its customer_po is the PO's number — "Invoice
// this PO" and the New Invoice PO picker both set it. Cancelled invoices don't
// count. Progress claims add up: "part" until the claims reach the PO's value,
// then "full". Figures are ex GST on both sides (invoice subtotal, PO value).

export interface PoInvoiceRef {
  id: string;
  invoice_number: string | number | null;
  subtotal: number | string | null;
  status: string | null;
  customer_po: string | null;
}

export interface PoInvoiceState {
  status: "none" | "part" | "full";
  invoiced: number;
  remaining: number;
  invoices: PoInvoiceRef[];
}

const samePo = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() !== "" && (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** How much of one PO's value is already on invoices. */
export function poInvoiceState(po: JobPo, invoices: PoInvoiceRef[]): PoInvoiceState {
  const mine = invoices.filter((i) => i.status !== "cancelled" && samePo(i.customer_po, po.po_number));
  const invoicedCents = mine.reduce((s, i) => s + cents(Number(i.subtotal) || 0), 0);
  const valueCents = cents(Number(po.total_value) || 0);
  const status: PoInvoiceState["status"] =
    mine.length === 0 ? "none" : valueCents <= 0 || invoicedCents >= valueCents ? "full" : "part";
  return {
    status,
    invoiced: invoicedCents / 100,
    remaining: Math.max(0, valueCents - invoicedCents) / 100,
    invoices: mine,
  };
}
