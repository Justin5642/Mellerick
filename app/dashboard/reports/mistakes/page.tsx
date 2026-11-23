export const dynamic = "force-dynamic";

import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { businessDateParts, formatDate } from "@/lib/date";
import { isMonthKey, lastMonths, monthLabel } from "@/lib/day-works-report";
import { isMissingMistakesTable } from "@/lib/job-mistakes";
import { mistakesByMonth, mistakesInCell, UNTAGGED_NAME, type MistakesCell, type ReportMistake } from "@/lib/mistakes-report";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";

// Reports → Mistakes (Justin, 23 Nov 2026: "a way of tracking the expense of
// mistakes in each cost centre"). What mistakes cost by company cost centre
// per month for the last 12 months; click a month (or a month × cost centre)
// for the list, each linking to its job's Purchase Orders tab where mistakes
// are logged. Office/admin — it runs under the viewer's own session and
// job_mistakes is office/admin only by RLS (migration 0115 — a draft, not
// applied when this was written; until it is, the page says mistakes aren't
// switched on). Sums in lib/mistakes-report.ts.

const CHUNK = 100;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const exact = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type MistakeRow = ReportMistake & { description: string; cause: string | null; staff_id: string | null };
type JobRow = { id: string; job_number: number; title: string; customers: { name: string } | null };

