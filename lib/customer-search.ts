// Shared customer search, run in the database rather than over a full list
// held in the browser. Used by the Customers list page (server component) and
// components/customer-picker.tsx (browser client, as the user types).
//
// Each whitespace-separated word must match at least one of the given columns
// (one PostgREST or() per word; chained or() calls are AND-ed). That keeps a
// search like "smith acme" working across name and company, which the old
// client-side filters allowed by matching against all fields joined together.

/**
 * Words of a search box value, with characters stripped that would break a
 * PostgREST or() filter string (same set as app/dashboard/jobs/page.tsx).
 */
export function customerSearchTokens(q: string): string[] {
  return q
    .replace(/[,()%*\\"]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** One or() filter per word: `name.ilike.%word%,company.ilike.%word%,...` */
export function customerSearchFilters(q: string, columns: readonly string[]): string[] {
  return customerSearchTokens(q).map((t) => columns.map((c) => `${c}.ilike.%${t}%`).join(","));
}
