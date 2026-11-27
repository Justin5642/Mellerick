export const dynamic = "force-dynamic";

import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { anchorForDateKey, dateKeyInBusinessTZ, formatDate, formatTime } from "@/lib/date";
import {
  buildTimeLogRows,
  hoursByStaff,
  hoursByStage,
  parseTimeLogFilters,
  placeLabel,
  rangeInstants,
  sumHours,
  timeLogCsv,
  type PlaceFlag,
  type TimeLogEntry,
  type TimeLogJob,
  type TimeLogRow,
} from "@/lib/time-log-report";
import { DownloadCsvButton } from "@/components/reports/download-csv-button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";

// Reports → Time log (office feedback, 27 Nov 2026: "what time log was for
// what job type (e.g. Brodie – Sewer), date, hours on site. Need all
// details."). Every time entry in the range, one row each, with totals per
// staff member and per cost centre, and a CSV download. Office/admin only.
//
// HOURS ONLY — no rate, amount or value is read: time_entries through its
// column-level grants (rate_override is never readable, 0045), po_cost_centers
// by id and name only. Every read runs as the viewer (RLS decides), paged past
// PostgREST's 1000-row cap, lookups chunked to 100 ids. Shaping in
// lib/time-log-report.ts.

const CHUNK = 100;
const ENTRY_COLUMNS =
  "id, job_id, staff_id, clock_in, clock_out, hours, notes, auto_clocked, entry_type, cost_center_id, edited_by, edited_at, clock_in_lat, clock_in_lng, clock_in_accuracy, clock_out_lat, clock_out_lng, clock_out_accuracy";
const MISSING_VARIATION = new Set(["42703", "PGRST204", "PGRST200"]);

