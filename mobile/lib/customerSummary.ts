// Pure rollup math for the customer-360 view — kept out of the reads layer so
// it's testable without a supabase mock. Mirrors the web customer detail's
// financial summary: total invoiced excludes cancelled invoices; outstanding is
// what's still owed (sent + overdue).
export interface CustomerInvoiceLike {
  total: number | null;
  status: string;
}

export function summarizeCustomerInvoices(invoices: CustomerInvoiceLike[]): { totalInvoiced: number; outstanding: number } {
  const totalInvoiced = invoices
    .filter((i) => i.status !== "cancelled")
    .reduce((s, i) => s + Number(i.total ?? 0), 0);
  const outstanding = invoices
    .filter((i) => i.status === "sent" || i.status === "overdue")
    .reduce((s, i) => s + Number(i.total ?? 0), 0);
  return { totalInvoiced, outstanding };
}
