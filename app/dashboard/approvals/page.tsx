"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, XCircle, ClipboardList, Clock, User, MapPin, ChevronDown, ChevronUp, AlertTriangle, GitPullRequestArrow } from "lucide-react";
import Link from "next/link";
import { formatDate } from "@/lib/date";

const OVERTIME_LABELS: Record<string, string> = {
  unexpected_issue: "Unexpected issue",
  difficult_site: "Difficult site",
  training_needed: "Training needed",
  other: "Other",
};

export default function ApprovalsPage() {
  const supabase = createClient();
  const [jobs, setJobs] = useState<any[]>([]);
  const [pendingVariations, setPendingVariations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const [{ data: { user } }, { data }, { data: variations }] = await Promise.all([
        supabase.auth.getUser(),
        supabase
          .from("jobs")
          .select("*, customers(name), sites(name, address_line1, suburb), overtime_logged_by_profile:profiles!jobs_overtime_logged_by_fkey(full_name)")
          .eq("status", "completed")
          .eq("admin_status", "pending")
          .order("updated_at", { ascending: false }),
        supabase
          .from("job_variations")
          .select("*, variation_types(name), jobs(id, job_number, title, customers(name))")
          .eq("status", "pending_approval")
          .order("created_at", { ascending: false }),
      ]);
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
      setJobs(data ?? []);
      setPendingVariations(variations ?? []);
      setLoading(false);
    }
    load();
  }, []);

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
    const job = jobs.find((j) => j.id === jobId);

    // Guard against double-creating an invoice if one already exists for
    // this job (e.g. office manually built one before approval finished).
    const { data: existingInvoice } = await supabase
      .from("invoices")
      .select("id, xero_invoice_id")
      .eq("job_id", jobId)
      .maybeSingle();

    let invoiceId: string | null = existingInvoice?.id ?? null;
    const alreadyPushed = !!existingInvoice?.xero_invoice_id;
    let invoiceCreated = false;

    if (!invoiceId && job) {
      const { data: items } = await supabase.from("job_items").select("*").eq("job_id", jobId);
      if (items && items.length > 0) {
        const subtotal = items.reduce((sum: number, i: any) => sum + Number(i.total ?? Number(i.quantity) * Number(i.unit_price)), 0);
        const gst = subtotal * 0.1;
        const total = subtotal + gst;
        const { data: { user } } = await supabase.auth.getUser();

        const { data: newInvoice, error: invErr } = await supabase
          .from("invoices")
          .insert({
            customer_id: job.customer_id,
            job_id: jobId,
            title: `#${job.job_number} — ${job.title}`,
            status: "draft",
            subtotal,
            tax_amount: gst,
            total,
            created_by: user?.id ?? null,
          })
          .select()
          .single();

        if (!invErr && newInvoice) {
          await supabase.from("invoice_items").insert(
            items.map((i: any) => ({
              invoice_id: newInvoice.id,
              pricing_item_id: i.pricing_item_id ?? null,
              name: i.name,
              description: i.description,
              quantity: i.quantity,
              unit_price: i.unit_price,
            }))
          );
          invoiceId = newInvoice.id;
          invoiceCreated = true;
        }
      }
    }

    await supabase
      .from("jobs")
      .update({
        admin_status: "approved",
        admin_notes: notes[jobId] || null,
        // Still flagged "ready to invoice" if we couldn't auto-create one
        // (no line items yet) so it shows up for manual invoicing.
        ready_to_invoice: !invoiceId,
      })
      .eq("id", jobId);

    setJobs((j) => j.filter((job) => job.id !== jobId));

    if (invoiceId && !alreadyPushed) {
      try {
        const res = await fetch("/api/xero/push-invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        toast.success("Job approved — invoice created and pushed to Xero");
      } catch (err: any) {
        toast.success(invoiceCreated ? "Job approved — invoice created (draft, not yet in Xero)" : "Job approved");
        toast.error(`Xero push failed: ${err.message ?? "unknown error"} — push manually from the invoice page`);
      }
    } else if (invoiceId && alreadyPushed) {
      toast.success("Job approved — invoice already synced to Xero");
    } else {
      toast.success("Job approved — moved to invoicing queue (no line items yet, create the invoice manually)");
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
    await supabase.from("jobs").update({
      admin_status: "rejected",
      admin_notes: notes[jobId],
      status: "in_progress",
      ready_to_invoice: false,
    }).eq("id", jobId);
    fetch(`/api/jobs/${jobId}/sync-calendar`, { method: "POST" }).catch(() => {});
    setJobs(j => j.filter(job => job.id !== jobId));
    toast.success("Job sent back — technician will be notified");
    setSaving(null);
  }

  if (loading) return <div className="p-6 text-slate-400 text-sm">Loading...</div>;

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
                    {v.variation_types?.name ?? v.custom_name} — {v.quantity} {v.unit}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    #{v.jobs?.job_number} — {v.jobs?.title} · {v.jobs?.customers?.name}
                  </p>
                  {v.description && <p className="text-xs text-slate-400 mt-1 truncate">{v.description}</p>}
                </div>
                <Link href={`/dashboard/jobs/${v.jobs?.id}?tab=variations&variation=${v.id}`} className="shrink-0">
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
                      <Link href={`/dashboard/jobs/${job.id}`} className="text-xs text-blue-600 hover:underline">
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
