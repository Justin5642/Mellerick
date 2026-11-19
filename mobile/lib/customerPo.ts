// Mirror of lib/customer-po.ts for the phone: the customer PO number on New / Edit Invoice.
// Everything below the first blank line is byte-identical to the web file
// (pinned by tests/unit/invoice-phone-mirrors.test.ts) — change the web file
// first, then copy its body here.

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
