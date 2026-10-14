// Shared by the quotes page (first page, server-rendered) and QuoteList
// ("Load more", in the browser) so every page is the same shape and order.
// Kept out of the "use client" module for the same reason as
// lib/invoice-list.ts: a server component importing a plain value from one
// gets a client reference, not the value.

export const QUOTE_PAGE_SIZE = 50;

// Only what a row renders.
export const QUOTE_LIST_COLUMNS = "id, quote_number, title, created_at, total, status, customers(name)";

export type QuoteListRow = {
  id: string;
  quote_number: number | string;
  title: string | null;
  created_at: string;
  total: number | string | null;
  status: string;
  customers: { name: string | null } | null;
};
