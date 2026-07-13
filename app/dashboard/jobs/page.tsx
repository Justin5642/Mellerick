"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Briefcase, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/date";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  scheduled: "bg-blue-100 text-blue-800",
  in_progress: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  on_hold: "bg-gray-100 text-gray-700",
};

const priorityColors: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  normal: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

export default function JobsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    async function load() {
      // Paginate explicitly — Supabase caps an unranged .select() at 1000
      // rows, which would silently hide older jobs (and results of the
      // search box below) once the table grows past that.
      const pageSize = 1000;
      let from = 0;
      const all: any[] = [];
      for (;;) {
        const { data, error } = await supabase
          .from("jobs")
          .select("*, customers(name), sites(name, address_line1, suburb)")
          .order("created_at", { ascending: false })
          .range(from, from + pageSize - 1);
        if (error) {
          setError(error.message);
          return;
        }
        all.push(...(data ?? []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
      setJobs(all);
    }
    load();
  }, []);

  const filteredJobs = useMemo(() => {
    if (!jobs) return jobs;
    const q = search.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job: any) => {
      const haystack = [
        job.job_number,
        job.title,
        job.description,
        job.status,
        job.priority,
        job.customers?.name,
        job.sites?.name,
        job.sites?.address_line1,
        job.sites?.suburb,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [jobs, search]);

  if (jobs === null && !error) {
    return <div className="p-6 text-slate-400 text-sm">Loading...</div>;
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
            {filteredJobs?.length ?? 0} of {jobs?.length ?? 0} jobs
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
              {jobs && jobs.length > 0 && search ? (
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
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${priorityColors[job.priority] ?? ""}`}>
                      {job.priority}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[job.status] ?? ""}`}>
                      {job.status?.replace("_", " ")}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
