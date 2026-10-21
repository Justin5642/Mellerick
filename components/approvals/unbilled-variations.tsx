import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Receipt } from "lucide-react";
import { variationQtyText } from "@/lib/variation-qty";

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
    customer_id: string;
    customers: { name: string | null } | null;
    invoices?: { id: string; invoice_number: number; status: string }[] | null;
  } | null;
}

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

// "Variations to invoice": every approved variation that is not on an invoice
// yet, front and centre on Approvals (Justin, 20 Oct 2026). Grouped by job, so
// one Create invoice puts all of a job's variations on the bill
// (/dashboard/invoices/new?with_variations=1 adds them automatically). A job
// that already has an invoice links to it instead — the variation came in
// after the job was billed and needs adding there, or a follow-up invoice.
// The permanent QA job (HANDOVER §7 "QA fixture — do not delete") carries a
// probe variation that must never be invoiced.
export const isQaFixture = (v: { jobs?: { title?: string | null } | null }) => !!v.jobs?.title?.startsWith("QA FIXTURE");

export function UnbilledVariations({ variations: all }: { variations: UnbilledVariation[] }) {
  const variations = all.filter((v) => !isQaFixture(v));
  if (variations.length === 0) return null;

  const byJob = new Map<string, UnbilledVariation[]>();
  for (const v of variations) {
    if (!v.jobs) continue;
    const list = byJob.get(v.jobs.id) ?? [];
    list.push(v);
    byJob.set(v.jobs.id, list);
  }
  const total = variations.reduce((s, v) => s + Number(v.total_amount ?? 0), 0);

  return (
    <div id="unbilled-variations" className="space-y-3 scroll-mt-6">
      <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
        <Receipt className="w-4 h-4 text-emerald-600" />
        Variations to invoice ({variations.length}) · {money(total)}
      </h2>
      {Array.from(byJob.values()).map((list) => {
        const job = list[0].jobs!;
        const jobTotal = list.reduce((s, v) => s + Number(v.total_amount ?? 0), 0);
        const existing = (job.invoices ?? [])[0];
        const params = new URLSearchParams({
          job_id: job.id,
          customer_id: job.customer_id,
          title: `#${job.job_number} — ${job.title} (variations)`,
          with_variations: "1",
        });
        return (
          <Card key={job.id} className="border-emerald-100">
            <CardContent className="py-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/dashboard/jobs/${job.id}?tab=variations`} className="text-sm font-medium text-slate-800 hover:underline">
                    #{job.job_number} — {job.title}
                  </Link>
                  <p className="text-xs text-slate-500">{job.customers?.name ?? "—"}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-sm font-semibold tabular-nums">{money(jobTotal)}</span>
                  {existing ? (
                    <Link href={`/dashboard/invoices/${existing.id}`}>
                      <Button size="sm" variant="outline" className="text-xs">Open invoice #{existing.invoice_number} →</Button>
                    </Link>
                  ) : (
                    <Link href={`/dashboard/invoices/new?${params.toString()}`}>
                      <Button size="sm" className="text-xs">Create invoice →</Button>
                    </Link>
                  )}
                </div>
              </div>
              <ul className="space-y-0.5">
                {list.map((v) => {
                  const waited = daysSince(v.approved_at ?? v.logged_at);
                  return (
                    <li key={v.id} className="flex items-center justify-between gap-3 text-xs text-slate-600">
                      <span className="truncate">
                        {v.variation_types?.name ?? v.custom_name ?? "Variation"}
                        {variationQtyText(v) ? ` — ${variationQtyText(v)}` : ""}
                        {waited != null && <span className="text-slate-400"> · approved {waited === 0 ? "today" : `${waited} day${waited === 1 ? "" : "s"} ago`}</span>}
                      </span>
                      <span className="tabular-nums">{money(Number(v.total_amount ?? 0))}</span>
                    </li>
                  );
                })}
              </ul>
              {existing && (
                <p className="text-xs text-amber-700">
                  This job already has invoice #{existing.invoice_number} ({existing.status}). Add these to it if it hasn&apos;t
                  been sent, or create a separate invoice from the job page.
                </p>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
