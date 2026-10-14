// Shared by the pricing page (first page, server-rendered) and PricingList
// ("Load more", in the browser) so every page is the same shape and order.
// Kept out of the "use client" module for the same reason as
// lib/invoice-list.ts.

export const PRICING_PAGE_SIZE = 50;

// Only what a row renders.
export const PRICING_LIST_COLUMNS = "id, name, description, category, pricing_type, unit_price, unit";

export type PricingListRow = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricing_type: string;
  unit_price: number | string | null;
  unit: string | null;
};
