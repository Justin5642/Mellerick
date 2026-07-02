"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Briefcase, Plus } from "lucide-react";
import Link from "next/link";

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

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from("jobs")
        .select("*, customers(name)")
        .order("created_at", { ascending: false });
      if (error) setError(error.message);
      else setJobs(data ?? []);
    }
    load();
  }, []);

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
          <p className="text-slate-500 text-sm mt-1">{jobs?.length ?? 0} total jobs</p>
        </div>
        <Link href="/dashboard/jobs/new">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            New Job
          </Button>
        </Link>
      </div>

      <Card>
        <CardContent className="p-0">
          {!jobs || jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Briefcase className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">No jobs yet</p>
              <Link href="/dashboard/jobs/new" className="mt-2 text-sm text-blue-600 hover:underline">
                Create your first job
              </Link>
            </div>
          ) : (
            <div className="divide-y">
              {jobs.map((job: any) => (
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
                      {job.scheduled_start ? ` · ${new Date(job.scheduled_start).toLocaleDateString("en-AU")}` : ""}
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
