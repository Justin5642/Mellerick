// The customer's purchase order number (migration 0083: jobs.customer_po and
// invoices.customer_po). Builders pay by PO, so it goes on the invoice PDF, the
// email and the Xero reference.

/** The database allows 1–60 characters; blank means none (NULL, never ''). */
export const CUSTOMER_PO_MAX = 60;

export function normalizeCustomerPo(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ").slice(0, CUSTOMER_PO_MAX);
  return v === "" ? null : v;
}

/** "PO 4500123" — without doubling a "PO" the customer already put in it. */
export function customerPoLabel(po: string | null | undefined): string | null {
  const v = normalizeCustomerPo(po);
  if (!v) return null;
  return /^p\.?\s*o\b/i.test(v) ? v : `PO ${v}`;
}