async function byIds<T>(db: SupabaseClient, table: string, columns: string, ids: Iterable<string>): Promise<T[]> {
  const uniq = [...new Set(ids)];
  const out: T[] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await db.from(table).select(columns).in("id", uniq.slice(i, i + CHUNK));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

const hours = (n: number) => n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Place({ place }: { place: PlaceFlag | null }) {
  if (!place) return <span className="text-slate-300">—</span>;
  return <span className={place.outside ? "text-amber-700 font-medium" : "text-slate-600"}>{place.outside ? "⚠ " : ""}{placeLabel(place)}</span>;
}

export default async function TimeLogReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; staff?: string; job?: string; type?: string }>;
}) {
  const viewer = await getViewer();
  const role = viewer?.profile?.role;
  if (role !== "admin" && role !== "office") {
    return <div className="p-6 text-sm text-slate-500">The Time log report is for the office.</div>;
  }
  const params = await searchParams;
  const filters = parseTimeLogFilters(params, dateKeyInBusinessTZ(new Date()));
  const { start, end } = rangeInstants(filters);

  const db = (await createClient()) as unknown as SupabaseClient;
  let loadError: string | null = null;
  let jobNotFound = false;
  let rows: TimeLogRow[] = [];
  let staffOptions: { id: string; full_name: string | null }[] = [];

  try {
    const staffRes = await db.from("profiles").select("id, full_name").eq("is_active", true).order("full_name");
    if (staffRes.error) throw new Error(staffRes.error.message);
    staffOptions = (staffRes.data ?? []) as { id: string; full_name: string | null }[];

    let jobId: string | null = null;
    if (filters.jobNumber != null) {
      const { data, error } = await db.from("jobs").select("id").eq("job_number", filters.jobNumber).maybeSingle();
      if (error) throw new Error(error.message);
      jobId = (data as { id: string } | null)?.id ?? null;
      jobNotFound = !jobId;
    }

    if (!jobNotFound) {
      const read = (columns: string) =>
        fetchAllRows<TimeLogEntry>((count) => {
          let q = db.from("time_entries").select(columns, count).gte("clock_in", start).lt("clock_in", end);
          if (filters.staffId) q = q.eq("staff_id", filters.staffId);
          if (jobId) q = q.eq("job_id", jobId);
          if (filters.entryType === "travel") q = q.eq("entry_type", "travel");
          // Work = anything not travel (older rows may have no type).
          if (filters.entryType === "work") q = q.or("entry_type.is.null,entry_type.neq.travel");
          return q.order("clock_in").order("id") as never;
        });
      // variation_id is 0120 (a draft) — read with it, and without on a
      // database that doesn't have it yet.
      let res = await read(`${ENTRY_COLUMNS}, variation_id`);
      if (!res.ok && MISSING_VARIATION.has(res.code ?? "") && /variation_id/.test(res.error)) res = await read(ENTRY_COLUMNS);
      if (!res.ok) throw new Error(res.error);
      const entries = res.rows;

      const jobIds = entries.map((e) => e.job_id).filter((id): id is string => !!id);
      const peopleIds = entries.flatMap((e) => [e.staff_id, e.edited_by]).filter((id): id is string => !!id);
      const stageIds = entries.map((e) => e.cost_center_id).filter((id): id is string => !!id);
      const variationIds = entries.map((e) => e.variation_id).filter((id): id is string => !!id);

      const [jobs, people, stages, variations] = await Promise.all([
        byIds<TimeLogJob>(db, "jobs", "id, job_number, title, sites(address_line1, suburb, site_lat, site_lng, geofence_radius_m)", jobIds),
        byIds<{ id: string; full_name: string | null }>(db, "profiles", "id, full_name", peopleIds),
        // id and name ONLY — po_cost_centers carries money.
        byIds<{ id: string; name: string | null }>(db, "po_cost_centers", "id, name", stageIds),
        byIds<{ id: string; custom_name: string | null; variation_types: { name: string | null } | null }>(
          db,
          "job_variations",
          "id, custom_name, variation_types(name)",
          variationIds
        ),
      ]);

      rows = buildTimeLogRows(entries, {
        jobs: new Map(jobs.map((j) => [j.id, j])),
        staffNames: new Map(people.map((p) => [p.id, p.full_name ?? "Staff member"])),
        stageNames: new Map(stages.map((s) => [s.id, s.name ?? "Unnamed cost centre"])),
        variationNames: new Map(variations.map((v) => [v.id, v.variation_types?.name ?? v.custom_name ?? "Variation"])),
      });
    }
  } catch (err) {
    console.error("time log report load failed:", err);
    loadError = "Couldn't load the time log. Refresh to try again.";
  }

  const byStaff = hoursByStaff(rows);
  const byStage = hoursByStage(rows);
  const total = sumHours(rows);
  const rangeLabel = `${formatDate(anchorForDateKey(filters.from), { weekday: "short", day: "numeric", month: "short", year: "numeric" })} – ${formatDate(
    anchorForDateKey(filters.to),
    { weekday: "short", day: "numeric", month: "short", year: "numeric" }
  )}`;
  const inputClass = "rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800";

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="space-y-1">
        <Link href="/dashboard/reports" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="w-4 h-4" /> Reports
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Time log</h1>
        <p className="text-sm text-slate-500">
          Every clock-on in the range — who, which job and cost centre, when, how long, and whether they were on site when they clocked on and off
          (against the site&apos;s map pin; blank when the phone recorded no position or the site has no pin). Melbourne time. Hours only.
        </p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          From
          <input type="date" name="from" defaultValue={filters.from} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          To
          <input type="date" name="to" defaultValue={filters.to} className={inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Staff
          <select name="staff" defaultValue={filters.staffId ?? ""} className={inputClass}>
            <option value="">Everyone</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name ?? "Staff member"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Job number
          <input type="text" inputMode="numeric" name="job" defaultValue={filters.jobNumber ?? ""} placeholder="Any" className={`${inputClass} w-24`} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Type
          <select name="type" defaultValue={filters.entryType} className={inputClass}>
            <option value="all">Work and travel</option>
            <option value="work">Work</option>
            <option value="travel">Travel</option>
          </select>
        </label>
        <button type="submit" className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
          Show
        </button>
        <Link href="/dashboard/reports/time-log" className="py-1.5 text-sm text-slate-500 hover:text-slate-800">
          This week
        </Link>
      </form>

      {loadError ? (
        <p className="text-sm text-red-600">{loadError}</p>
      ) : jobNotFound ? (
        <p className="text-sm text-slate-600">There is no job #{filters.jobNumber}.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-700">
              <span className="font-semibold">{rangeLabel}</span> · {rows.length} {rows.length === 1 ? "entry" : "entries"} · {hours(total)} h
            </p>
            {rows.length > 0 && <DownloadCsvButton csv={timeLogCsv(rows)} fileName={`time-log-${filters.from}-to-${filters.to}.csv`} />}
          </div>

          {rows.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardContent className="p-4">
                  <h2 className="mb-2 text-sm font-semibold text-slate-900">Hours by staff member</h2>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th className="py-1 font-medium">Staff</th>
                        <th className="py-1 text-right font-medium">Work</th>
                        <th className="py-1 text-right font-medium">Travel</th>
                        <th className="py-1 text-right font-medium">Hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byStaff.map((s) => (
                        <tr key={s.staffId ?? "none"} className="border-t border-slate-100">
                          <td className="py-1 text-slate-800">{s.name}</td>
                          <td className="py-1 text-right text-slate-600">{hours(s.workHours)}</td>
                          <td className="py-1 text-right text-slate-600">{hours(s.travelHours)}</td>
                          <td className="py-1 text-right font-semibold text-slate-900">{hours(s.hours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <h2 className="mb-2 text-sm font-semibold text-slate-900">Hours by cost centre</h2>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th className="py-1 font-medium">Cost centre / stage</th>
                        <th className="py-1 text-right font-medium">Entries</th>
                        <th className="py-1 text-right font-medium">Hours</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byStage.map((s) => (
                        <tr key={s.name} className="border-t border-slate-100">
                          <td className="py-1 text-slate-800">{s.name}</td>
                          <td className="py-1 text-right text-slate-600">{s.entries}</td>
                          <td className="py-1 text-right font-semibold text-slate-900">{hours(s.hours)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              {rows.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">No time logged in this range.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-[1200px] w-full text-sm">
                    <thead className="bg-slate-50">
                      <tr className="text-left text-xs text-slate-500">
                        <th className="px-3 py-2 font-medium">Date</th>
                        <th className="px-3 py-2 font-medium">Staff</th>
                        <th className="px-3 py-2 font-medium">Job</th>
                        <th className="px-3 py-2 font-medium">Site</th>
                        <th className="px-3 py-2 font-medium">Cost centre / stage</th>
                        <th className="px-3 py-2 font-medium">Type</th>
                        <th className="px-3 py-2 font-medium">On</th>
                        <th className="px-3 py-2 font-medium">Off</th>
                        <th className="px-3 py-2 text-right font-medium">Hours</th>
                        <th className="px-3 py-2 font-medium">Clock on place</th>
                        <th className="px-3 py-2 font-medium">Clock off place</th>
                        <th className="px-3 py-2 font-medium">Clocked</th>
                        <th className="px-3 py-2 font-medium">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 whitespace-nowrap text-slate-700">
                            {formatDate(anchorForDateKey(r.date), { weekday: "short", day: "numeric", month: "short" })}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-slate-800">{r.staffName}</td>
                          <td className="px-3 py-2">
                            {r.jobId && r.jobNumber != null ? (
                              <Link href={`/dashboard/jobs/${r.jobId}`} prefetch={false} className="text-blue-600 hover:underline">
                                #{r.jobNumber} {r.jobTitle}
                              </Link>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-600">{r.site || <span className="text-slate-300">—</span>}</td>
                          <td className="px-3 py-2 text-slate-700">
                            {r.stageName}
                            {r.variationName && <div className="text-xs text-amber-700">Variation: {r.variationName}</div>}
                          </td>
                          <td className="px-3 py-2 text-slate-600">{r.entryType === "travel" ? "Travel" : "Work"}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-slate-700">{formatTime(r.clockIn)}</td>
                          <td className="px-3 py-2 whitespace-nowrap text-slate-700">
                            {r.stillOn ? <span className="font-medium text-green-600">still on</span> : formatTime(r.clockOut!)}
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-900">{hours(r.hours)}</td>
                          <td className="px-3 py-2 text-xs">
                            <Place place={r.clockInPlace} />
                          </td>
                          <td className="px-3 py-2 text-xs">
                            <Place place={r.clockOutPlace} />
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            {r.auto ? "Auto" : "Manual"}
                            {r.editedBy && <div className="text-slate-400">Edited by {r.editedBy}</div>}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600 max-w-[280px] whitespace-pre-wrap">{r.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
