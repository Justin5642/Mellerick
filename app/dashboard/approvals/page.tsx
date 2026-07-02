"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, XCircle, ClipboardList, Clock, User, MapPin, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";

export default function ApprovalsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from("jobs")
        .select("*, customers(name), sites(name, address_line1, suburb)")
        .eq("status", "completed")
        .eq("admin_status", "pending")
        .order("updated_at", { ascending: false });
      setJobs(data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  async function approve(jobId: string) {
    setSaving(jobId);
    await supabase.from("jobs").update({
      admin_status: "approved",
      admin_notes: notes[jobId] || null,
      ready_to_invoice: true,
    }).eq("id", jobId);
    setJobs(j => j.filter(job => job.id !== jobId));
    toast.success("Job approved — moved to invoicing queue");
    setSaving(null);
  }

  async function reject(jobId: string) {
    if (!notes[jobId]?.trim()) {
      toast.error("Add a note explaining what needs to be done before approving");
      return;
    }
    setSaving(jobId);
    await supabase.from("jobs").update({
      admin_status: "rejected",
      admin_notes: notes[jobId],
      status: "in_progress",
      ready_to_invoice: false,
    }).eq("id", jobId);
    setJobs(j => j.filter(job => job.id !== jobId));
    toast.success("Job sent back — technician will be notified");
    setSaving(null);
  }

  if (loading) return <div className="p-6 text-slate-400 text-sm">Loading...</div>;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Job Approvals</h1>
        <p className="text-slate-500 text-sm mt-1">{jobs.length} job{jobs.length !== 1 ? "s" : ""} awaiting review</p>
      </div>

      {jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-slate-400">
            <CheckCircle2 className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">All caught up — no jobs awaiting approval</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {jobs.map(job => (
            <Card key={job.id} className="overflow-hidden">
              <CardContent className="p-0">
                {/* Job summary row */}
                <button
                  className="w-full flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors text-left"
                  onClick={() => setExpanded(expanded === job.id ? null : job.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900">#{job.job_number} — {job.title}</p>
                    <div className="flex items-center gap-4 mt-1 flex-wrap">
                      <span className="text-xs text-slate-500 flex items-center gap-1">
                        <User className="w-3 h-3" />{job.customers?.name}
                      </span>
                      {job.sites && (
                        <span className="text-xs text-slate-500 flex items-center gap-1">
                          <MapPin className="w-3 h-3" />{job.sites.suburb}
                        </span>
                      )}
                      {job.completion_notes && (
                        <span className="text-xs text-slate-500 flex items-center gap-1">
                          <ClipboardList className="w-3 h-3" />{job.completion_notes}
                        </span>
                      )}
                      <span className="text-xs text-slate-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />Completed {new Date(job.updated_at).toLocaleDateString("en-AU")}
                      </span>
                    </div>
                  </div>
                  {expanded === job.id ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0 ml-4" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 ml-4" />}
                </button>

                {/* Expanded review panel */}
                {expanded === job.id && (
                  <div className="border-t px-6 py-4 space-y-4 bg-slate-50">
                    <div className="flex gap-3">
                      <Link href={`/dashboard/jobs/${job.id}`} className="text-xs text-blue-600 hover:underline">
                        View full job details →
                      </Link>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-slate-600">Notes (required if sending back)</label>
                      <Textarea
                        value={notes[job.id] ?? ""}
                        onChange={e => setNotes(n => ({ ...n, [job.id]: e.target.value }))}
                        placeholder="e.g. Photos missing, please add before/after shots of the completed work..."
                        rows={2}
                        className="text-sm"
                      />
                    </div>

                    <div className="flex gap-3">
                      <Button
                        onClick={() => approve(job.id)}
                        disabled={saving === job.id}
                        className="gap-2 bg-green-600 hover:bg-green-700"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        Approve & Queue Invoice
                      </Button>
                      <Button
                        onClick={() => reject(job.id)}
                        disabled={saving === job.id}
                        variant="outline"
                        className="gap-2 border-red-200 text-red-600 hover:bg-red-50"
                      >
                        <XCircle className="w-4 h-4" />
                        Send Back
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
