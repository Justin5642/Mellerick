export const dynamic = "force-dynamic";

import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { coverageByMonth, loadBills, unallocatedSummary } from "@/lib/unallocated-bills";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { AllocateBill } from "@/components/reports/allocate-bill";

// Supplier bills in Xero that cannot be traced to a job (Justin, 14 Nov 2026:
// "profit and loss per job hasn't been accurate"). The Monday email links here;
// this is where each bill is assigned to a job or marked overhead. Office/admin.
// Reads the Xero mirror and the office's allocations (draft migrations 0098 and
// 0099 — not applied until Justin applies them; this page says so until then).

const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const SHOWN = 100;

export default async function UnallocatedBillsPage() {
  const viewer = await getViewer();
  const role = viewer?.profile?.role;
  if (role !== "admin" && role !== "office") {
    return <div className="p-6 text-sm text-slate-500">Unallocated bills are for the office.</div>;
  }

  const supabase = await createClient();
  const loaded = await loadBills(supabase, 12);

  const back = (
    <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
      <ArrowLeft className="w-4 h-4" /> Reports
    </Link>
  );

  if (!loaded.ok) {
    return (
      <div className="p-6 space-y-3">
        {back}
        <h1 className="text-2xl font-bold text-slate-900">Unallocated bills</h1>
        <p className="text-sm text-slate-600">
          {loaded.tablesMissing
            ? "The Xero data tables have not been set up yet, so there is nothing to show. They need the database changes 0098 and 0099 applied, then one Xero sync."
            : "Could not load the bills. Try again shortly."}
        </p>
      </div>
    );
  }

  const coverage = coverageByMonth(loaded.bills);
  const summary = unallocatedSummary(loaded.bills);
  const shown = summary.bills.slice(0, SHOWN);

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        {back}
        <h1 className="text-2xl font-bold text-slate-900">Unallocated bills</h1>
        <p className="text-sm text-slate-500">
          Supplier bills in Xero with no job. Assign each to a job by its job number, or mark it overhead. Amounts are ex GST.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 max-w-md">
        <Card><CardContent className="p-4"><div className="text-xs text-slate-500">No job yet</div><div className="text-xl font-bold text-slate-900">{summary.count} bills</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-slate-500">Worth</div><div className="text-xl font-bold text-blue-600">{money(summary.total)}</div></CardContent></Card>
      </div>

      <Card>
        <CardContent className="p-4 space-y-2">
          <h2 className="font-semibold text-slate-900">How much spend traces to a job, by month</h2>
          {coverage.length === 0 ? (
            <p className="text-sm text-slate-500">No bills yet — run the first Xero sync.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="py-1 pr-4">Month</th><th className="pr-4">Billed</th><th className="pr-4">Made by app</th><th className="pr-4">Assigned</th><th className="pr-4">By reference</th><th className="pr-4">Overhead</th><th className="pr-4">No job</th><th>Traced</th>
                  </tr>
                </thead>
                <tbody>
                  {[...coverage].reverse().map((m) => (
                    <tr key={m.month} className="border-t border-slate-100">
                      <td className="py-1 pr-4 font-medium">{m.month}</td>
                      <td className="pr-4">{money(m.total)}</td>
                      <td className="pr-4">{money(m.byClass.crm)}</td>
                      <td className="pr-4">{money(m.byClass.manual)}</td>
                      <td className="pr-4">{money(m.byClass.referenced)}</td>
                      <td className="pr-4">{money(m.byClass.overhead)}</td>
                      <td className="pr-4 text-amber-700">{money(m.byClass.unallocated)}</td>
                      <td className="font-semibold">{m.tracedPct === null ? "—" : `${m.tracedPct}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-400">
            &ldquo;By reference&rdquo; means the bill&rsquo;s Xero reference has a PO or JOB number; it has not been checked against the job.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-3">
          <h2 className="font-semibold text-slate-900">Bills to assign (oldest first)</h2>
          {shown.length === 0 ? (
            <p className="text-sm text-slate-500">Every bill is allocated.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {shown.map((b) => (
                <li key={b.xero_invoice_id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <div className="font-medium text-slate-900">{b.contact_name ?? "Unknown supplier"} <span className="text-slate-400 font-normal">{b.invoice_number ?? ""}</span></div>
                    <div className="text-xs text-slate-500">{b.invoice_date ?? "no date"} · {money(b.sub_total)}{b.reference ? ` · ${b.reference}` : ""}</div>
                  </div>
                  <AllocateBill billId={b.xero_invoice_id} />
                </li>
              ))}
            </ul>
          )}
          {summary.count > SHOWN && <p className="text-xs text-slate-500">Showing the oldest {SHOWN} of {summary.count}. Assign some and reload for the rest.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
