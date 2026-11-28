export const dynamic = "force-dynamic";

import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { loadUnbilledWork } from "@/lib/unbilled-work-data";
import {
  filterAndSortUnbilled,
  groupUnbilled,
  parseUnbilledFilters,
  unbilledCsv,
  unbilledCustomers,
  unbilledTotals,
  KIND_LABELS,
  UNBILLED_KINDS,
  type UnbilledJob,
  type UnbilledKind,
} from "@/lib/unbilled-work";
import { DownloadCsvButton } from "@/components/reports/download-csv-button";
import { UnbilledJobCard } from "@/components/reports/unbilled-job-card";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, AlertTriangle } from "lucide-react";

// Reports → Unbilled work (Justin, 28 Nov 2026): everything done but not yet
// invoiced — signed Day Works lines, signed extra truck loads, approved
// variations, hours not on an invoice and builder POs not (fully) invoiced —
// grouped by job, with where each is invoiced. Office/admin only.
//
// Every read runs as the viewer (RLS decides). The one exception is the
// company cartage margin (billing_rate_config is admin-only by RLS), read with
// the service role after the role check below, as Invoice Day Works does.
// Rules in lib/unbilled-work.ts, reads in lib/unbilled-work-data.ts.

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function UnbilledWorkPage({ searchParams }: { searchParams: Promise<{ customer?: string; older?: string; sort?: string }> }) {
  const viewer = await getViewer();
  const role = viewer?.profile?.role;
  if (role !== "admin" && role !== "office") {
    return <div className="p-6 text-sm text-slate-500">The Unbilled work report is for the office.</div>;
  }
  const filters = parseUnbilledFilters(await searchParams);
  const today = dateKeyInBusinessTZ(new Date());

  const db = (await createClient()) as unknown as SupabaseClient;
  let loadError: string | null = null;
  let allJobs: UnbilledJob[] = [];
  let notes: { kind: UnbilledKind; text: string }[] = [];
  try {
    const loaded = await loadUnbilledWork(db, createAdminClient() as unknown as SupabaseClient);
    allJobs = groupUnbilled(loaded.items, loaded.jobs, today);
    notes = loaded.notes;
  } catch (err) {
    console.error("unbilled work report load failed:", err);
    loadError = "Couldn't load unbilled work. Refresh to try again.";
  }

  const customers = unbilledCustomers(allJobs);
  const shown = filterAndSortUnbilled(allJobs, filters);
  const totals = unbilledTotals(shown);
  const inputClass = "rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800";

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <div className="space-y-1">
        <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-4 h-4" /> Reports
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Unbilled work</h1>
        <p className="text-sm text-slate-500">
          Work that&apos;s done but not on an invoice yet: signed Day Works lines, signed extra truck loads, approved variations, hours on finished
          jobs and builder POs on completed jobs not fully invoiced. Amounts are ex GST; Day Works and truck loads are priced at today&apos;s rates,
          as Invoice Day Works prices them. Hours aren&apos;t priced until &ldquo;Apply hourly rate&rdquo; on the invoice, so they&apos;re shown
          in hours and not added to the totals.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Customer
          <select name="customer" defaultValue={filters.customerId ?? ""} className={inputClass}>
            <option value="">Every customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Older than (days)
          <input type="text" inputMode="numeric" name="older" defaultValue={filters.olderThanDays ?? ""} placeholder="Any" className={`${inputClass} w-24`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Sort
          <select name="sort" defaultValue={filters.sort} className={inputClass}>
            <option value="oldest">Oldest first</option>
            <option value="value">Biggest value first</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
          Show
        </button>
        <Link href="/dashboard/reports/unbilled" className="py-1.5 text-sm text-slate-500 hover:text-slate-800">
          Clear
        </Link>
      </form>

      {notes.map((n) => (
        <p key={n.kind + n.text} className="text-sm text-amber-700">
          <AlertTriangle className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
          {n.text}
        </p>
      ))}

      {loadError ? (
        <p className="text-sm text-red-600">{loadError}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-700">
              <span className="text-lg font-bold text-slate-900">{money(totals.total)}</span> across {totals.jobs} job{totals.jobs === 1 ? "" : "s"}
              {totals.oldestDays != null && ` · oldest ${totals.oldestDays} day${totals.oldestDays === 1 ? "" : "s"}`}
              {totals.hours > 0 && ` · plus ${totals.hours.toFixed(2)} h not yet priced`}
              {totals.unpriced > 0 && <span className="text-amber-700"> · {totals.unpriced} item{totals.unpriced === 1 ? "" : "s"} not priced</span>}
            </p>
            {shown.length > 0 && <DownloadCsvButton csv={unbilledCsv(shown, today)} fileName={`unbilled-work-${today}.csv`} />}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {UNBILLED_KINDS.map((k) => {
              const t = totals.byKind[k];
              return (
                <Card key={k}>
                  <CardContent className="p-3">
                    <p className="text-xs text-slate-500">{KIND_LABELS[k]}</p>
                    <p className="text-base font-semibold text-slate-900 tabular-nums">{k === "hours" ? `${t.hours.toFixed(2)} h` : money(t.total)}</p>
                    <p className="text-xs text-slate-400">
                      {t.items} item{t.items === 1 ? "" : "s"}
                      {t.unpriced > 0 && <span className="text-amber-700"> · {t.unpriced} not priced</span>}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {shown.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-slate-500">
                {allJobs.length === 0 ? "Nothing is waiting to be invoiced." : "Nothing matches these filters."}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {shown.map((j) => (
                <UnbilledJobCard key={j.jobId} job={j} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
