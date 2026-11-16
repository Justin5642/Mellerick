/**
 * Who an invoice or quote is made out to (16 Nov 2026).
 *
 * A customer has `name` (the form's "Contact name", required) and `company`
 * (optional). Invoices, quotes and Xero used `name` alone, so a business
 * customer entered the natural way — Simon Buchanan at Landart Landscapes —
 * was invoiced to "Simon Buchanan", and the office swapped the fields to get
 * the business on the invoice. Now the company is billed when there is one,
 * with the person as "Attn:" underneath.
 */
type CustomerNames = { name?: string | null; company?: string | null };

export function billingName(c: CustomerNames | null | undefined): string {
  return (c?.company ?? "").trim() || (c?.name ?? "").trim();
}

/** The contact person, when the bill goes to a company under another name. */
export function attentionName(c: CustomerNames | null | undefined): string | null {
  const company = (c?.company ?? "").trim();
  const name = (c?.name ?? "").trim();
  if (!company || !name || company.toLowerCase() === name.toLowerCase()) return null;
  return name;
}
