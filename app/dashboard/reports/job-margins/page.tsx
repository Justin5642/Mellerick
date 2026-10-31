export const dynamic = "force-dynamic";

import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { belowMinimumMargin, computeJobLedger, loadedRatesByStaff, plantCosts, type JobLedger } from "@/lib/job-ledger";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, AlertTriangle } from "lucide-react";

// Every job still in play with a builder's price, by margin left — worst
// first, flagged under the company minimum (Stage 3, 31 Oct 2026: "see live
// margin and whether a job is worth doing"). Admin only: labour cost comes
// from payroll data. Each row is the same ledger as the job's Costing tab
// (lib/job-ledger.ts).
//
// "In play" = not cancelled, and not completed-and-approved (those are done
// and billed).

const EQUIPMENT_COST_COLUMNS =
  "id, assigned_to, purchase_cost, estimated_life_years, insurance_annual, maintenance_annual, " +
  "registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year";
const STAFF_COST_COLUMNS =
  "staff_id, hourly_rate, super_rate, workers_comp_rate, leave_loading_rate, annual_fixed_oncosts, target_hours_per_week";

// A long `in (...)` list is sent in the URL; 100 ids keeps it well short.
const CHUNK = 100;

async function forJobs<T>(ids: string[], read: (chunk: string[]) => Promise<{ ok: true; rows: T[] } | { ok: false; error: string }>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await read(ids.slice(i, i + CHUNK));
    if (!r.ok) throw new Error(r.error);
    out.push(...r.rows);
  }
  return out;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;

interface JobRow {
  id: string;
  job_number: number;
  title: string;
  status: string;
  admin_status: string | null;
  customers: { name: string } | null;
}

