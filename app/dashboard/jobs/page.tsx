"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Briefcase, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/date";
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";
import { jobStatusColors, jobPriorityColors } from "@/lib/badge-colors";
import { getJobStageLabel } from "@/lib/job-stages";

const PAGE_SIZE = 50;
// Only what the list renders. The old select("*") pulled every column of
// every job (transcripts, notes, descriptions) for ~825+ jobs up front.
const BASE_COLUMNS = "id, job_number, title, status, priority, scheduled_start, customers(name)";
// todo_listed_at drives the "To-do" badge. Until the to-do columns exist in the
// database PostgREST rejects the whole select with 42703 (undefined column), so
// the list retries once without it — the badge is optional, the list is not.
const LIST_COLUMNS = `${BASE_COLUMNS}, todo_listed_at`;

type StageInfo = { stage: string; created_at: string };

// Strip characters that would break a PostgREST or() filter string.
function cleanQuery(q: string) {
  return q.replace(/[,()%*\\"]/g, " ").trim();
}

export default function JobsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); // debounced `search`
  const [loadingMore, setLoadingMore] = useState(false);
  // job_id -> most recent stage note. "Current stage" is where the last person
  // left off on that job; a separate concept from job.status (whole-job
  // lifecycle) shown alongside it. Fetched only for the jobs on screen.
  const [currentStageByJob, setCurrentStageByJob] = useState<Map<string, StageInfo>>(new Map());

  useEffect(() => {
    const t = setTimeout(() => setQuery(cleanQuery(search)), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Search runs in the database. Customer and site matches are resolved to ids
  // first (PostgREST can't OR across embedded tables), then OR-ed with the
  // job's own columns.
  const fetchPage = useCallback(
    async (q: string, from: number) => {
      let filter: string | null = null;
      if (q) {
        const [{ data: customers }, { data: sites }] = await Promise.all([
          supabase.from("customers").select("id").ilike("name", `%${q}%`).limit(200),
          supabase.from("sites").select("id").or(`name.ilike.%${q}%,address_line1.ilike.%${q}%,suburb.ilike.%${q}%`).limit(200),
        ]);
        const ors = [`title.ilike.%${q}%`, `description.ilike.%${q}%`, `status.ilike.%${q}%`, `priority.ilike.%${q}%`];
        const num = q.replace(/^#/, "");
        if (/^\d+$/.test(num)) ors.push(`job_number.eq.${num}`);
        if (customers?.length) ors.push(`customer_id.in.(${customers.map((c) => c.id).join(",")})`);
        if (sites?.length) ors.push(`site_id.in.(${sites.map((s) => s.id).join(",")})`);
        filter = ors.join(",");
      }
      const run = (columns: string) => {
        let builder = supabase.from("jobs").select(columns, { count: "exact" });
        if (filter) builder = builder.or(filter);
        return builder.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1);
      };
      const result = await run(LIST_COLUMNS);
      return result.error?.code === "42703" ? run(BASE_COLUMNS) : result;
    },
    [supabase]
  );

  const loadStages = useCallback(
    async (jobIds: string[]) => {
      if (jobIds.length === 0) return;
      const { data, error: stageError } = await supabase
        .from("job_stage_notes")
        .select("job_id, stage, created_at")
        .in("job_id", jobIds)
        .order("created_at", { ascending: false });
      if (stageError) return; // Non-fatal — the list still works without stage badges.
      setCurrentStageByJob((prev) => {
        const next = new Map(prev);
        for (const note of data ?? []) {
          if (!note.created_at) continue;
          const existing = next.get(note.job_id);
          if (!existing || note.created_at > existing.created_at) next.set(note.job_id, { stage: note.stage, created_at: note.created_at });
        }
        return next;
      });
    },
    [supabase]
  );

  // First page — reruns when the (debounced) search changes.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setError(null);
      const { data, error: listError, count } = await fetchPage(query, 0);
      if (cancelled) return;
      if (listError) {
        setError(listError.message);
        return;
      }
      setJobs(data ?? []);
      setTotal(count ?? null);
      void loadStages((data ?? []).map((j: any) => j.id));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [query, fetchPage, loadStages]);

  async function loadMore() {
    if (!jobs || loadingMore) return;
    setLoadingMore(true);
    const { data, error: moreError } = await fetchPage(query, jobs.length);
    setLoadingMore(false);
    if (moreError) {
      setError(moreError.message);
      return;
    }
    setJobs([...jobs, ...(data ?? [])]);
    void loadStages((data ?? []).map((j: any) => j.id));
  }

  const filteredJobs = jobs;
  const hasMore = jobs !== null && total !== null && jobs.length < total;

  if (jobs === null && !error) {
    return <ListPageSkeleton />;
  }

  if (error) {
    return <div className="p-6 text-red-500 text-sm">Error: {error}</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Jobs</h1>
          <p className="text-slate-500 text-sm mt-1">
            {total === null ? "" : query ? `${total} matching job${total === 1 ? "" : "s"}` : `${total} jobs`}
          </p>
        </div>
        <Link href="/dashboard/jobs/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            New Job
          </Button>
        </Link>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search jobs by number, title, customer, or address..."
          className="pl-8 pr-8"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            aria-label="Clear search"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {!filteredJobs || filteredJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Briefcase className="w-12 h-12 mb-3 opacity-40" />
              {query ? (
                <p className="text-sm font-medium">No jobs match &ldquo;{search}&rdquo;</p>
              ) : (
                <>
                  <p className="text-sm font-medium">No jobs yet</p>
                  <Link href="/dashboard/jobs/new" className="mt-2 text-sm text-blue-600 hover:underline">
                    Create your first job
                  </Link>
                </>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {filteredJobs.map((job: any) => (
                <Link
                  key={job.id}
                  href={`/dashboard/jobs/${job.id}`}
                  className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                      #{job.job_number} — {job.title}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {job.customers?.name ?? "No customer"}
                      {job.scheduled_start ? ` · ${formatDate(job.scheduled_start)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobPriorityColors[job.priority] ?? ""}`}>
                      {job.priority}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobStatusColors[job.status] ?? ""}`}>
                      {job.status?.replace("_", " ")}
                    </span>
                    {job.todo_listed_at && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-indigo-100 text-indigo-700" title="On the office to-do list">
                        To-do
                      </span>
                    )}
                    {currentStageByJob.get(job.id) && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-cyan-100 text-cyan-800">
                        {getJobStageLabel(currentStageByJob.get(job.id)!.stage)}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading..." : `Load more (${(total ?? 0) - (jobs?.length ?? 0)} more)`}
          </Button>
        </div>
      )}
    </div>
  );
}
