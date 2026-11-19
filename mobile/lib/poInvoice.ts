// Mirror of lib/po-invoice.ts for the phone's PO tab (office/admin). Change the web
// file first, then copy its body here — tests/unit/builder-po-mirror.test.ts
// fails when the two differ in anything but comments.
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
