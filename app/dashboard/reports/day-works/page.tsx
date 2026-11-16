export const dynamic = "force-dynamic";

import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { businessDateParts } from "@/lib/date";
import {
  cellAmount,
  dayWorksByMonth,
  dayWorksJobsForMonth,
  isMonthKey,
  lastMonths,
  monthLabel,
  parseReportView,
  type ReportCell,
  type ReportEntry,
  type ReportView,
} from "@/lib/day-works-report";
import type { HireAttachmentRate, HireOption } from "@/lib/hire-pricing";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, AlertTriangle } from "lucide-react";

// Reports → Day Works (Day Works next stages, item 5, first half; Nov 2026).
// Day Works / hire revenue by company cost centre per month for the last 12
// months, and one month job by job. Office/admin: it reads the rate tables
// (equipment_hire_options, hire_attachments — office-only by RLS), so it runs
// under the viewer's own session; no service role. Sums in
// lib/day-works-report.ts, priced by lib/hire-pricing.ts at CURRENT rates.
// Without migration 0108 it says Day Works isn't switched on.

const MISSING_TABLE = new Set(["42P01", "PGRST205", "PGRST200"]);
const CHUNK = 100;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;

const VIEWS: { value: ReportView; label: string }[] = [
  { value: "all", label: "Signed + invoiced" },
  { value: "signed", label: "Signed, not invoiced" },
  { value: "invoiced", label: "Invoiced" },
];

type RawEntry = Omit<ReportEntry, "attachment_ids"> & { hire_entry_attachments: { attachment_id: string }[] | null };
type JobRow = { id: string; job_number: number; title: string; customers: { name: string } | null };

