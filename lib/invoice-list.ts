// Shared by the invoices page (first page, server-rendered) and InvoiceList
// ("Load more", in the browser) so every page is the same shape and order.
// Kept out of the "use client" module: a server component importing a plain
// value from one gets a client reference, not the value.

export const INVOICE_PAGE_SIZE = 50;

// Only what a row renders.
export const INVOICE_LIST_COLUMNS = "id, invoice_number, title, due_date, total, status, customers(name)";

export type InvoiceListRow = {
  id: string;
  invoice_number: number | string;
  title: string | null;
  due_date: string | null;
  total: number | string | null;
  status: string;
  customers: { name: string | null } | null;
};
