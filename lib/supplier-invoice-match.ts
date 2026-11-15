// Matching a supplier invoice (0103) to where its cost belongs. Pure — no
// database — so the page, the cost API and the tests all agree on the answer.
//
// In order of trust:
//   1. One of OUR supplier PO numbers (PO-1001 up, 0085) printed on it and that
//      PO exists → its cost goes on that PO (the same fields the job page's
//      "Enter supplier invoice" fills). Never also a job expense.
//   2. A job number — "Job 2542", "#2542", a builder PO "2542-3", or a bare
//      number that is not one of our POs → suggest a job expense on that job.
//   3. The delivery/site address naming exactly one open job's site → suggest
//      a job expense there.
// Anything else is "not matched" and the office types a PO or job number.

import { ourPoNumbers, supplierKey } from "@/lib/supplier-invoice-refs";

export interface MatchableInvoice {
  doc_kind: string | null;
  supplier_name: string | null;
  amount_ex_gst: number | string | null;
  po_refs: string[] | null;
  job_refs: string[] | null;
  site_text: string | null;
}

export interface JobCandidate {
  id: string;
  job_number: number;
  title: string;
  status: string;
  customer_name: string | null;
  address_line1: string | null;
  suburb: string | null;
}

export interface PoCandidate {
  id: string;
  po_number: string;
  job_id: string;
  vendor_name: string;
  amount: number | string;
  status: string;
  invoice_number: string | null;
  xero_bill_id: string | null;
}

export type Match =
  | { kind: "po"; po: PoCandidate; job: JobCandidate | null; notes: string[]; blocked: string | null }
  | { kind: "job"; job: JobCandidate; via: "job number" | "builder PO" | "site"; notes: string[]; blocked: string | null }
  | { kind: "none"; notes: string[] };

const CLOSED = new Set(["completed", "cancelled"]);

