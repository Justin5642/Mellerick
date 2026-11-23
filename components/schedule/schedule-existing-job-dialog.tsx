"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { billingName } from "@/lib/customer-billing";
import { formatDateKeyRange } from "@/lib/schedule-form";
import {
  SCHEDULE_SEARCH_COLUMNS,
  SCHEDULE_SEARCH_LIMIT,
  UNSCHEDULABLE_STATUSES,
  canScheduleExistingJob,
  isScheduleSearchable,
  scheduleExistingJobHref,
  scheduleJobNumberQuery,
  scheduleSearchTokens,
  type SchedulePrefill,
} from "@/lib/schedule-existing-job";

export interface FoundJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  customers: { name: string | null; company: string | null } | null;
  sites: { suburb: string | null } | null;
}

/**
 * "Schedule an existing job" (Justin's notebook list, 20 Nov 2026): search
 * open jobs — not completed or cancelled — by number, title or customer, in
 * the database as you type (at most SCHEDULE_SEARCH_LIMIT), and open the
 * picked job's Schedule dialog (the job page with `?schedule=1`), with the
 * technician and day already filled in when started from a board cell.
 * Office/admin only — the board offers it to them alone; bookings are theirs
 * by RLS, and the dialog's own rules (a cost centre on every booking, leave
 * and clash warnings) apply as always.
 *
 * With `onPick` (the board, 23 Nov 2026) the picked job is handed back and the
 * board opens its Schedule dialog in place — straight away when a technician's
 * day was already chosen, else after the office clicks one. Without it the
 * job page is opened, as before.
 */
export function ScheduleExistingJobDialog({
  open,
  prefill,
  staffName,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  prefill: SchedulePrefill | null;
  /** The clicked technician's name, for the title. */
  staffName?: string | null;
  onOpenChange: (open: boolean) => void;
  /** Hand the picked job back instead of opening the job page. */
  onPick?: (job: FoundJob) => void;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundJob[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const term = query.trim();

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open || !isScheduleSearchable(term)) {
      setResults([]);
      setSearching(false);
      setFailed(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      const base = () =>
        supabase
          .from("jobs")
          .select(SCHEDULE_SEARCH_COLUMNS)
          .not("status", "in", `(${UNSCHEDULABLE_STATUSES.join(",")})`)
          .order("job_number", { ascending: false })
          .limit(SCHEDULE_SEARCH_LIMIT);
      const number = scheduleJobNumberQuery(term);
      let rows: FoundJob[] = [];
      let error = false;
      if (number !== null) {
        const r = await base().eq("job_number", number);
        error = !!r.error;
        rows = (r.data ?? []) as unknown as FoundJob[];
      } else {
        // Every word must match the title or the customer's name/company. The
        // customer match is resolved to ids first (≤ 50), as the to-do panel
        // does, because PostgREST can't OR across an embedded table.
        const tokens = scheduleSearchTokens(term);
        const custIds = await supabase
          .from("customers")
          .select("id")
          .or(tokens.map((w) => `name.ilike.%${w}%,company.ilike.%${w}%`).join(","))
          .limit(50);
        const ids = (custIds.data ?? []).map((c) => c.id);
        let q = base();
        for (const w of tokens) q = q.or(ids.length > 0 ? `title.ilike.%${w}%,customer_id.in.(${ids.join(",")})` : `title.ilike.%${w}%`);
        const r = await q;
        error = !!r.error;
        rows = (r.data ?? []) as unknown as FoundJob[];
      }
      if (mine !== seq.current) return;
      setSearching(false);
      setFailed(error);
      setResults(error ? [] : rows.filter(canScheduleExistingJob));
    }, 250);
    return () => clearTimeout(t);
  }, [term, open, supabase]);

  function pick(job: FoundJob) {
    onOpenChange(false);
    if (onPick) {
      onPick(job);
      return;
    }
    router.push(scheduleExistingJobHref(job.id, prefill));
  }

  const forWhom = [staffName, prefill?.dateKey ? formatDateKeyRange(prefill.dateKey, prefill.dateKey) : null].filter(Boolean).join(" · ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a job</DialogTitle>
          <DialogDescription>
            {forWhom ? `For ${forWhom}. ` : ""}
            {onPick && !prefill
              ? "Type the job number or a few words, pick it, then click the technician's day to book it."
              : "Find the job, then book it in its Schedule dialog."}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Job number, title or customer"
            className="pl-8"
            aria-label="Find a job to schedule"
          />
        </div>
        <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
          {term.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-400">Open jobs only — completed and cancelled jobs can&apos;t be scheduled.</p>
          ) : searching ? (
            <p className="px-3 py-3 text-sm text-slate-400">Searching…</p>
          ) : failed ? (
            <p className="px-3 py-3 text-sm text-red-600">Couldn&apos;t search jobs. Try again.</p>
          ) : !isScheduleSearchable(term) ? (
            <p className="px-3 py-3 text-sm text-slate-400">Keep typing…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-400">No open jobs match.</p>
          ) : (
            <ul className="divide-y">
              {results.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    onClick={() => pick(job)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
                  >
                    <CalendarPlus className="w-4 h-4 text-blue-600 flex-shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">#{job.job_number} — {job.title}</span>
                      <span className="block text-xs text-slate-500 truncate">
                        {(job.customers && billingName(job.customers)) || "No customer"}
                        {job.sites?.suburb ? ` · ${job.sites.suburb}` : ""}
                        {` · ${job.status.replace("_", " ")}`}
                        {job.scheduled_start ? " · already booked" : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
