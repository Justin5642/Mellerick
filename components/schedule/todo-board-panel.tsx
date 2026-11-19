"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GripVertical, ListTodo, MousePointerClick, Plus, Search, X } from "lucide-react";
import { jobPriorityColors } from "@/lib/badge-colors";
import { customerSearchTokens } from "@/lib/customer-search";
import {
  daysOnList,
  fitsGap,
  formatHours,
  MAX_ESTIMATED_HOURS,
  parseEstimatedHours,
  parseGapHours,
  sortTodoJobs,
  todoHours,
} from "@/lib/todo-list";
import { canAddToTodo, jobNumberQuery, TODO_PANEL_DROP_ID, TODO_SEARCH_LIMIT, todoDragId } from "@/lib/todo-board";
import { cn } from "@/lib/utils";
import type { TodoJob } from "./todo-list-panel";

// The to-do list BESIDE the Week/Day board (office/admin only). Justin, 19 Nov
// 2026: "drag and drop jobs that either weren't ready or jobs that can be done
// anytime … Should a job fall over at last minute, we can drag and populate
// the schedule from the to-do list. So we need to drag in and out of the
// to-do list, but also be able to enter a job into the to-do list to try and
// limit the amount of unbilled labour hours."
//
// Lives inside the board's DndContext: each row is draggable onto a
// technician's day, and the whole panel is a drop target for a booking
// dragged off the board. The writes themselves are the board's
// (team-schedule-view.tsx), so every board write keeps one set of guards.
// Hours only — nothing here holds a value/amount column.

type SearchResult = {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string;
  estimated_hours: number | null;
  todo_listed_at: string | null;
  scheduled_start: string | null;
  customers: { name: string | null } | null;
  sites: { suburb: string | null } | null;
};

const SEARCH_COLUMNS = "id, job_number, title, status, priority, estimated_hours, todo_listed_at, scheduled_start, customers(name), sites(suburb)";