/** Job numbers an invoice quotes, most specific first. Bare numbers included — the caller checks they exist. */
export function jobNumbersIn(inv: Pick<MatchableInvoice, "po_refs" | "job_refs">): { n: number; via: "job number" | "builder PO" }[] {
  const out: { n: number; via: "job number" | "builder PO" }[] = [];
  const add = (n: number, via: "job number" | "builder PO") => {
    if (n > 0 && !out.some((o) => o.n === n)) out.push({ n, via });
  };
  for (const r of inv.job_refs ?? []) {
    const m = r.match(/\b(?:job|jb|j)\s*(?:no\.?|number)?\s*[#:-]?\s*(\d{3,6})\b/i) ?? r.match(/^\s*#?\s*(\d{3,6})\s*$/);
    if (m) add(Number(m[1]), "job number");
  }
  for (const r of inv.po_refs ?? []) {
    const job = r.match(/\b(?:job|jb|j)\s*(?:no\.?|number)?\s*[#:-]?\s*(\d{3,6})\b/i);
    if (job) { add(Number(job[1]), "job number"); continue; }
    const builder = r.match(/^\s*#?\s*(\d{3,6})\s*[-/]\s*\d{1,3}\s*$/);
    if (builder) { add(Number(builder[1]), "builder PO"); continue; }
    const bare = r.match(/^\s*#?\s*(\d{3,6})\s*$/);
    if (bare) add(Number(bare[1]), "job number");
  }
  return out;
}

const STREET_WORDS = new Set([
  "st", "street", "rd", "road", "ave", "av", "avenue", "dr", "drive", "ct", "court", "pl", "place", "cres", "crescent",
  "hwy", "highway", "pde", "parade", "tce", "terrace", "ln", "lane", "cl", "close", "blvd", "boulevard", "way", "cct", "circuit",
  "unit", "lot", "shop", "level", "the",
]);

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s/-]/g, " ").split(/[\s/-]+/).filter(Boolean);

/**
 * Does free text name this site? Needs the street number AND the first word
 * of the street name ("12 Smith St" ← "12 SMITH STREET, SUBURB"); a suburb
 * alone never counts — too many jobs share one.
 */
export function siteMentioned(text: string | null, address: string | null): boolean {
  if (!text || !address) return false;
  const addr = words(address);
  const num = addr.find((w) => /^\d+[a-z]?$/.test(w));
  const name = addr.find((w) => /^[a-z]{3,}$/.test(w) && !STREET_WORDS.has(w));
  if (!num || !name) return false;
  const got = new Set(words(text));
  return got.has(num) && got.has(name);
}

/** "Reece Pty Ltd" vs "Reece Plumbing": one name's key contains the other's. */
export function sameSupplier(a: string | null, b: string | null): boolean {
  const x = supplierKey(a), y = supplierKey(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function matchInvoice(
  inv: MatchableInvoice,
  pos: PoCandidate[],
  jobs: JobCandidate[]
): Match {
  if (inv.doc_kind !== "invoice" && inv.doc_kind !== "credit_note") return { kind: "none", notes: [] };
  const amount = Number(inv.amount_ex_gst ?? 0);
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  const jobNotes = (job: JobCandidate) => (CLOSED.has(job.status) ? [`Job #${job.job_number} is ${job.status}.`] : []);

  // 1. Our PO.
  // A bare "2542" could be a PO or a job once PO numbers reach the job range,
  // so a number printed without "PO" only counts as our PO when the supplier
  // is the one the PO went to.
  const saidPo = new Set(ourPoNumbers((inv.po_refs ?? []).filter((r) => /p\.?\s*o/i.test(r))));
  if (inv.doc_kind === "invoice") {
    for (const poNumber of ourPoNumbers(inv.po_refs ?? [])) {
      const po = pos.find((p) => p.po_number.toUpperCase() === poNumber);
      if (!po) continue;
      if (!saidPo.has(poNumber) && !sameSupplier(inv.supplier_name, po.vendor_name)) continue;
      const job = jobById.get(po.job_id) ?? null;
      const notes: string[] = [];
      let blocked: string | null = null;
      if (po.status === "cancelled") blocked = `${po.po_number} was cancelled.`;
      else if (po.xero_bill_id) blocked = `${po.po_number} is already a bill in Xero.`;
      else if (po.invoice_number) blocked = `${po.po_number} already has invoice ${po.invoice_number}.`;
      const poAmount = Number(po.amount) || 0;
      if (poAmount > 0 && Math.abs(amount - poAmount) > Math.max(20, poAmount * 0.1)) {
        notes.push(`PO was raised for ${money(poAmount)}; invoice is ${money(amount)}.`);
      }
      if (inv.supplier_name && !sameSupplier(inv.supplier_name, po.vendor_name)) {
        notes.push(`PO is to ${po.vendor_name}, invoice is from ${inv.supplier_name}.`);
      }
      if (job) notes.push(...jobNotes(job));
      return { kind: "po", po, job, notes, blocked };
    }
  }

  // 2. A job number.
  const byNumber = new Map(jobs.map((j) => [j.job_number, j]));
  for (const { n, via } of jobNumbersIn(inv)) {
    const job = byNumber.get(n);
    if (job) return { kind: "job", job, via, notes: jobNotes(job), blocked: null };
  }

  // 3. The site — only open jobs, and only when exactly one fits.
  if (inv.site_text) {
    const open = jobs.filter((j) => !CLOSED.has(j.status) && siteMentioned(inv.site_text, j.address_line1));
    const siteIds = new Set(open.map((j) => `${j.address_line1}|${j.suburb}`.toLowerCase()));
    if (open.length === 1) return { kind: "job", job: open[0], via: "site", notes: [], blocked: null };
    if (open.length > 1 && siteIds.size === 1) {
      return { kind: "none", notes: [`${open.length} open jobs at this site: ${open.map((j) => `#${j.job_number}`).join(", ")}. Pick one.`] };
    }
  }

  return { kind: "none", notes: [] };
}

/**
 * What the office typed into "PO or job number": "PO-1008", "po 1008",
 * "#2542", "2542". A PO number wins when it exists; otherwise a job number.
 */
export function parseTarget(text: string): { po: string | null; job: number | null } {
  const t = text.trim();
  const po = ourPoNumbers([t])[0] ?? null;
  const m = t.match(/^\s*(?:job\s*)?#?\s*(\d{1,6})\s*$/i);
  const explicitPo = /p\.?\s*o/i.test(t);
  return { po, job: m && !explicitPo ? Number(m[1]) : null };
}