export default async function JobMarginsPage() {
  const viewer = await getViewer();
  if (viewer?.profile?.role !== "admin") {
    return <div className="p-6 text-sm text-slate-500">Job margins are for admins only.</div>;
  }
  const supabase = await createClient();

  let rows: { job: JobRow; ledger: JobLedger }[] = [];
  let minMarginPct = 20;
  let loadError: string | null = null;
  try {
    const jobsRes = await fetchAllRows<JobRow>((count) =>
      supabase.from("jobs").select("id, job_number, title, status, admin_status, customers(name)", count).neq("status", "cancelled").order("id") as never
    );
    if (!jobsRes.ok) throw new Error(jobsRes.error);
    const open = jobsRes.rows.filter((j) => !(j.status === "completed" && j.admin_status === "approved"));
    const openIds = open.map((j) => j.id);

    type PoRow = { job_id: string; total_value: number | null; po_cost_centers: { id: string; cost_centre_id: string | null; allocated_amount: number | null; allocated_hours: number | null }[] };
    const pos = await forJobs<PoRow>(openIds, (chunk) =>
      fetchAllRows<PoRow>((count) =>
        supabase.from("purchase_orders").select("id, job_id, total_value, po_cost_centers(id, cost_centre_id, allocated_amount, allocated_hours)", count).in("job_id", chunk).order("id") as never
      )
    );
    const priced = new Set(pos.filter((p) => Number(p.total_value ?? 0) > 0).map((p) => p.job_id));
    const ids = openIds.filter((id) => priced.has(id));

    type TimeRow = { job_id: string; staff_id: string; hours: number | null; cost_center_id: string | null; entry_type: string | null };
    type ExpenseRow = { job_id: string; amount: number | null; cost_center_id: string | null };
    type OrderRow = { job_id: string; amount: number | null; cost_center_id: string | null; status: string };
    type UsageRow = { job_id: string; equipment_id: string; hours: number };
    const [time, expenses, orders, usage, equipmentRes, profilesRes, centresRes, configRes] = await Promise.all([
      forJobs<TimeRow>(ids, (chunk) =>
        fetchAllRows<TimeRow>((count) => supabase.from("time_entries").select("id, job_id, staff_id, hours, cost_center_id, entry_type", count).in("job_id", chunk).order("id") as never)
      ),
      forJobs<ExpenseRow>(ids, (chunk) =>
        fetchAllRows<ExpenseRow>((count) => supabase.from("job_expenses").select("id, job_id, amount, cost_center_id", count).in("job_id", chunk).order("id") as never)
      ),
      forJobs<OrderRow>(ids, (chunk) =>
        fetchAllRows<OrderRow>((count) => supabase.from("vendor_orders").select("id, job_id, amount, cost_center_id, status", count).in("job_id", chunk).order("id") as never)
      ),
      forJobs<UsageRow>(ids, (chunk) =>
        fetchAllRows<UsageRow>((count) => supabase.from("equipment_usage_log").select("id, job_id, equipment_id, hours", count).in("job_id", chunk).order("id") as never)
      ),
      supabase.from("equipment").select(EQUIPMENT_COST_COLUMNS),
      supabase.from("staff_cost_profiles").select(STAFF_COST_COLUMNS),
      supabase.from("cost_centres").select("id, name").order("sort_order"),
      supabase.from("billing_rate_config").select("min_margin_pct").eq("id", true).maybeSingle(),
    ]);
    for (const r of [equipmentRes, profilesRes, centresRes, configRes]) if (r.error) throw new Error(r.error.message);
    if (configRes.data?.min_margin_pct != null) minMarginPct = Number(configRes.data.min_margin_pct);

    const equipment = (equipmentRes.data ?? []) as never[];
    const rates = loadedRatesByStaff((profilesRes.data ?? []) as never[], equipment);
    const byJob = <T extends { job_id: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of list) (m.get(x.job_id) ?? m.set(x.job_id, []).get(x.job_id)!).push(x);
      return m;
    };
    const [posBy, timeBy, expBy, ordBy, useBy] = [byJob(pos), byJob(time), byJob(expenses), byJob(orders), byJob(usage)];

    rows = open
      .filter((j) => priced.has(j.id))
      .map((job) => {
        const jobPos = posBy.get(job.id) ?? [];
        return {
          job,
          ledger: computeJobLedger({
            costCentres: (centresRes.data ?? []) as { id: string; name: string }[],
            lines: jobPos.flatMap((p) => p.po_cost_centers ?? []),
            poTotal: jobPos.reduce((s, p) => s + Number(p.total_value ?? 0), 0),
            timeEntries: timeBy.get(job.id) ?? [],
            ratesByStaff: rates,
            expenses: expBy.get(job.id) ?? [],
            supplierOrders: ordBy.get(job.id) ?? [],
            plant: plantCosts(useBy.get(job.id) ?? [], equipment),
          }),
        };
      })
      .sort((a, b) => (a.ledger.marginPct ?? 0) - (b.ledger.marginPct ?? 0));
  } catch (err) {
    console.error("job margins load failed:", err);
    loadError = "Couldn't load the job margins. Refresh to try again.";
  }

  const flaggedCount = rows.filter((r) => belowMinimumMargin(r.ledger, minMarginPct)).length;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/reports">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Reports
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Job Margins</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            Open jobs with a builder&apos;s price, worst margin first. Cost is what each job has used so far (ex GST).
          </p>
        </div>
      </div>

      {loadError && <p className="text-sm text-red-600">{loadError}</p>}

      {!loadError && (
        <p className="text-sm text-slate-600">
          {rows.length} open job{rows.length === 1 ? "" : "s"} with a builder&apos;s price
          {flaggedCount > 0 && (
            <span className="text-red-600 font-medium"> · {flaggedCount} under your {minMarginPct.toFixed(0)}% minimum</span>
          )}
        </p>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">
              No open jobs have a builder&apos;s price yet. Add the PO value on a job&apos;s Purchase Orders tab.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr className="text-right">
                  <th className="text-left font-medium px-4 py-2">Job</th>
                  <th className="text-left font-medium px-4 py-2">Status</th>
                  <th className="font-medium px-4 py-2">Builder&apos;s price</th>
                  <th className="font-medium px-4 py-2">Cost so far</th>
                  <th className="font-medium px-4 py-2">Margin left</th>
                  <th className="text-left font-medium px-4 py-2">Needs attention</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(({ job, ledger }) => {
                  const flagged = belowMinimumMargin(ledger, minMarginPct);
                  const notes = [
                    ledger.unsplit > 0 ? `${money(ledger.unsplit)} not split` : null,
                    ledger.unpricedOrders > 0 ? `${ledger.unpricedOrders} PO${ledger.unpricedOrders === 1 ? "" : "s"} to price` : null,
                    ledger.uncostedHours > 0 ? `${ledger.uncostedHours.toFixed(1)}h with no rate` : null,
                  ].filter(Boolean);
                  return (
                    <tr key={job.id} className={`text-right ${flagged ? "bg-red-50/50" : ""}`}>
                      <td className="text-left px-4 py-2.5">
                        <Link href={`/dashboard/jobs/${job.id}?tab=costing`} className="font-medium text-slate-800 hover:underline">
                          #{job.job_number} — {job.title}
                        </Link>
                        {job.customers?.name && <span className="block text-xs text-slate-400">{job.customers.name}</span>}
                      </td>
                      <td className="text-left px-4 py-2.5 text-slate-500 capitalize">{job.status.replace("_", " ")}</td>
                      <td className="px-4 py-2.5 text-slate-700">{money(ledger.budget)}</td>
                      <td className="px-4 py-2.5 text-slate-700">{money(ledger.cost)}</td>
                      <td className={`px-4 py-2.5 font-semibold ${flagged ? "text-red-600" : "text-green-700"}`}>
                        {flagged && <AlertTriangle className="inline w-3.5 h-3.5 mr-1 -mt-0.5" />}
                        {money(ledger.margin)} ({ledger.marginPct?.toFixed(0)}%)
                      </td>
                      <td className="text-left px-4 py-2.5 text-xs text-amber-700">{notes.join(" · ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