function TodoRow({
  job,
  hours,
  source,
  nowMs,
  placing,
  onPlace,
  onRemove,
}: {
  job: TodoJob;
  hours: number | null;
  source: "estimate" | "po" | null;
  nowMs: number;
  placing: boolean;
  onPlace: () => void;
  onRemove: () => void;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: todoDragId(job.id), data: { kind: "todo", job } });
  const days = daysOnList(job.todo_listed_at, nowMs);
  return (
    <li
      ref={setNodeRef}
      {...listeners}
      data-todo-row={job.job_number}
      onContextMenu={(e) => e.preventDefault()}
      style={{ touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
      className={cn(
        "group relative rounded-lg border bg-white px-2.5 py-2 cursor-grab active:cursor-grabbing select-none",
        isDragging && "opacity-30",
        placing ? "border-amber-400 ring-2 ring-amber-300 bg-amber-50" : "border-slate-200 hover:border-blue-300"
      )}
    >
      <div className="flex items-start gap-2">
        <GripVertical className="w-3.5 h-3.5 text-slate-300 mt-0.5 flex-shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <Link
            prefetch={false}
            href={`/dashboard/jobs/${job.id}`}
            draggable={false}
            className="block text-xs font-semibold text-slate-800 hover:text-blue-600 truncate"
          >
            #{job.job_number} — {job.title}
          </Link>
          <p className="text-[11px] text-slate-500 truncate">
            {job.customer_name ?? "No customer"}
            {job.suburb ? ` · ${job.suburb}` : ""}
          </p>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <span className={cn("text-[10px] px-1.5 rounded-full font-medium capitalize", jobPriorityColors[job.priority] ?? "")}>{job.priority}</span>
            <span className="text-[10px] font-semibold text-slate-700" title={source === "po" ? "PO allocated hours" : source === "estimate" ? "Estimate" : undefined}>
              {hours !== null ? `${formatHours(hours)}${source === "po" ? " PO" : ""}` : "no estimate"}
            </span>
            <span className="text-[10px] text-slate-400">{days === 0 ? "listed today" : `${days}d on list`}</span>
            {job.status !== "pending" && <span className="text-[10px] text-slate-500 capitalize">{job.status.replace("_", " ")}</span>}
          </div>
        </div>
        <div className="flex flex-col gap-1 flex-shrink-0">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onPlace}
            className={cn(
              "rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-800",
              placing && "bg-amber-200 text-amber-900 hover:bg-amber-200"
            )}
            title={placing ? "Cancel placing" : "Place on the board — then tap a technician's day"}
            aria-label={placing ? `Cancel placing #${job.job_number}` : `Place #${job.job_number} on the board`}
          >
            <MousePointerClick className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onRemove}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600"
            title="Remove from the to-do list"
            aria-label={`Remove #${job.job_number} from the to-do list`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}

/** A row's look in the drag overlay. */
export function TodoDragCard({ job }: { job: TodoJob }) {
  return (
    <div className="w-56 rounded-lg border border-blue-300 bg-white px-2.5 py-2 shadow-lg rotate-1">
      <p className="text-xs font-semibold text-slate-800 truncate">#{job.job_number} — {job.title}</p>
      <p className="text-[11px] text-slate-500 truncate">{job.customer_name ?? "No customer"}</p>
    </div>
  );
}

export function TodoBoardPanel({
  jobs,
  error,
  gapInput,
  onGapInput,
  placingJobId,
  onPlace,
  onRemove,
  onAdded,
  bookingDragActive,
  cutActive,
  onCutDrop,
  onClose,
}: {
  jobs: TodoJob[];
  error: string | null;
  gapInput: string;
  onGapInput: (value: string) => void;
  placingJobId: string | null;
  onPlace: (job: TodoJob | null) => void;
  onRemove: (job: TodoJob) => void;
  /** A job was listed from the search; the board adds it to its list and refreshes. */
  onAdded: (job: TodoJob) => void;
  /** A board booking is being dragged — the panel shows it can take it. */
  bookingDragActive: boolean;
  /** A booking is cut (double-click): a click on the panel puts it back on the list. */
  cutActive: boolean;
  onCutDrop: () => void;
  onClose?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TODO_PANEL_DROP_ID });
  const gapHours = parseGapHours(gapInput);
  const [nowMs] = useState(() => Date.now());
  const rows = useMemo(
    () => sortTodoJobs(jobs).map((job) => ({ job, ...todoHours(job.estimated_hours, job.po_allocated_hours) })),
    [jobs],
  );
  const visible = rows.filter((r) => fitsGap(r.hours, gapHours));

  // "Add job…": searched in the database as you type (like the customer
  // picker), at most TODO_SEARCH_LIMIT rows: open, unscheduled, unlisted jobs
  // by number, title or customer name.
  const supabase = useMemo(() => createClient(), []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const term = query.trim();
  useEffect(() => {
    if (term.length < 2 && jobNumberQuery(term) === null) {
      setResults([]);
      setSearching(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      const base = () =>
        supabase
          .from("jobs")
          .select(SEARCH_COLUMNS)
          .in("status", ["pending", "on_hold"])
          .is("todo_listed_at", null)
          .is("scheduled_start", null)
          .order("job_number", { ascending: false })
          .limit(TODO_SEARCH_LIMIT);
      const number = jobNumberQuery(term);
      let data: SearchResult[] = [];
      let failed = false;
      if (number !== null) {
        const r = await base().eq("job_number", number);
        failed = !!r.error;
        data = (r.data ?? []) as unknown as SearchResult[];
      } else {
        // Every word must match the title or the customer's name. The
        // customer match is resolved to ids first (≤50), like the phone's
        // search, because PostgREST can't OR across an embedded table.
        const tokens = customerSearchTokens(term);
        const custIds = await supabase
          .from("customers")
          .select("id")
          .or(tokens.map((t) => `name.ilike.%${t}%,company.ilike.%${t}%`).join(","))
          .limit(50);
        const ids = (custIds.data ?? []).map((c) => c.id);
        let q = base();
        for (const t of tokens) q = q.or(ids.length > 0 ? `title.ilike.%${t}%,customer_id.in.(${ids.join(",")})` : `title.ilike.%${t}%`);
        const r = await q;
        failed = !!r.error;
        data = (r.data ?? []) as unknown as SearchResult[];
      }
      if (mine !== seq.current) return;
      setSearching(false);
      if (failed) {
        toast.error("Couldn't search jobs");
        setResults([]);
        return;
      }
      setResults(data.filter(canAddToTodo));
    }, 250);
    return () => clearTimeout(t);
  }, [term, supabase]);

  // The estimate prompt, as on the job page's "Add to to-do list".
  const [adding, setAdding] = useState<SearchResult | null>(null);
  const [hoursInput, setHoursInput] = useState("");
  const [saving, setSaving] = useState(false);
  async function addToList() {
    if (!adding) return;
    const parsed = parseEstimatedHours(hoursInput);
    if (parsed === "invalid") {
      toast.error(`Estimated hours must be a number from 0 to ${MAX_ESTIMATED_HOURS}`);
      return;
    }
    setSaving(true);
    // The 0067 trigger stamps todo_listed_at/by with the database clock and
    // the caller; the value sent only says "list it". count: an RLS refusal
    // is 0 rows, not an error.
    const { data, error: writeError, count } = await supabase
      .from("jobs")
      .update({ todo_listed_at: new Date().toISOString(), estimated_hours: parsed }, { count: "exact" })
      .eq("id", adding.id)
      .select("todo_listed_at");
    setSaving(false);
    if (writeError || count === 0) {
      toast.error("Couldn't add the job to the to-do list");
      return;
    }
    const listedAt = data?.[0]?.todo_listed_at;
    if (!listedAt) {
      toast.error("This job is already scheduled, so it can't go on the to-do list");
      return;
    }
    onAdded({
      id: adding.id,
      job_number: adding.job_number,
      title: adding.title,
      priority: adding.priority,
      status: adding.status,
      todo_listed_at: listedAt,
      estimated_hours: parsed,
      po_allocated_hours: null,
      customer_name: adding.customers?.name ?? null,
      suburb: adding.sites?.suburb ?? null,
    });
    toast.success(`#${adding.job_number} added to the to-do list`);
    setResults((prev) => prev.filter((r) => r.id !== adding.id));
    setAdding(null);
    setQuery("");
  }

  const dropReady = bookingDragActive || cutActive;

  return (
    <aside
      ref={setNodeRef}
      data-todo-panel
      aria-label="To-do list"
      onClick={cutActive ? onCutDrop : undefined}
      className={cn(
        "flex w-full min-h-0 flex-col rounded-xl border bg-slate-50 transition-colors",
        dropReady ? "border-dashed border-indigo-400 bg-indigo-50/60" : "border-slate-200",
        isOver && "ring-2 ring-indigo-500 bg-indigo-100/70",
        cutActive && "cursor-copy"
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <ListTodo className="w-4 h-4 text-indigo-600" />
          To-do list <span className="text-slate-400 font-normal">({jobs.length})</span>
        </h2>
        {onClose && (
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose} aria-label="Hide the to-do list">
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>

      {dropReady && (
        <p className="mx-3 mt-2 rounded-md border border-indigo-300 bg-white px-2 py-1.5 text-xs font-medium text-indigo-800">
          {cutActive ? "Click here to take the booking off the board" : "Drop here to take the booking off the board"}
        </p>
      )}

      <div className="px-3 pt-2 space-y-2" onClick={(e) => cutActive && e.stopPropagation()}>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add job… (number, title, customer)"
            className="h-8 pl-7 text-xs bg-white"
            aria-label="Find a job to add to the to-do list"
          />
        </div>
        {term.length > 0 && (
          <div className="rounded-md border border-slate-200 bg-white max-h-56 overflow-y-auto">
            {searching ? (
              <p className="px-2 py-2 text-xs text-slate-400">Searching…</p>
            ) : results.length === 0 ? (
              <p className="px-2 py-2 text-xs text-slate-400">
                {term.length < 2 && jobNumberQuery(term) === null ? "Keep typing…" : "No open, unscheduled jobs match"}
              </p>
            ) : (
              <ul className="divide-y">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-slate-50"
                      onClick={() => {
                        setHoursInput(r.estimated_hours !== null ? String(r.estimated_hours) : "");
                        setAdding(r);
                      }}
                    >
                      <Plus className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium truncate">#{r.job_number} — {r.title}</span>
                        <span className="block text-[11px] text-slate-500 truncate">
                          {r.customers?.name ?? "No customer"}
                          {r.sites?.suburb ? ` · ${r.sites.suburb}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Link prefetch={false} href="/dashboard/jobs/new" className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
          <Plus className="w-3 h-3" />
          New job (then &ldquo;Add to to-do list&rdquo; on its page)
        </Link>
        <div className="flex items-center gap-1.5">
          <label htmlFor="todo-panel-gap" className="text-xs text-slate-600">Fits in</label>
          <Input
            id="todo-panel-gap"
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            value={gapInput}
            onChange={(e) => onGapInput(e.target.value)}
            placeholder="any"
            className="w-16 h-7 text-xs bg-white"
          />
          <span className="text-xs text-slate-600">h</span>
          {gapHours !== null && (
            <button type="button" className="ml-auto text-[11px] text-blue-600 hover:underline" onClick={() => onGapInput("")}>
              Clear
            </button>
          )}
        </div>
        {gapHours !== null && (
          <p className="text-[11px] text-slate-400">{visible.length} of {rows.length} · jobs with no estimate always show</p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {error ? (
          <p className="text-xs text-red-500">Couldn&apos;t load the to-do list: {error}</p>
        ) : visible.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-6 border border-dashed border-slate-300 rounded-lg">
            {rows.length === 0 ? "Nothing on the to-do list. Find a job above, or drag a booking here." : "No to-do jobs fit that gap"}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map(({ job, hours, source }) => (
              <TodoRow
                key={job.id}
                job={job}
                hours={hours}
                source={source}
                nowMs={nowMs}
                placing={placingJobId === job.id}
                onPlace={() => onPlace(placingJobId === job.id ? null : job)}
                onRemove={() => onRemove(job)}
              />
            ))}
          </ul>
        )}
        {jobs.length > 0 && !error && (
          <p className="mt-2 text-[11px] text-slate-400">
            Drag a job onto a technician&apos;s day, or tap <MousePointerClick className="inline w-3 h-3" /> then the day.
          </p>
        )}
      </div>

      <Dialog open={!!adding} onOpenChange={(o) => !saving && !o && setAdding(null)}>
        <DialogContent>
          {adding && (
            <>
              <DialogHeader>
                <DialogTitle>Add #{adding.job_number} to the to-do list</DialogTitle>
                <DialogDescription>
                  {adding.title}. It stays on the list until it&apos;s scheduled, then drops off by itself.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="todo-panel-hours">Estimated hours (optional)</Label>
                <Input
                  id="todo-panel-hours"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={MAX_ESTIMATED_HOURS}
                  step={0.25}
                  value={hoursInput}
                  onChange={(e) => setHoursInput(e.target.value)}
                  placeholder="e.g. 3"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAdding(null)} disabled={saving}>Cancel</Button>
                <Button onClick={addToList} disabled={saving}>{saving ? "Adding..." : "Add to list"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
