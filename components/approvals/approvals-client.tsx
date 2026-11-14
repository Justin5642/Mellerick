"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { pushJobToCalendar } from "@/lib/schedule-dispatch";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, XCircle, ClipboardList, Clock, User, MapPin, ChevronDown, ChevronUp, AlertTriangle, GitPullRequestArrow, Timer } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UnbilledVariations, type UnbilledVariation } from "./unbilled-variations";
import { formatDate } from "@/lib/date";
import { variationQtyText } from "@/lib/variation-qty";
import type { HoursGroup } from "@/lib/approved-hours";

const OVERTIME_LABELS: Record<string, string> = {
  unexpected_issue: "Unexpected issue",
  difficult_site: "Difficult site",
  training_needed: "Training needed",
  other: "Other",
};

/** Hours a pending job will carry onto its invoice (app/dashboard/approvals/page.tsx). */
export interface JobHoursSummary {
  groups: HoursGroup[];
  total: number;
  error: string | null;
}

interface Props {
  role: string | null;
  currentUserId: string;
  jobs: any[];
  hoursByJob: Record<string, JobHoursSummary>;
  pendingVariations: any[];
  unbilledVariations: UnbilledVariation[];
}

// The list and both actions. The page (app/dashboard/approvals/page.tsx) loads
// the rows and the viewer's role on the server and hands them in, so the screen
// arrives filled instead of fetching after hydration.
export function ApprovalsClient({ role, jobs: initialJobs, hoursByJob, pendingVariations, unbilledVariations }: Props) {
  const supabase = createClient();
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // Auto-push to Xero is gated to this exact action: an admin clicking
  // Approve here. It never fires from job completion/signature or any
  // other event, and the button itself is admin-only (see isAdmin below) —
  // per Justin's explicit requirement that invoices only ever reach Xero
  // after an admin has approved them in the app, never from a technician.
  async function approve(jobId: string) {
    if (role !== "admin") {
      toast.error("Only admins can approve jobs");
      return;
    }
    setSaving(jobId);

    // The whole approval — invoice, its lines, variations, the job's hours,
    // the approval itself — runs on the server (lib/approve-job.ts), and this
    // screen says "approved" only when the server confirms it. It used to be
    // a chain of writes from here, each one able to fail after the last.
    let data: any = null;
    try {
      const res = await fetch(`/api/jobs/${jobId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes[jobId] || null }),
      });
      data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `The server refused the approval (HTTP ${res.status}).`);
    } catch (err: any) {
      toast.error(err.message ?? "The job could not be approved.");
      setSaving(null);
      return;
    }

    setJobs((j) => j.filter((job) => job.id !== jobId));
    for (const w of data.warnings ?? []) toast.warning(w);

    const { invoiceId, invoiceCreated, alreadyPushed, unpricedHours } = data as {
      invoiceId: string | null; invoiceCreated: boolean; alreadyPushed: boolean; unpricedHours: number;
    };
    const openInvoice = invoiceId
      ? { label: "Open invoice", onClick: () => router.push(`/dashboard/invoices/${invoiceId}`) }
      : undefined;

    if (invoiceId && unpricedHours > 0) {
      // Held, not pushed: an invoice with unpriced hours would reach Xero
      // under-billed. "Apply hourly rate" on the invoice prices them.
      toast.success(
        `Job approved — ${invoiceCreated ? "draft invoice created" : "added to the existing invoice"} with ${unpricedHours.toFixed(2)}h to price. ` +
          "Apply an hourly rate on the invoice, then push it to Xero.",
        { action: openInvoice, duration: 12000 }
      );
    } else if (invoiceId && !alreadyPushed) {
      try {
        const res = await fetch("/api/xero/push-invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceId }),
        });
        const push = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(push.error);
        toast.success("Job approved — invoice created and pushed to Xero");
      } catch (err: any) {
        toast.success(invoiceCreated ? "Job approved — invoice created (draft, not yet in Xero)" : "Job approved");
        toast.error(`Xero push failed: ${err.message ?? "unknown error"} — push manually from the invoice page`, { action: openInvoice });
      }
    } else if (invoiceId && alreadyPushed) {
      toast.success("Job approved — invoice already synced to Xero");
    } else {
      toast.success("Job approved — moved to invoicing queue (no line items or hours yet, create the invoice manually)");
    }

    setSaving(null);
  }

  async function reject(jobId: string) {
    if (role !== "admin") {
      toast.error("Only admins can send jobs back");
      return;
    }
    if (!notes[jobId]?.trim()) {
      toast.error("Add a note explaining what needs to be done before approving");
      return;
    }
    setSaving(jobId);
    const { error: rejectErr, count: rejectCount } = await supabase
      .from("jobs")
      .update(
        {
          admin_status: "rejected",
          admin_notes: notes[jobId],
          status: "in_progress",
          ready_to_invoice: false,
        },
        { count: "exact" }
      )
      .eq("id", jobId);

    // "Technician will be notified" is a promise about a row that may not have
    // changed. If it did not, the job stays approved-pending and the note the
    // admin just wrote is gone.
    if (rejectErr || rejectCount === 0) {
      toast.error(rejectErr?.message ?? "The job could not be sent back — it may have changed since this page loaded.");
      setSaving(null);
      return;
    }

    // Sending a job back reopens it, so its calendar event is wrong until this
    // lands. It is not worth failing the send-back over, but it is worth
    // saying — `.catch(() => {})` said nothing.
    const calendarSynced = await pushJobToCalendar(jobId);
    setJobs(j => j.filter(job => job.id !== jobId));
    if (calendarSynced) toast.success("Job sent back — technician will be notified");
    else toast.warning("Job sent back — technician will be notified, but Google Calendar was not updated");
    setSaving(null);
  }

  // Approving here auto-creates an invoice and pushes it to Xero (see
  // approve() above) — per Justin's explicit requirement, that action must
  // stay admin-only so technicians can never trigger an invoice/Xero push.
  const isAdmin = role === "admin";

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Job Approvals</h1>
        <p className="text-slate-500 text-sm mt-1">{jobs.length} job{jobs.length !== 1 ? "s" : ""} awaiting review</p>
      </div>

      {!isAdmin && (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          View-only — only admins can approve jobs or send them back (approving creates an invoice and pushes it to Xero).
        </div>
      )}

      <UnbilledVariations variations={unbilledVariations} />

      {pendingVariations.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <GitPullRequestArrow className="w-4 h-4 text-orange-600" />
            Variations awaiting pricing ({pendingVariations.length})
          </h2>
          {pendingVariations.map((v) => (
            <Card key={v.id} className="border-orange-100">
              <CardContent className="py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {v.variation_types?.name ?? v.custom_name}{variationQtyText(v) ? ` — ${variationQtyText(v)}` : ""}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    #{v.jobs?.job_number} — {v.jobs?.title} · {v.jobs?.customers?.name}
                  </p>
                  {v.description && <p className="text-xs text-slate-400 mt-1 truncate">{v.description}</p>}
                </div>
                <Link prefetch={false} href={`/dashboard/jobs/${v.jobs?.id}?tab=variations&variation=${v.id}`} className="shrink-0">
                  <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                    Price &amp; review →
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
                        <Clock className="w-3 h-3" />Completed {formatDate(job.updated_at)}
                      </span>
                      {hoursByJob[job.id]?.total > 0 && (
                        <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Timer className="w-3 h-3" />{hoursByJob[job.id].total.toFixed(2)}h to invoice
                        </span>
                      )}
                      {job.overtime_category && (
                        <span className="text-xs font-medium text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />Exceeded hours
                        </span>
                      )}
                    </div>
                  </div>
                  {expanded === job.id ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0 ml-4" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 ml-4" />}
                </button>

                {/* Expanded review panel */}
                {expanded === job.id && (
                  <div className="border-t px-6 py-4 space-y-4 bg-slate-50">
                    <div className="flex gap-3">
                      <Link prefetch={false} href={`/dashboard/jobs/${job.id}`} className="text-xs text-blue-600 hover:underline">
                        View full job details →
                      </Link>
                    </div>

                    {job.overtime_category && (
                      <div className="bg-orange-50 border border-orange-200 rounded-md px-3 py-2">
                        <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5" />Exceeded allocated hours
                        </p>
                        <p className="text-sm text-slate-700 mt-1">
                          {OVERTIME_LABELS[job.overtime_category] ?? job.overtime_category}
                          {job.overtime_reason ? ` — ${job.overtime_reason}` : ""}
                        </p>
                        <p className="text-xs text-slate-400 mt-1">
                          Logged by {job.overtime_logged_by_profile?.full_name ?? "—"}
                          {job.overtime_logged_at ? ` on ${formatDate(job.overtime_logged_at)}` : ""}
                        </p>
                      </div>
                    )}

                    <JobHoursPanel summary={hoursByJob[job.id]} />

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

                    {isAdmin ? (
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
                    ) : (
                      <p className="text-xs text-slate-400 italic">Only admins can approve or send back jobs.</p>
                    )}
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

// What approving will carry onto the invoice, by cost centre and technician.
function JobHoursPanel({ summary }: { summary: JobHoursSummary | undefined }) {
  if (summary?.error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700">
        Could not load this job&apos;s hours ({summary.error}). Approving will stop rather than leave them off the invoice.
      </div>
    );
  }
  if (!summary || summary.groups.length === 0) {
    return <p className="text-xs text-slate-400">No clocked hours to invoice on this job.</p>;
  }
  return (
    <div className="bg-white border rounded-md">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide flex items-center gap-1.5">
          <Timer className="w-3.5 h-3.5" />Hours to invoice
        </p>
        <p className="text-sm font-semibold text-slate-900">{summary.total.toFixed(2)}h</p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500">
            <th className="text-left font-medium px-3 py-1.5">Cost centre</th>
            <th className="text-left font-medium px-3 py-1.5">Technician</th>
            <th className="text-right font-medium px-3 py-1.5">Hours</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {summary.groups.map((g) => (
            <tr key={g.key}>
              <td className="px-3 py-1.5 text-slate-700">{g.costCentreName ?? <span className="text-slate-400">No cost centre</span>}</td>
              <td className="px-3 py-1.5 text-slate-700">{g.staffName}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{g.hours.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 border-t text-xs text-slate-500">
        These hours go onto the job&apos;s draft invoice. Price them there with <span className="font-medium">Apply hourly rate</span>; the invoice is not pushed to Xero until they are.
      </p>
    </div>
  );
}
