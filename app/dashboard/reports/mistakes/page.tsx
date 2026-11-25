export const dynamic = "force-dynamic";

import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { businessDateParts, formatDate } from "@/lib/date";
import { isMonthKey, lastMonths, monthLabel } from "@/lib/day-works-report";
import { groupMistakes, mistakesByJob, mistakesByMonth, mistakesInCell, NONE, openItems, UNTAGGED_NAME, type GroupRow, type MistakesCell } from "@/lib/mistakes-report";
import { loadCostSources, loadMistakes, withMoney, type MistakeWithMoney, type TrackingMode } from "@/lib/mistakes-data";
import { causeLabel, mistakeStatusLabel } from "@/lib/mistake-raise";
import { MistakesReview } from "@/components/mistakes/mistakes-review";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";

// Reports → Mistakes (Justin, 23 + 25 Nov 2026: "see where money leaks and
// why"). Office/admin; the per-person table is ADMIN only (whose mistake is
// admin-only by RLS, 0119 (a draft, not applied yet)). Runs under the viewer's own session.
//
//   • What mistakes cost by company cost centre per month, 12 months — click a
//     month or a cell for the list. "Cost" is every cost line: linked costs
//     the CRM already holds (already in job cost) plus manual lines.
//   • By category, by cause, by supplier (credits claimed vs received), by
//     job (net cost as a % of the job's builder PO value), by person (admin).
//   • Open items: still costing money with no credit claimed.
//   • Review: every mistake not closed — cost it, link costs, record money
//     back, close it (components/mistakes/).
// Labour on a linked time entry is costed at payroll rates, which only admin
// can read — for office it shows as hours and counts $0 (said on the page).
//
// Before 0119 the page works on 0115's one amount per mistake; before 0115 it
// says mistakes aren't switched on. Sums in lib/mistakes-report.ts.

const CHUNK = 100;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const exact = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type JobRow = { id: string; job_number: number; title: string; customers: { name: string } | null };

async function byIds<T>(db: SupabaseClient, table: string, columns: string, ids: string[], column = "id"): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await db.from(table).select(columns).in(column, uniq.slice(i, i + CHUNK));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

