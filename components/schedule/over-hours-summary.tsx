"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { formatOverHours, overHoursHeadline, type OverHours } from "@/lib/over-hours";
import { cn } from "@/lib/utils";

/**
 * "Over allowed hours" on the schedule board (Justin, 24 Nov 2026) — office
 * and admin only; the board passes nothing for a technician. Hours only
 * (lib/over-hours.ts): never an amount.
 */

/** The short tag on a booking card; the whole sentence on hover and for screen readers. */
export function OverHoursBadge({ over, compact }: { over: OverHours; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded bg-amber-500 px-1 font-bold leading-4 text-white",
        compact ? "text-[9px]" : "text-[10px]",
      )}
      title={over.text}
      aria-label={over.text}
      data-over-hours={over.level}
    >
      <AlertTriangle className="h-2.5 w-2.5 flex-shrink-0" aria-hidden />
      <span className="truncate">
        Over {formatOverHours(over.usedHours)}/{formatOverHours(over.allowedHours)}
        {!compact && over.name ? ` ${over.name}` : ""}
      </span>
    </span>
  );
}

export type OverHoursJob = { id: string; job_number: number; title: string; status: string; items: OverHours[] };

/** "N jobs over their allowed hours" above the board; opens the list (job, used / allowed, link). */
export function OverHoursSummary({ jobs }: { jobs: OverHoursJob[] }) {
  const [open, setOpen] = useState(false);
  if (jobs.length === 0) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-900" data-over-hours-summary>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden />
          {overHoursHeadline(jobs.length)}
        </span>
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>
      {open && (
        <ul className="divide-y divide-amber-200 border-t border-amber-200">
          {jobs.map((job) => (
            <li key={job.id} className="px-3 py-2">
              <Link href={`/dashboard/jobs/${job.id}`} className="font-semibold text-amber-950 hover:underline">
                #{job.job_number} — {job.title}
              </Link>
              {job.status === "completed" && <span className="ml-2 text-xs text-slate-500">Completed</span>}
              <ul className="mt-0.5 text-xs">
                {job.items.map((item) => (
                  <li key={`${item.level}:${item.costCenterId ?? ""}`}>
                    {item.level === "job" ? "Whole job" : item.name ?? "Cost centre"}: {formatOverHours(item.usedHours)} used of{" "}
                    {formatOverHours(item.allowedHours)} allowed
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
