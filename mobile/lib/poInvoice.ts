// Mirror of lib/po-invoice.ts for the phone: which builder PO an invoice is for, and invoicing one PO's value.
// Everything below the first blank line is byte-identical to the web file
// (pinned by tests/unit/invoice-phone-mirrors.test.ts) — change the web file
// first, then copy its body here.

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