export default async function DayWorksReportPage({ searchParams }: { searchParams: Promise<{ view?: string; month?: string }> }) {
  const viewer = await getViewer();
  const role = viewer?.profile?.role;
  if (role !== "admin" && role !== "office") {
    return <div className="p-6 text-sm text-slate-500">The Day Works report is for the office.</div>;
  }
  const params = await searchParams;
  const view = parseReportView(params.view);

  const now = businessDateParts();
  const months = lastMonths(`${now.year}-${String(now.month).padStart(2, "0")}`, 12);
  const from = `${months[months.length - 1]}-01`;

  const back = (
    <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
      <ArrowLeft className="w-4 h-4" /> Reports
    </Link>
  );
  const header = (
    <div className="space-y-1">
      {back}
      <h1 className="text-2xl font-bold text-slate-900">Day Works</h1>
      <p className="text-sm text-slate-500">
        Hire and cartage charged as Day Works, by cost centre, for the last 12 months. Amounts are ex GST. Drafts are not counted as
        revenue until the builder signs; void lines are left out.
      </p>
    </div>
  );

  const supabase = await createClient();
  let ready = true;
  let loadError: string | null = null;
  let entries: ReportEntry[] = [];
  let options: HireOption[] = [];
  let attachments: HireAttachmentRate[] = [];
  let centres: { id: string; name: string }[] = [];
  try {
    const [optionsRes, attachmentsRes, centresRes] = await Promise.all([
      supabase.from("equipment_hire_options").select("equipment_id, hire_type, hire_unit, rate, whole_days_only, float_base, float_km_included, float_per_km, cost_centre_id"),
      supabase.from("hire_attachments").select("id, name, day_rate"),
      supabase.from("cost_centres").select("id, name").order("sort_order").order("name"),
    ]);
    if ([optionsRes, attachmentsRes].some((r) => r.error && MISSING_TABLE.has(r.error.code ?? ""))) {
      ready = false;
    } else {
      for (const r of [optionsRes, attachmentsRes, centresRes]) if (r.error) throw new Error(r.error.message);
      const entriesRes = await fetchAllRows<RawEntry>((count) =>
        supabase
          .from("hire_entries")
          .select("id, job_id, equipment_id, hire_type, hire_unit, work_date, hours, days, meter_open, meter_close, km, status, cost_centre_id, hire_entry_attachments(attachment_id)", count)
          .gte("work_date", from)
          .neq("status", "void")
          .order("id") as never
      );
      if (!entriesRes.ok) throw new Error(entriesRes.error);
      entries = entriesRes.rows.map(({ hire_entry_attachments, ...e }) => ({ ...e, attachment_ids: (hire_entry_attachments ?? []).map((a) => a.attachment_id) }));
      options = (optionsRes.data ?? []) as HireOption[];
      attachments = (attachmentsRes.data ?? []) as HireAttachmentRate[];
      centres = (centresRes.data ?? []) as { id: string; name: string }[];
    }
  } catch (err) {
    console.error("day works report load failed:", err);
    loadError = "Couldn't load the Day Works report. Refresh to try again.";
  }

  if (!ready) {
    return (
      <div className="p-6 space-y-3">
        {header}
        <p className="text-sm text-slate-600">Day Works isn&apos;t switched on yet — the database update for it still has to be applied.</p>
      </div>
    );
  }

  const report = dayWorksByMonth({ entries, options, attachments, centres, months });
  const monthHasAny = (m: string) => !!report.monthTotals[m];
  const month = isMonthKey(params.month) && months.includes(params.month) ? params.month : (months.find(monthHasAny) ?? months[0]);
  const breakdown = dayWorksJobsForMonth({ entries, options, attachments, centres, month });

  let jobs = new Map<string, JobRow>();
  if (!loadError && breakdown.jobs.length > 0) {
    try {
      const ids = breakdown.jobs.map((j) => j.job_id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        const { data, error } = await supabase.from("jobs").select("id, job_number, title, customers(name)").in("id", ids.slice(i, i + CHUNK));
        if (error) throw new Error(error.message);
        for (const j of (data ?? []) as unknown as JobRow[]) jobs.set(j.id, j);
      }
    } catch (err) {
      console.error("day works report jobs load failed:", err);
      jobs = new Map();
    }
  }

  const href = (p: { view?: ReportView; month?: string }) => {
    const q = new URLSearchParams();
    const v = p.view ?? view;
    if (v !== "all") q.set("view", v);
    q.set("month", p.month ?? month);
    return `/dashboard/reports/day-works?${q.toString()}`;
  };
  const amount = (c: ReportCell | undefined) => (c ? cellAmount(c, view) : 0);
  const cellText = (c: ReportCell | undefined) => (c && (c.entries > 0 || c.drafts > 0) ? money(amount(c)) : "—");
  const draftsText = (c: ReportCell | undefined) => (c && c.drafts > 0 ? `${c.drafts} (${money(c.draftAmount)})` : "—");
  const unpriced = report.total.unpriced;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {header}

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      <p className="text-xs text-slate-500">
        Priced at today&apos;s rates. Day Works lines keep the quantities, not the rate they were entered at — so changing a machine&apos;s
        rate in Fleet → Hire setup changes past months here too. An invoice already sent keeps its own amounts.
      </p>

      <div className="flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v.value}
            href={href({ view: v.value })}
            className={`rounded-md border px-3 py-1.5 text-sm ${v.value === view ? "border-blue-600 bg-blue-50 text-blue-700 font-medium" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
          >
            {v.label}
          </Link>
        ))}
      </div>

      {unpriced > 0 && (
        <p className="text-sm text-amber-700">
          <AlertTriangle className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />
          {unpriced} signed line{unpriced === 1 ? "" : "s"} {unpriced === 1 ? "has" : "have"} no hire rate set up in Fleet and{" "}
          {unpriced === 1 ? "is" : "are"} not in these totals.
        </p>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr className="text-right">
                <th className="text-left font-medium px-4 py-2">Month</th>
                {report.centres.map((c) => (
                  <th key={c.id} className="font-medium px-4 py-2">{c.name}</th>
                ))}
                <th className="font-medium px-4 py-2">Total</th>
                {view === "all" && <th className="font-medium px-4 py-2">Of which invoiced</th>}
                <th className="font-medium px-4 py-2">Not yet signed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.months.map((m) => {
                const t = report.monthTotals[m];
                return (
                  <tr key={m} className={`text-right ${m === month ? "bg-blue-50/60" : ""}`}>
                    <td className="text-left px-4 py-2">
                      <Link href={href({ month: m })} className="font-medium text-slate-800 hover:underline">
                        {monthLabel(m)}
                      </Link>
                    </td>
                    {report.centres.map((c) => (
                      <td key={c.id} className="px-4 py-2 text-slate-700">{cellText(report.cells[m]?.[c.id])}</td>
                    ))}
                    <td className="px-4 py-2 font-semibold text-slate-900">{cellText(t)}</td>
                    {view === "all" && <td className="px-4 py-2 text-slate-500">{t && t.entries > 0 ? money(t.invoiced) : "—"}</td>}
                    <td className="px-4 py-2 text-slate-500">{draftsText(t)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 border-t border-slate-200">
              <tr className="text-right">
                <td className="text-left px-4 py-2 font-medium text-slate-800">12 months</td>
                {report.centres.map((c) => (
                  <td key={c.id} className="px-4 py-2 font-medium text-slate-800">{money(amount(report.centreTotals[c.id]))}</td>
                ))}
                <td className="px-4 py-2 font-bold text-slate-900">{money(amount(report.total))}</td>
                {view === "all" && <td className="px-4 py-2 text-slate-600">{money(report.total.invoiced)}</td>}
                <td className="px-4 py-2 text-slate-600">{draftsText(report.total)}</td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">{monthLabel(month)} by job</h2>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {breakdown.jobs.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-10">No Day Works in {monthLabel(month)}. Pick another month above.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr className="text-right">
                    <th className="text-left font-medium px-4 py-2">Job</th>
                    {breakdown.centres.map((c) => (
                      <th key={c.id} className="font-medium px-4 py-2">{c.name}</th>
                    ))}
                    <th className="font-medium px-4 py-2">Signed</th>
                    <th className="font-medium px-4 py-2">Invoiced</th>
                    <th className="font-medium px-4 py-2">Not yet signed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {breakdown.jobs.map((r) => {
                    const job = jobs.get(r.job_id);
                    return (
                      <tr key={r.job_id} className="text-right">
                        <td className="text-left px-4 py-2.5">
                          <Link href={`/dashboard/jobs/${r.job_id}?tab=dayworks`} className="font-medium text-slate-800 hover:underline">
                            {job ? `#${job.job_number} — ${job.title}` : "Open job"}
                          </Link>
                          {job?.customers?.name && <span className="block text-xs text-slate-400">{job.customers.name}</span>}
                          {r.total.unpriced > 0 && (
                            <span className="block text-xs text-amber-700">
                              {r.total.unpriced} line{r.total.unpriced === 1 ? "" : "s"} with no hire rate
                            </span>
                          )}
                        </td>
                        {breakdown.centres.map((c) => (
                          <td key={c.id} className="px-4 py-2.5 text-slate-700">{cellText(r.byCentre[c.id])}</td>
                        ))}
                        <td className="px-4 py-2.5 text-slate-700">{r.total.entries > 0 ? money(r.total.signed) : "—"}</td>
                        <td className="px-4 py-2.5 text-slate-700">{r.total.entries > 0 ? money(r.total.invoiced) : "—"}</td>
                        <td className="px-4 py-2.5 text-slate-500">{draftsText(r.total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