export default async function MistakesReportPage({ searchParams }: { searchParams: Promise<{ month?: string; centre?: string }> }) {
  const viewer = await getViewer();
  const role = viewer?.profile?.role;
  if (role !== "admin" && role !== "office") {
    return <div className="p-6 text-sm text-slate-500">The Mistakes report is for the office.</div>;
  }
  const isAdmin = role === "admin";
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
        Where money leaks, and why — the last 12 months, ex GST. A mistake&apos;s cost is the time, expenses, POs, equipment and Day Works linked to it
        (already in the job&apos;s cost) plus any manual cost; money back from a supplier credit, builder recharge or insurance comes off it. The crew log
        mistakes on the job; the office costs them below or on the job&apos;s Purchase Orders tab.
      </p>
    </div>
  );

  const db = (await createClient()) as unknown as SupabaseClient;
  let mode: TrackingMode = "tracking";
  let loadError: string | null = null;
  let mistakes: MistakeWithMoney[] = [];
  let centres: { id: string; name: string }[] = [];
  let staff: { id: string; full_name: string | null }[] = [];
  const lineCentre = new Map<string, string | null>();
  const categories = new Map<string, string>();
  const suppliers = new Map<string, string>();
  const jobValue = new Map<string, number>();
  const responsible = new Map<string, string>();
  let hiddenHours = 0;
  try {
    const [loaded, centresRes, staffRes] = await Promise.all([
      loadMistakes(db, { from }),
      db.from("cost_centres").select("id, name").order("sort_order").order("name"),
      db.from("profiles").select("id, full_name").eq("is_active", true).order("full_name"),
    ]);
    mode = loaded.mode;
    if (loaded.error) throw new Error(loaded.error);
    if (centresRes.error) throw new Error(centresRes.error.message);
    centres = (centresRes.data ?? []) as { id: string; name: string }[];
    staff = (staffRes.data ?? []) as { id: string; full_name: string | null }[];
    if (mode !== "missing") {
      const { sources } = await loadCostSources(db, loaded.lines, { withRates: isAdmin });
      mistakes = withMoney(loaded.mistakes, loaded.lines, sources);
      hiddenHours = mistakes.reduce((s, m) => s + m.money.hiddenHours, 0);

      const lineIds = mistakes.map((m) => m.cost_center_id).filter((id): id is string => !!id);
      for (const l of await byIds<{ id: string; cost_centre_id: string | null }>(db, "po_cost_centers", "id, cost_centre_id", lineIds)) lineCentre.set(l.id, l.cost_centre_id);
      const jobIds = mistakes.map((m) => m.job_id).filter((id): id is string => !!id);
      for (const p of await byIds<{ job_id: string; total_value: number | null }>(db, "purchase_orders", "job_id, total_value", jobIds, "job_id")) {
        jobValue.set(p.job_id, (jobValue.get(p.job_id) ?? 0) + Number(p.total_value ?? 0));
      }
      if (mode === "tracking") {
        const [cats, sups] = await Promise.all([
          db.from("mistake_categories").select("id, name"),
          byIds<{ id: string; name: string }>(db, "suppliers", "id, name", mistakes.map((m) => m.supplier_id).filter((id): id is string => !!id)),
        ]);
        for (const c of (cats.data ?? []) as { id: string; name: string }[]) categories.set(c.id, c.name);
        for (const s of sups) suppliers.set(s.id, s.name);
        if (isAdmin) {
          const resp = await byIds<{ mistake_id: string; staff_id: string }>(db, "mistake_responsibility", "mistake_id, staff_id", mistakes.map((m) => m.id), "mistake_id");
          for (const r of resp) responsible.set(r.mistake_id, r.staff_id);
        }
      }
    }
  } catch (err) {
    console.error("mistakes report load failed:", err);
    loadError = "Couldn't load the Mistakes report. Refresh to try again.";
  }

  if (mode === "missing") {
    return (
      <div className="p-6 space-y-3">
        {header}
        <p className="text-sm text-slate-600">Mistake costs aren&apos;t switched on yet — the database update for them still has to be applied.</p>
      </div>
    );
  }

  // The month table works on each mistake's gross cost.
  const reportRows = mistakes.map((m) => ({ ...m, amount_ex_gst: m.money.gross }));
  const report = mistakesByMonth({ mistakes: reportRows, lineCentre, centres, months });
  const month = isMonthKey(params.month) && months.includes(params.month) ? params.month : (months.find((m) => report.monthTotals[m]) ?? months[0]);
  const centreKey = params.centre && report.centres.some((c) => c.id === params.centre) ? params.centre : null;
  const centreLabel = centreKey ? report.centres.find((c) => c.id === centreKey)?.name ?? UNTAGGED_NAME : null;
  const list = mistakesInCell(reportRows, lineCentre, centres, month, centreKey);

  const inPeriod = mistakes.filter((m) => months.includes(m.occurred_on.slice(0, 7)));
  const staffName = new Map(staff.map((s) => [s.id, s.full_name ?? "Staff member"]));
  const byCategory = groupMistakes(inPeriod, (m) => m.category_id);
  const byCause = groupMistakes(inPeriod, (m) => m.cause_code);
  const bySupplier = groupMistakes(inPeriod.filter((m) => m.supplier_id), (m) => m.supplier_id);
  const byJob = mistakesByJob(inPeriod, jobValue).slice(0, 20);
  const byPerson = isAdmin ? groupMistakes(inPeriod.filter((m) => responsible.has(m.id)), (m) => responsible.get(m.id)) : [];
  const open = openItems(inPeriod);

  let jobs = new Map<string, JobRow>();
  const lineNames = new Map<string, string>();
  const jobIdsShown = [...new Set([...list.map((m) => m.job_id), ...byJob.map((r) => r.key), ...open.unrecovered.map((m) => m.job_id)].filter((id): id is string => !!id))];
  if (!loadError && jobIdsShown.length > 0) {
    try {
      jobs = new Map((await byIds<JobRow>(db, "jobs", "id, job_number, title, customers(name)", jobIdsShown)).map((j) => [j.id, j]));
      const lineIds = list.map((m) => m.cost_center_id).filter((id): id is string => !!id);
      for (const l of await byIds<{ id: string; name: string }>(db, "po_cost_centers", "id, name", lineIds)) lineNames.set(l.id, l.name);
    } catch (err) {
      console.error("mistakes report detail load failed:", err);
      jobs = new Map();
    }
  }
  const jobLabel = (id: string | null) => {
    if (!id) return "No job";
    const j = jobs.get(id);
    return j ? `#${j.job_number} — ${j.title}` : "Open job";
  };

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
      {mode === "legacy" && (
        <p className="text-sm text-amber-700">
          Categories, causes, linked costs and recovery arrive with the 0119 database update — until then each mistake is its one logged amount.
        </p>
      )}
      {hiddenHours > 0 && (
        <p className="text-xs text-slate-500">
          {Math.round(hiddenHours * 10) / 10} h of rework labour is linked but not costed here — labour cost uses payroll rates, which only admin sees.
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
                    <th className="font-medium px-4 py-2">Status</th>
                    <th className="font-medium px-4 py-2 text-right">Cost</th>
                    <th className="font-medium px-4 py-2 text-right">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((m) => {
                    const centre = report.centres.find((c) => c.id === ((m.cost_center_id ? lineCentre.get(m.cost_center_id) : null) ?? m.cost_centre_id))?.name;
                    const line = m.cost_center_id ? lineNames.get(m.cost_center_id) : null;
                    const job = m.job_id ? jobs.get(m.job_id) : null;
                    return (
                      <tr key={m.id} className="align-top">
                        <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{formatDate(m.occurred_on, { day: "numeric", month: "short", year: "numeric" })}</td>
                        <td className="px-4 py-2.5">
                          {m.job_id ? (
                            <Link href={`/dashboard/jobs/${m.job_id}?tab=po`} className="font-medium text-slate-800 hover:underline">
                              {jobLabel(m.job_id)}
                            </Link>
                          ) : (
                            <span className="text-slate-500">No job</span>
                          )}
                          {job?.customers?.name && <span className="block text-xs text-slate-400">{job.customers.name}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          {centre ?? UNTAGGED_NAME}
                          {line && <span className="block text-xs text-slate-400">{line}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-slate-800">
                          {m.category_id && <span className="block text-xs font-medium text-slate-500">{categories.get(m.category_id) ?? "Category"}</span>}
                          <span className="whitespace-pre-wrap">{m.description}</span>
                          {(m.cause_code || m.cause) && (
                            <span className="block text-xs text-slate-500">Cause: {[causeLabel(m.cause_code), m.cause].filter(Boolean).join(" — ")}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{mistakeStatusLabel(m.status)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-700 whitespace-nowrap">{exact(m.money.gross)}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-red-600 whitespace-nowrap">{exact(m.money.net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {mode === "tracking" && (
        <div className="grid gap-4 md:grid-cols-2">
          <GroupTable title="By category" rows={byCategory} label={(k) => (k === NONE ? "Uncategorised" : categories.get(k) ?? "Category")} />
          <GroupTable title="By cause" rows={byCause} label={(k) => (k === NONE ? "Not said" : causeLabel(k) ?? k)} />
          <GroupTable
            title="By supplier — credits claimed vs received"
            rows={bySupplier}
            label={(k) => suppliers.get(k) ?? "Supplier"}
            showRecovery
            empty="No mistakes tagged with a supplier."
          />
          {isAdmin && (
            <GroupTable title="By person (admin only)" rows={byPerson} label={(k) => staffName.get(k) ?? "Former staff member"} empty="No mistakes have a person recorded." />
          )}
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">By job</h2>
        <p className="text-xs text-slate-500">Net mistake cost as a share of the job&apos;s value (its builder POs). Highest share first, top 20.</p>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {byJob.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">No mistakes on jobs in the last 12 months.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500">
                  <tr className="text-right">
                    <th className="text-left font-medium px-4 py-2">Job</th>
                    <th className="font-medium px-4 py-2">Mistakes</th>
                    <th className="font-medium px-4 py-2">Net cost</th>
                    <th className="font-medium px-4 py-2">Job value</th>
                    <th className="font-medium px-4 py-2">% of value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {byJob.map((r) => (
                    <tr key={r.key} className="text-right">
                      <td className="text-left px-4 py-2">
                        <Link href={`/dashboard/jobs/${r.key}?tab=po`} className="text-slate-800 hover:underline">
                          {jobLabel(r.key)}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-slate-600">{r.count}</td>
                      <td className="px-4 py-2 text-red-600">{money(r.net)}</td>
                      <td className="px-4 py-2 text-slate-600">{r.jobValue ? money(r.jobValue) : "—"}</td>
                      <td className="px-4 py-2 font-medium text-slate-800">{r.pctOfValue == null ? "—" : `${r.pctOfValue}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Open items — costing us, nothing claimed back</h2>
        <p className="text-xs text-slate-500">
          {open.unrecovered.length} mistake{open.unrecovered.length === 1 ? "" : "s"}, {exact(open.unrecoveredTotal)} unrecovered with no credit claimed — oldest first.
        </p>
        {open.unrecovered.length > 0 && (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  {open.unrecovered.slice(0, 30).map((m) => (
                    <tr key={m.id}>
                      <td className="px-4 py-2 whitespace-nowrap text-slate-600">{formatDate(m.occurred_on, { day: "numeric", month: "short", year: "numeric" })}</td>
                      <td className="px-4 py-2">
                        {m.job_id ? (
                          <Link href={`/dashboard/jobs/${m.job_id}?tab=po`} className="text-slate-800 hover:underline">
                            {jobLabel(m.job_id)}
                          </Link>
                        ) : (
                          <span className="text-slate-500">No job</span>
                        )}
                        <span className="block text-xs text-slate-500 line-clamp-1">{m.description}</span>
                      </td>
                      <td className="px-4 py-2 text-slate-600">{mistakeStatusLabel(m.status)}</td>
                      <td className="px-4 py-2 text-right font-medium text-red-600">{exact(m.money.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Review — mistakes not closed</h2>
        <p className="text-xs text-slate-500">Open one to cost it: link the costs already on its job, add any manual cost, record money back, then close it.</p>
        <MistakesReview staff={staff} isAdmin={isAdmin} />
      </div>
    </div>
  );
}

function GroupTable({ title, rows, label, showRecovery, empty }: { title: string; rows: GroupRow[]; label: (key: string) => string; showRecovery?: boolean; empty?: string }) {
  return (
    <div className="space-y-2">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">{empty ?? "No mistakes in the last 12 months."}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr className="text-right">
                  <th className="text-left font-medium px-4 py-2" />
                  <th className="font-medium px-4 py-2">No.</th>
                  <th className="font-medium px-4 py-2">Cost</th>
                  {showRecovery && <th className="font-medium px-4 py-2">Claimed</th>}
                  <th className="font-medium px-4 py-2">Received</th>
                  <th className="font-medium px-4 py-2">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.key} className="text-right">
                    <td className="text-left px-4 py-2 text-slate-800">{label(r.key)}</td>
                    <td className="px-4 py-2 text-slate-600">{r.count}</td>
                    <td className="px-4 py-2 text-slate-700">{money(r.gross)}</td>
                    {showRecovery && <td className="px-4 py-2 text-slate-700">{money(r.claimed)}</td>}
                    <td className="px-4 py-2 text-emerald-700">{r.recovered ? money(r.recovered) : "—"}</td>
                    <td className="px-4 py-2 font-medium text-red-600">{money(r.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
