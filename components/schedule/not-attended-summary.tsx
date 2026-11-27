"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronUp, UserX } from "lucide-react";
import { notAttendedHeadline } from "@/lib/booking-attendance";
import { formatDateKeyRange } from "@/lib/schedule-form";

/**
 * "N bookings not attended" above the board (Justin, 27 Nov 2026) — office
 * and admin only; the page passes nothing for a technician. A past booking on
 * an open job, not flagged "Didn't make it", whose technician never clocked
 * on to that job on any of its days (lib/booking-attendance.ts). Follows
 * over-hours-summary.tsx. No money.
 */
export type NotAttendedRow = {
  bookingId: string;
  jobId: string;
  jobNumber: number;
  title: string;
  staffName: string;
  dayKeys: string[];
};

export function NotAttendedSummary({ rows }: { rows: NotAttendedRow[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-900" data-not-attended-summary>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-2">
          <UserX className="h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden />
          {notAttendedHeadline(rows.length)}
        </span>
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
      </button>
      {open && (
        <ul className="divide-y divide-amber-200 border-t border-amber-200">
          {rows.map((r) => (
            <li key={r.bookingId} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
              <Link href={`/dashboard/jobs/${r.jobId}`} className="font-semibold text-amber-950 hover:underline">
                #{r.jobNumber} — {r.title}
              </Link>
              <span className="text-xs">
                {r.staffName} · {formatDateKeyRange(r.dayKeys[0], r.dayKeys[r.dayKeys.length - 1])}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
