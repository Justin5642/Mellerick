export const dynamic = "force-dynamic";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SupplierInvoiceUpload } from "@/components/supplier-invoices/supplier-invoice-upload";
import { SupplierInvoiceReview, type CostedLabel, type SupplierInvoiceRow } from "@/components/supplier-invoices/supplier-invoice-review";
import { loadCandidates } from "@/lib/supplier-invoice-candidates";
import { matchInvoice, type Match } from "@/lib/supplier-invoice-match";

// Supplier invoices dropped in by the office (0103), matched to their PO or
// job and costed from here. Under Supplier POs so it inherits that page's
// office-only rule (lib/nav-items.ts) — RLS on supplier_invoices is the real
// boundary.
//
// Anything still waiting (read or failed) shows however old it is; costed and
// dismissed ones drop off after 30 days.
export default async function SupplierInvoicesPage() {
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("supplier_invoices")
    .select("*")
    .or(`status.in.(read,failed),created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .order("index_in_file", { ascending: true })
    .limit(500);
  if (error) console.error("supplier invoices load failed:", error.message);
  const rows = (data ?? []) as SupplierInvoiceRow[];

  // Match what's waiting.
  const waiting = rows.filter((r) => r.status === "read" && !r.duplicate_of);
  const matches: Record<string, Match> = {};
  let matchFailed = false;
  if (waiting.length) {
    try {
      const { pos, jobs } = await loadCandidates(supabase, waiting);
      for (const r of waiting) matches[r.id] = matchInvoice(r, pos, jobs);
    } catch (e) {
      matchFailed = true;
      console.error("supplier invoice matching failed:", e instanceof Error ? e.message : e);
    }
  }

  // Where the costed ones went.
  const costed = rows.filter((r) => r.status === "costed");
  const costedLabels: Record<string, CostedLabel> = {};
  if (costed.length) {
    const jobIds = [...new Set(costed.map((r) => r.job_id).filter((x): x is string => !!x))];
    const poIds = [...new Set(costed.map((r) => r.vendor_order_id).filter((x): x is string => !!x))];
    const [jobsRes, posRes] = await Promise.all([
      jobIds.length ? supabase.from("jobs").select("id, job_number").in("id", jobIds) : Promise.resolve({ data: [] as { id: string; job_number: number }[] }),
      poIds.length ? supabase.from("vendor_orders").select("id, po_number").in("id", poIds) : Promise.resolve({ data: [] as { id: string; po_number: string }[] }),
    ]);
    const jobNo = new Map((jobsRes.data ?? []).map((j) => [j.id, j.job_number]));
    const poNo = new Map((posRes.data ?? []).map((p) => [p.id, p.po_number]));
    for (const r of costed) {
      costedLabels[r.id] = {
        job: r.job_id && jobNo.has(r.job_id) ? `Job #${jobNo.get(r.job_id)}` : null,
        po: r.vendor_order_id ? poNo.get(r.vendor_order_id) ?? null : null,
      };
    }
  }

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-center gap-3">
        <Link prefetch={false} href="/dashboard/supplier-pos">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500"><ArrowLeft className="w-4 h-4" />Supplier POs</Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Supplier invoices</h1>
      </div>
      <SupplierInvoiceUpload />
      {error ? (
        <p className="text-sm text-red-600">The list of invoices could not be loaded. Reload the page.</p>
      ) : (
        <SupplierInvoiceReview rows={rows} matches={matches} costedLabels={costedLabels} matchFailed={matchFailed} />
      )}
    </div>
  );
}
