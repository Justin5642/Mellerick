"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CalendarClock, ListTodo } from "lucide-react";
import { jobPriorityColors, jobStatusColors } from "@/lib/badge-colors";
import { daysOnList, fitsGap, formatHours, parseGapHours, sortTodoJobs, todoHours } from "@/lib/todo-list";

// One row of the office To-do list. Hours only — po_allocated_hours comes from
// purchase_orders_public.total_hours; no value/amount column is carried here.
export type TodoJob = {
  id: string;
  job_number: number;
  title: string;
  priority: string;
  status: string;
  todo_listed_at: string;
  estimated_hours: number | null;
  po_allocated_hours: number | null;
  customer_name: string | null;
  suburb: string | null;
};

// Jobs office has set aside to fill a schedule gap. Added by hand on the job
// page; a database trigger removes each one once it is scheduled, so this list
// never needs pruning. "Schedule" opens the job page with ?schedule=1, which
// opens the same schedule wizard the job page's own button does — that wizard
// needs the job's staff, assignments and PO cost centres, which this page
// doesn't load.
export function TodoListPanel({ jobs, error }: { jobs: TodoJob[]; error: string | null }) {
  const [gapInput, setGapInput] = useState("");
  const gapHours = parseGapHours(gapInput);
  // One clock read per render pass for "days on list"; the panel isn't long-lived.
  const [nowMs] = useState(() => Date.now());

  const rows = useMemo(
    () =>
      sortTodoJobs(jobs).map((job) => ({
        job,
        ...todoHours(job.estimated_hours, job.po_allocated_hours),
      })),
    [jobs]
  );
  const visible = rows.filter((r) => fitsGap(r.hours, gapHours));

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-red-500">Couldn&apos;t load the to-do list: {error}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="todo-gap-hours" className="text-sm text-slate-600">Fits in</label>
        <Input
          id="todo-gap-hours"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.5}
          value={gapInput}
          onChange={(e) => setGapInput(e.target.value)}
          placeholder="any"
          className="w-24 h-8"
        />
        <span className="text-sm text-slate-600">h</span>
        {gapHours !== null && (
          <span className="text-xs text-slate-400">
            {visible.length} of {rows.length} · jobs with no estimate are always shown
          </span>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <ListTodo className="w-10 h-10 mb-2 opacity-40" />
              <p className="text-sm font-medium">
                {rows.length === 0 ? "Nothing on the to-do list" : "No to-do jobs fit that gap"}
              </p>
              {rows.length === 0 && (
                <p className="text-xs mt-1">Add jobs from a job&apos;s page with &ldquo;Add to to-do list&rdquo;.</p>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {visible.map(({ job, hours, source }) => {
                const days = daysOnList(job.todo_listed_at, nowMs);
                return (
                  <div key={job.id} className="flex items-center gap-4 px-6 py-3 hover:bg-slate-50 transition-colors">
                    <div className="w-16 flex-shrink-0 text-center">
                      {hours !== null ? (
                        <>
                          <p className="text-sm font-bold text-slate-800">{formatHours(hours)}</p>
                          <p className="text-[10px] text-slate-400">{source === "po" ? "PO hours" : "estimate"}</p>
                        </>
                      ) : (
                        <p className="text-[11px] text-slate-400 leading-tight">no estimate</p>
                      )}
                    </div>
                    <Link href={`/dashboard/jobs/${job.id}`} className="flex-1 min-w-0 group">
                      <p className="font-medium text-sm group-hover:text-blue-600 transition-colors truncate">
                        #{job.job_number} — {job.title}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {job.customer_name ?? "No customer"}
                        {job.suburb ? ` · ${job.suburb}` : ""}
                        {` · ${days === 0 ? "listed today" : `${days} day${days === 1 ? "" : "s"} on list`}`}
                      </p>
                    </Link>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobPriorityColors[job.priority] ?? ""}`}>
                      {job.priority}
                    </span>
                    {job.status !== "pending" && (
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${jobStatusColors[job.status] ?? ""}`}>
                        {job.status.replace("_", " ")}
                      </span>
                    )}
                    <Link href={`/dashboard/jobs/${job.id}?schedule=1`} className="flex-shrink-0">
                      <Button size="sm" variant="outline" className="gap-1.5 h-8">
                        <CalendarClock className="w-3.5 h-3.5" />
                        Schedule
                      </Button>
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
