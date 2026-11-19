// "Variations to invoice" on the phone's Approvals screen — every approved
// variation not on an invoice yet, grouped by job (web
// components/approvals/unbilled-variations.tsx, Justin 20 Oct 2026). Office/admin
// only: the rows carry total_amount, so the screen lives in the (office) route
// group and renders every figure through MoneyText.

export interface UnbilledVariation {
  id: string;
  custom_name: string | null;
  variation_type_id: string | null;
  quantity: number | string | null;
  unit: string | null;
  total_amount: number | string | null;
  approved_at: string | null;
  logged_at: string | null;
  variation_types: { name: string } | null;
  jobs: {
    id: string;
    job_number: number;
    title: string;
    customer_id: string | null;
    customers: { name: string | null } | null;
    invoices?: { id: string; invoice_number: number; status: string }[] | null;
  } | null;
}

/** The same columns as the web Approvals page reads. */
export const UNBILLED_VARIATIONS_SELECT =
  "id, variation_type_id, custom_name, quantity, unit, total_amount, approved_at, logged_at, variation_types(name), jobs(id, job_number, title, customer_id, customers(name), invoices(id, invoice_number, status))";

/** The permanent QA job (HANDOVER §7) carries a probe variation that must never be invoiced. */
export const isQaFixture = (v: { jobs?: { title?: string | null } | null }) => !!v.jobs?.title?.startsWith("QA FIXTURE");

export interface UnbilledJobGroup {
  job: NonNullable<UnbilledVariation["jobs"]>;
  variations: UnbilledVariation[];
  total: number;
  /** The job's existing invoice, when it has one — the variation came in after it was billed. */
  existingInvoice: { id: string; invoice_number: number; status: string } | null;
}

export function groupUnbilledVariations(all: UnbilledVariation[]): { groups: UnbilledJobGroup[]; count: number; total: number } {
  const variations = all.filter((v) => !isQaFixture(v) && v.jobs);
  const byJob = new Map<string, UnbilledJobGroup>();
  for (const v of variations) {
    const job = v.jobs!;
    const g = byJob.get(job.id) ?? { job, variations: [], total: 0, existingInvoice: (job.invoices ?? [])[0] ?? null };
    g.variations.push(v);
    g.total += Number(v.total_amount ?? 0);
    byJob.set(job.id, g);
  }
  const groups = [...byJob.values()];
  return { groups, count: variations.length, total: groups.reduce((s, g) => s + g.total, 0) };
}

/** "3 m³" — or "" for a custom variation logged without a quantity (web lib/variation-qty.ts). */
export function variationQtyText(v: { variation_type_id?: string | null; quantity: number | string | null; unit?: string | null }): string {
  if (!v.variation_type_id && Number(v.quantity) === 1) return "";
  return `${v.quantity ?? ""} ${v.unit ?? ""}`.trim();
}

/** "approved today" / "approved 3 days ago". `now` is passed for tests. */
export function approvedAgo(v: Pick<UnbilledVariation, "approved_at" | "logged_at">, now: number = Date.now()): string | null {
  const iso = v.approved_at ?? v.logged_at;
  if (!iso) return null;
  const days = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
  return days === 0 ? "approved today" : `approved ${days} day${days === 1 ? "" : "s"} ago`;
}
