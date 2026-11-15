// Loads the POs and jobs a batch of supplier invoices (0103) could belong to,
// so lib/supplier-invoice-match.ts can decide. Used by the review page (as the
// signed-in office user) and the cost API (service role, after its guard).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ourPoNumbers } from "@/lib/supplier-invoice-refs";
import { jobNumbersIn, type JobCandidate, type MatchableInvoice, type PoCandidate } from "@/lib/supplier-invoice-match";

type Db = Pick<SupabaseClient, "from">;

const JOB_COLUMNS = "id, job_number, title, status, customers(name), sites(address_line1, suburb)";

type JobRow = {
  id: string;
  job_number: number;
  title: string;
  status: string;
  customers: { name: string } | { name: string }[] | null;
  sites: { address_line1: string; suburb: string } | { address_line1: string; suburb: string }[] | null;
};

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

export function toJobCandidate(r: JobRow): JobCandidate {
  const site = one(r.sites);
  return {
    id: r.id,
    job_number: r.job_number,
    title: r.title,
    status: r.status,
    customer_name: one(r.customers)?.name ?? null,
    address_line1: site?.address_line1 ?? null,
    suburb: site?.suburb ?? null,
  };
}

export class CandidateLoadError extends Error {}

/**
 * POs any invoice quotes; jobs by any number quoted (bare numbers included —
 * missing ones simply don't come back) plus the jobs of those POs; and, when
 * an invoice names a site, every open job (to match the address).
 */
export async function loadCandidates(db: Db, invoices: MatchableInvoice[]): Promise<{ pos: PoCandidate[]; jobs: JobCandidate[] }> {
  const poNumbers = [...new Set(invoices.flatMap((i) => ourPoNumbers(i.po_refs ?? [])))];
  const jobNumbers = [...new Set(invoices.flatMap((i) => jobNumbersIn(i).map((j) => j.n)))];
  const wantSites = invoices.some((i) => i.site_text);

  const [poRes, numRes, openRes] = await Promise.all([
    poNumbers.length
      ? db.from("vendor_orders").select("id, po_number, job_id, vendor_name, amount, status, invoice_number, xero_bill_id").in("po_number", poNumbers)
      : Promise.resolve({ data: [], error: null }),
    jobNumbers.length
      ? db.from("jobs").select(JOB_COLUMNS).in("job_number", jobNumbers)
      : Promise.resolve({ data: [], error: null }),
    wantSites
      ? db.from("jobs").select(JOB_COLUMNS).not("status", "in", "(completed,cancelled)").not("site_id", "is", null).limit(2000)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (poRes.error || numRes.error || openRes.error) throw new CandidateLoadError((poRes.error ?? numRes.error ?? openRes.error)!.message);

  const pos = (poRes.data ?? []) as PoCandidate[];
  const jobs = new Map<string, JobCandidate>();
  for (const r of [...(numRes.data ?? []), ...(openRes.data ?? [])] as JobRow[]) jobs.set(r.id, toJobCandidate(r));

  const missing = [...new Set(pos.map((p) => p.job_id))].filter((id) => !jobs.has(id));
  if (missing.length) {
    const res = await db.from("jobs").select(JOB_COLUMNS).in("id", missing);
    if (res.error) throw new CandidateLoadError(res.error.message);
    for (const r of (res.data ?? []) as JobRow[]) jobs.set(r.id, toJobCandidate(r));
  }
  return { pos, jobs: [...jobs.values()] };
}

export { JOB_COLUMNS };
export type { JobRow };
