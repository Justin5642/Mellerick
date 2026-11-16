"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CUSTOMER_PO_MAX, normalizeCustomerPo } from "@/lib/customer-po";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Check } from "lucide-react";
import Link from "next/link";
import type { ScheduleInput } from "@/lib/scheduling";
import { emptyScheduleInput, scheduleColumnsFromForm } from "@/lib/schedule-form";
import { CustomerPicker } from "@/components/customer-picker";
import { AddSiteDialog } from "@/components/site-add-dialog";
import { SitePicker } from "@/components/job/site-picker";
import { setJobAssignments, type ScheduleWriteClient } from "@/lib/schedule-dispatch";
import { cn } from "@/lib/utils";
import { ScheduleFields } from "@/components/job/schedule-fields";
import { BuilderPoLines, blankLine, type StageOption } from "@/components/job/builder-po-lines";
import { hasBuilderPo, planBuilderPo, type BuilderPoLineInput, type CostCentreOption } from "@/lib/builder-po";

// The Site picker's first row, "+ Add new site", opens the "Add New Site"
// dialog over the form, instead of making staff go create the site somewhere
// else first. Works for a customer just made with the picker's "+ Add
// customer" too: that dialog saves the customer before selecting it.

export default function NewJobPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [staff, setStaff] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [addSiteOpen, setAddSiteOpen] = useState(false);
  // Sites saved from the dialog → their customer, so a site list still
  // loading for that customer cannot drop the one just added.
  const addedSites = useRef(new Map<string, string>());

  // Lets links like the Customer detail page's "+ Add Job" button
  // (/dashboard/jobs/new?customer_id=...) preselect the customer instead of
  // making staff search for them again — same pattern already used by
  // quotes/new and invoices/new.
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [form, setForm] = useState({
    title: "", description: "", customer_id: params?.get("customer_id") ?? "", site_id: "",
    status: "pending", priority: "normal", job_type: "service",
    notes: "", customer_po: "",
  });
  // Start date, end date, All day and daily times — the same inputs as the
  // Schedule Job wizard. A blank start date creates the job unscheduled.
  const [schedule, setSchedule] = useState<ScheduleInput>(emptyScheduleInput);
  // The crew, in the order picked: the first is the job's primary
  // (jobs.assigned_to). Justin, Nov 2026: jobs are often worked in pairs, so
  // the office can pick more than one technician here.
  const [assignees, setAssignees] = useState<string[]>([]);
  // The builder's PO value and its split by cost centre (Stage 2, 31 Oct
  // 2026): entered here once, it becomes the job's budget on the PO tab and
  // the crew can raise supplier orders against it straight away.
  const [poValue, setPoValue] = useState("");
  const [poLines, setPoLines] = useState<BuilderPoLineInput[]>([blankLine()]);
  const [costCentres, setCostCentres] = useState<CostCentreOption[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [costCentresFailed, setCostCentresFailed] = useState(false);

  useEffect(() => {
    async function load() {
      const [{ data: s }, { data: c, error: cError }, { data: t }] = await Promise.all([
        supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
        supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order"),
        supabase.from("cost_center_templates").select("name, cost_centre_id").eq("is_active", true).order("sort_order"),
      ]);
      setStaff(s ?? []);
      if (cError) console.error("cost centres load failed:", cError);
      setCostCentresFailed(!!cError);
      setCostCentres((c as CostCentreOption[]) ?? []);
      setStages((t as StageOption[]) ?? []);
    }
    load();
  }, []);

  useEffect(() => {
    // A slow answer for the previous customer must not replace this one's list.
    let cancelled = false;
    async function loadSites() {
      if (!form.customer_id) { setSites([]); return; }
      const { data } = await supabase.from("sites").select("id, name, suburb, address_line1").eq("customer_id", form.customer_id).eq("is_active", true);
      if (cancelled) return;
      // Keep a site added in the dialog while this load was in flight.
      setSites((prev) => {
        const loaded = data ?? [];
        const added = prev.filter(
          (p) => addedSites.current.get(p.id) === form.customer_id && !loaded.some((l) => l.id === p.id)
        );
        return [...loaded, ...added];
      });
    }
    loadSites();
    return () => { cancelled = true; };
  }, [form.customer_id]);

  function set(field: string, value: string | null) {
    setForm((prev) => ({ ...prev, [field]: value ?? "" }));
  }

  function toggleAssignee(staffId: string) {
    setAssignees((prev) => (prev.includes(staffId) ? prev.filter((id) => id !== staffId) : [...prev, staffId]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const built = scheduleColumnsFromForm(schedule, { optional: true });
    if (!built.ok) {
      toast.error(built.error);
      return;
    }
    // No value and no lines = no PO yet (a service call, or the PO comes
    // later). Lines with no value make a PO worth their total — a cartage
    // line with hours only is a $0 PO.
    const hasPo = hasBuilderPo({ value: poValue, lines: poLines });
    const planned = hasPo ? planBuilderPo({ value: poValue, lines: poLines }, costCentres) : null;
    if (planned && !planned.ok) {
      toast.error(planned.error);
      return;
    }
    setLoading(true);
    // The crew is saved in two steps, both through paths the database already
    // translates (0059 + 0079), rather than by writing job_bookings here:
    //   1. the job is inserted with the FIRST technician as assigned_to.
    //      0059's collapse trigger makes them the crew; with a schedule, 0079's
    //      jobs_schedule_to_bookings then books that crew on the window (one
    //      unassigned booking if nobody was picked) — exactly what this form
    //      did before it took more than one technician;
    //   2. with more than one, set_job_assignments adds the rest. 0079's
    //      job_assignments_to_bookings gives each new crew member their own
    //      booking on the job's one window (all bookings share it, so it is
    //      never the "several windows" case), so N technicians = N bookings,
    //      not one collapsed booking. Without a schedule there are no
    //      bookings and they simply join the crew.
    // Writing assigned_to alone for everyone would collapse the crew to one
    // person (0059); inserting job_bookings directly would duplicate rules the
    // triggers own. The RPC returns the resulting crew and setJobAssignments
    // checks it, so a technician RLS dropped is reported, not lost silently.
    const payload: any = {
      ...form,
      assigned_to: assignees[0] ?? null,
      site_id: form.site_id || null,
      customer_po: normalizeCustomerPo(form.customer_po),
      ...built.columns,
    };
    const { data, error } = await supabase.from("jobs").insert(payload).select("id, job_number").single();
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    let crewFailed = false;
    if (data?.id && assignees.length > 1) {
      const crew = await setJobAssignments(supabase as unknown as ScheduleWriteClient, data.id, assignees);
      if (!crew.ok) {
        console.error("New job crew not saved:", crew.error);
        crewFailed = true;
        const missing = assignees.slice(1).map((id) => staff.find((s) => s.id === id)?.full_name ?? "a technician");
        toast.error(`Job created, but ${missing.join(" and ")} couldn't be assigned. Add them from Schedule Job on the job.`);
      }
    }
    if (data?.id) {
      // After the crew, so each technician's booking gets its calendar event.
      fetch(`/api/jobs/${data.id}/sync-calendar`, { method: "POST" }).catch(() => {});
    }
    if (data?.id && planned?.ok) {
      const poSaved = await saveBuilderPo(data.id, data.job_number, payload.customer_po, planned.po);
      if (!poSaved) {
        // The job is real; only its PO is missing. Send them to it.
        toast.error("Job created, but its PO didn't save. Add it on the job's PO tab.");
        window.location.href = `/dashboard/jobs/${data.id}?tab=po`;
        return;
      }
    }
    if (data?.id && crewFailed) {
      // The job exists with its first technician; open it to add the rest.
      window.location.href = `/dashboard/jobs/${data.id}`;
      return;
    }
    toast.success("Job created successfully");
    window.location.href = "/dashboard/jobs";
  }

  // The PO row and its split lines. Not atomic with the job: a failure here
  // leaves a job without a PO, which the caller reports.
  async function saveBuilderPo(
    jobId: string,
    jobNumber: number | null,
    customerPo: string | null,
    po: Extract<ReturnType<typeof planBuilderPo>, { ok: true }>["po"]
  ): Promise<boolean> {
    const { data: row, error } = await supabase
      .from("purchase_orders")
      .insert({
        job_id: jobId,
        po_number: customerPo || `${jobNumber ?? "JOB"}-1`,
        total_value: po.value,
        total_hours: po.totalHours,
      })
      .select("id")
      .single();
    if (error || !row) return false;
    if (po.lines.length === 0) return true;
    const { error: linesError } = await supabase.from("po_cost_centers").insert(po.lines.map((l) => ({ ...l, po_id: row.id })));
    return !linesError;
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/jobs">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">New Job</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Job Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Job Title *</Label>
              <Input id="title" value={form.title} onChange={(e) => set("title", e.target.value)} required placeholder="e.g. Fix burst pipe in bathroom" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Customer *</Label>
                <CustomerPicker value={form.customer_id} onChange={(v) => set("customer_id", v)} placeholder="Search customers..." allowCreate />
              </div>
              <div className="space-y-2">
                <Label>Site</Label>
                <SitePicker
                  sites={sites}
                  value={form.site_id}
                  onChange={(id) => set("site_id", id)}
                  onAddNew={() => setAddSiteOpen(true)}
                  disabled={!form.customer_id}
                  placeholder={form.customer_id ? "Select site" : "Select customer first"}
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label>Assign To</Label>
                {/* One or more; same toggles as the Schedule dialog's technicians. */}
                <div className="flex flex-wrap gap-1.5">
                  {staff.map((s) => {
                    const active = assignees.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleAssignee(s.id)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                          active ? "border-blue-500 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50",
                        )}
                      >
                        {active && <Check className="w-3 h-3" />}
                        {s.full_name}
                        {s.role !== "technician" && <span className="text-slate-400">({s.role})</span>}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-slate-400">
                  {assignees.length === 0
                    ? "Nobody picked = unassigned."
                    : assignees.length === 1
                      ? "Tap more names to send a crew."
                      : "Each technician gets their own booking when the job is scheduled."}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Job Type</Label>
                <Select value={form.job_type} onValueChange={(v) => set("job_type", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="installation">Installation</SelectItem>
                    <SelectItem value="maintenance">Maintenance</SelectItem>
                    <SelectItem value="emergency">Emergency</SelectItem>
                    <SelectItem value="quote">Quote</SelectItem>
                    <SelectItem value="project">Project</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => set("priority", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => set("status", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Schedule</Label>
              <ScheduleFields value={schedule} onChange={setSchedule} optional />
            </div>
            <div className="space-y-2">
              <Label htmlFor="customer_po">Builder&apos;s PO number</Label>
              <Input
                id="customer_po"
                value={form.customer_po}
                onChange={(e) => set("customer_po", e.target.value)}
                maxLength={CUSTOMER_PO_MAX}
                placeholder="e.g. 4500123"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="po_value">PO value (ex GST)</Label>
              <Input
                id="po_value"
                inputMode="decimal"
                value={poValue}
                onChange={(e) => setPoValue(e.target.value)}
                placeholder="Blank = the cost centres' total, or no PO yet"
                className="max-w-xs"
              />
            </div>
            <div className="space-y-2">
              <Label>Split across cost centres</Label>
              <p className="text-xs text-slate-400">
                Each cost centre&apos;s share is its budget, e.g. Below Ground Drainage and Transport for a drainage PO.
                A line can be hours only (truck cartage with no price yet). Leave the value and the lines blank for no PO.
              </p>
              <BuilderPoLines
                value={poValue}
                lines={poLines}
                onChange={setPoLines}
                costCentres={costCentres}
                stages={stages}
                loadError={costCentresFailed}
                onCostCentreAdded={(c) => setCostCentres((prev) => [...prev, c])}
                valueFromLines
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Describe the work required..." rows={3} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="notes">Internal Notes</Label>
              <Textarea id="notes" value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Notes for the technician..." rows={2} />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href="/dashboard/jobs"><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Create Job"}</Button>
        </div>
      </form>

      <AddSiteDialog
        customerId={form.customer_id}
        open={addSiteOpen}
        onOpenChange={setAddSiteOpen}
        onCreated={(site) => {
          // The new (or matching existing) site joins the list and is
          // selected; everything else typed on the form is untouched.
          addedSites.current.set(site.id, form.customer_id);
          setSites((prev) => (prev.some((s) => s.id === site.id) ? prev : [...prev, site]));
          set("site_id", site.id);
        }}
      />
    </div>
  );
}
