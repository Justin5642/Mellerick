// Pure rollup math for the customer-360 view — kept out of the reads layer so
// it's testable without a supabase mock. Mirrors the web customer detail
// EXACTLY (app/dashboard/customers/[id]/page.tsx): total invoiced = the sum of
// ALL invoices (incl. cancelled); outstanding = anything not paid and not
// cancelled (so draft/sent/overdue all count as owed).
export interface CustomerInvoiceLike {
  total: number | null;
  status: string;
}

export function summarizeCustomerInvoices(invoices: CustomerInvoiceLike[]): { totalInvoiced: number; outstanding: number } {
  const totalInvoiced = invoices.reduce((s, i) => s + Number(i.total ?? 0), 0);
  const outstanding = invoices
    .filter((i) => i.status !== "paid" && i.status !== "cancelled")
    .reduce((s, i) => s + Number(i.total ?? 0), 0);
  return { totalInvoiced, outstanding };
}