export default async function MistakesReportPage({ searchParams }: { searchParams: Promise<{ month?: string; centre?: string }> }) {
  const viewer = await getViewer();
  const role = viewer?.profile?.role;
  if (role !== "admin" && role !== "office") {
    return <div className="p-6 text-sm text-slate-500">The Mistakes report is for the office.</div>;
  }
  const params = await searchParams;

  const now = businessDateParts();
  const months = lastMonths(`${now.year}-${String(now.month).padStart(2, "0")}`, 12);
  const from = `${months[months.length - 1]}-01`;

  const header = (
    <div className="space-y-1">
      <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="w-4 h-4" /> Reports
      </Link>
      <h1 className="text-2xl font-bold text-slate-900">Mistakes</h1>
      <p className="text-sm text-slate-500">
        What mistakes cost, by cost centre, for the last 12 months (ex GST). Each is counted as cost on its job, so it comes off that
        job&apos;s margin. Log them on the job&apos;s Purchase Orders tab.
      </p>
    </div>
  );

  const supabase = await createClient();
  let ready = true;
  let loadError: string | null = null;
  let mistakes: MistakeRow[] = [];
  let centres: { id: string; name: string }[] = [];
  const lineCentre = new Map<string, string | null>();
  try {
    const probe = await supabase.from("job_mistakes").select("id").limit(1);
    if (probe.error && isMissingMistakesTable(probe.error)) {
      ready = false;
    } else {
      if (probe.error) throw new Error(probe.error.message);
      const [mistakesRes, centresRes] = await Promise.all([
        fetchAllRows<MistakeRow>((count) =>
          supabase
            .from("job_mistakes")
            .select("id, job_id, occurred_on, amount_ex_gst, cost_center_id, description, cause, staff_id", count)
            .gte("occurred_on", from)
            .order("id") as never
        ),
        supabase.from("cost_centres").select("id, name").order("sort_order").order("name"),
      ]);
      if (!mistakesRes.ok) throw new Error(mistakesRes.error);
      if (centresRes.error) throw new Error(centresRes.error.message);
      mistakes = mistakesRes.rows.map((m) => ({ ...m, amount_ex_gst: Number(m.amount_ex_gst) }));
      centres = (centresRes.data ?? []) as { id: string; name: string }[];

      const lineIds = [...new Set(mistakes.map((m) => m.cost_center_id).filter((id): id is string => !!id))];
      for (let i = 0; i < lineIds.length; i += CHUNK) {
        const { data, error } = await supabase.from("po_cost_centers").select("id, cost_centre_id").in("id", lineIds.slice(i, i + CHUNK));
        if (error) throw new Error(error.message);
        for (const l of (data ?? []) as { id: string; cost_centre_id: string | null }[]) lineCentre.set(l.id, l.cost_centre_id);
      }
    }
  } catch (err) {
    console.error("mistakes report load failed:", err);
    loadError = "Couldn't load the Mistakes report. Refresh to try again.";
  }

  if (!ready) {
    return (
      <div className="p-6 space-y-3">
        {header}
        <p className="text-sm text-slate-600">Mistake costs aren&apos;t switched on yet — the database update for them still has to be applied.</p>
      </div>
    );
  }

  const report = mistakesByMonth({ mistakes, lineCentre, centres, months });
  const month = isMonthKey(params.month) && months.includes(params.month) ? params.month : (months.find((m) => report.monthTotals[m]) ?? months[0]);
  const centreKey = params.centre && report.centres.some((c) => c.id === params.centre) ? params.centre : null;
  const centreLabel = centreKey ? report.centres.find((c) => c.id === centreKey)?.name ?? UNTAGGED_NAME : null;
  const list = mistakesInCell(mistakes, lineCentre, centres, month, centreKey);

  let jobs = new Map<string, JobRow>();
  const lineNames = new Map<string, string>();
  const staffNames = new Map<string, string>();
  if (!loadError && list.length > 0) {
    try {
      const jobIds = [...new Set(list.map((m) => m.job_id))];
      for (let i = 0; i < jobIds.length; i += CHUNK) {
        const { data, error } = await supabase.from("jobs").select("id, job_number, title, customers(name)").in("id", jobIds.slice(i, i + CHUNK));
        if (error) throw new Error(error.message);
        for (const j of (data ?? []) as unknown as JobRow[]) jobs.set(j.id, j);
      }
      const lineIds = [...new Set(list.map((m) => m.cost_center_id).filter((id): id is string => !!id))];
      if (lineIds.length) {
        const { data } = await supabase.from("po_cost_centers").select("id, name").in("id", lineIds);
        for (const l of (data ?? []) as { id: string; name: string }[]) lineNames.set(l.id, l.name);
      }
      const staffIds = [...new Set(list.map((m) => m.staff_id).filter((id): id is string => !!id))];
      if (staffIds.length) {
        const { data } = await supabase.from("profiles").select("id, full_name").in("id", staffIds);
        for (const p of (data ?? []) as { id: string; full_name: string | null }[]) staffNames.set(p.id, p.full_name ?? "Staff member");
      }
    } catch (err) {
      console.error("mistakes report detail load failed:", err);
      jobs = new Map();
    }
  }

  const href = (m: string, c?: string | null) => {
    const q = new URLSearchParams({ month: m });
    if (c) q.set("centre", c);
    return `/dashboard/reports/mistakes?${q.toString()}`;
  };
  const cellText = (c: MistakesCell | undefined) => (c && c.count > 0 ? money(c.amount) : "—");

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {header}

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

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
                <th className="font-medium px-4 py-2">Mistakes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.months.map((m) => {
                const t = report.monthTotals[m];
                return (
                  <tr key={m} className={`text-right ${m === month ? "bg-blue-50/60" : ""}`}>
                    <td className="text-left px-4 py-2">
                      <Link href={href(m)} className="font-medium text-slate-800 hover:underline">
                        {monthLabel(m)}
                      </Link>
                    </td>
                    {report.centres.map((c) => {
                      const cell = report.cells[m]?.[c.id];
                      return (
                        <td key={c.id} className={`px-4 py-2 ${m === month && c.id === centreKey ? "font-semibold text-blue-700" : "text-slate-700"}`}>
                          {cell ? (
                            <Link href={href(m, c.id)} className="hover:underline">
                              {cellText(cell)}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      );
                    })}
                    <td className="px-4 py-2 font-semibold text-slate-900">{cellText(t)}</td>
                    <td className="px-4 py-2 text-slate-500">{t?.count ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 border-t border-slate-200">
              <tr className="text-right">
                <td className="text-left px-4 py-2 font-medium text-slate-800">12 months</td>
                {report.centres.map((c) => (
                  <td key={c.id} className="px-4 py-2 font-medium text-slate-800">{cellText(report.centreTotals[c.id])}</td>
                ))}
                <td className="px-4 py-2 font-bold text-slate-900">{money(report.total.amount)}</td>
                <td className="px-4 py-2 text-slate-600">{report.total.count}</td>
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {monthLabel(month)}
            {centreLabel ? ` — ${centreLabel}` : ""}
          </h2>
          {centreKey && (
            <Link href={href(month)} className="text-sm text-blue-600 hover:underline">
              All cost centres
            </Link>
          )}
        </div>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {list.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-10">No mistakes logged in {monthLabel(month)}. Pick another month above.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr className="text-left">
                    <th className="font-medium px-4 py-2">Date</th>
                    <th className="font-medium px-4 py-2">Job</th>
                    <th className="font-medium px-4 py-2">Cost centre</th>
                    <th className="font-medium px-4 py-2">What went wrong</th>
                    <th className="font-medium px-4 py-2">Whose</th>
                    <th className="font-medium px-4 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((m) => {
                    const job = jobs.get(m.job_id);
                    const centre = report.centres.find((c) => c.id === (m.cost_center_id ? lineCentre.get(m.cost_center_id) : null))?.name;
                    const line = m.cost_center_id ? lineNames.get(m.cost_center_id) : null;
                    return (
                      <tr key={m.id} className="align-top">
                        <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">
                          {formatDate(m.occurred_on, { day: "numeric", month: "short", year: "numeric" })}
                        </td>
                        <td className="px-4 py-2.5">
                          <Link href={`/dashboard/jobs/${m.job_id}?tab=po`} className="font-medium text-slate-800 hover:underline">
                            {job ? `#${job.job_number} — ${job.title}` : "Open job"}
                          </Link>
                          {job?.customers?.name && <span className="block text-xs text-slate-400">{job.customers.name}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {centre ?? UNTAGGED_NAME}
                          {line && <span className="block text-xs text-slate-400">{line}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-800">
                          <span className="whitespace-pre-wrap">{m.description}</span>
                          {m.cause && <span className="block text-xs text-slate-500">Cause: {m.cause}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{m.staff_id ? staffNames.get(m.staff_id) ?? "—" : "—"}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-red-600 whitespace-nowrap">{exact(Number(m.amount_ex_gst ?? 0))}</td>
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
