import { customerPoLabel } from "@/lib/customer-po";

// The job site printed on invoices and quotes (PDF, invoice page, Xero
// reference). Invoices only carried the customer before (Justin, 21 Oct 2026:
// "it's dropping the job address off") — builders pay by lot, so the site is
// how they match our bill to their job.
//
// Unlike lib/geocode.ts siteAddress, unit/lot prefixes are kept: "Lot 2, 9 Pony
// Promenade" is exactly what the customer needs to see.

export interface JobSiteParts {
  name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
}

export interface JobSite {
  jobNumber?: number | null;
  lines: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Address lines for a site: [name if it adds anything, street, line 2, "Suburb VIC 3000"]. */
export function siteLines(site: JobSiteParts | null | undefined): string[] {
  if (!site) return [];
  const street = site.address_line1?.trim() ?? "";
  const line2 = site.address_line2?.trim() ?? "";
  const locality = [site.suburb?.trim(), site.state?.trim(), site.postcode?.trim()].filter(Boolean).join(" ");
  const name = site.name?.trim() ?? "";
  // Simpro site names are usually the address again; show the name only when it
  // adds something ("Melton highway and Calder Park Drive", "McDonald's - Sydenham").
  const n = norm(name);
  const showName = !!n && !norm(`${street}${line2}${locality}`).includes(n);
  // Some imported sites carry the whole address in line 1 ("3 Muir Way, Mernda
  // VIC 3754"); don't print the suburb twice.
  const localityRepeated = !!locality && norm(`${street}${line2}`).includes(norm(locality));
  return [showName ? name : "", street, line2, localityRepeated ? "" : locality].filter(Boolean);
}

/** One line, for the Xero reference: "Lot 2, 9 Pony Promenade, Seymour VIC 3660". */
export function siteOneLine(site: JobSiteParts | null | undefined): string {
  return siteLines(site).join(", ");
}

type Embedded<T> = T | T[] | null | undefined;
const one = <T,>(v: Embedded<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/**
 * The site for an invoice row fetched with INVOICE_SITE_SELECT: the job's
 * site, else the site of the quote it came from. null when neither has one.
 */
export function invoiceJobSite(invoice: {
  jobs?: Embedded<{ job_number?: number | null; sites?: Embedded<JobSiteParts> }>;
  quotes?: Embedded<{ sites?: Embedded<JobSiteParts> }>;
}): JobSite | null {
  const job = one(invoice.jobs);
  const site = one(job?.sites) ?? one(one(invoice.quotes)?.sites);
  const lines = siteLines(site);
  if (lines.length === 0 && !job?.job_number) return null;
  return { jobNumber: job?.job_number ?? null, lines };
}

const SITE_COLS = "name, address_line1, address_line2, suburb, state, postcode";
/** Embed for an invoices select: the job (number + site) and the quote's site. */
export const INVOICE_SITE_SELECT = `jobs(job_number, sites(${SITE_COLS})), quotes(sites(${SITE_COLS}))`;
/** Embed for a quotes select. */
export const QUOTE_SITE_SELECT = `sites(${SITE_COLS}), jobs(job_number)`;

/** The site for a quote row fetched with QUOTE_SITE_SELECT. */
export function quoteJobSite(quote: {
  sites?: Embedded<JobSiteParts>;
  jobs?: Embedded<{ job_number?: number | null }>;
}): JobSite | null {
  const lines = siteLines(one(quote.sites));
  const jobNumber = one(quote.jobs)?.job_number ?? null;
  if (lines.length === 0 && !jobNumber) return null;
  return { jobNumber, lines };
}

/**
 * Xero invoice reference: "PO 4500123 · Claim 2 · Job #546 · Lot 2, 9 Pony Promenade,
 * Seymour VIC 3660" (Xero's limit is 255). The customer's PO goes first — it is
 * what their accounts team matches the bill on (0083).
 */
export function xeroReference(site: JobSite | null, customerPo?: string | null, claimNumber?: number | null): string | undefined {
  const parts = [
    customerPoLabel(customerPo) ?? "",
    claimNumber ? `Claim ${claimNumber}` : "",
    site?.jobNumber ? `Job #${site.jobNumber}` : "",
    site?.lines.join(", ") ?? "",
  ].filter(Boolean);
  const ref = parts.join(" · ");
  return ref ? ref.slice(0, 255) : undefined;
}
