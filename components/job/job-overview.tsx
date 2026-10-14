"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { applyScheduleChange, type ScheduleWriteClient } from "@/lib/schedule-dispatch";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Phone, Mail, MapPin, Calendar, User, Save, Navigation } from "lucide-react";
import { formatDate } from "@/lib/date";
import type { ScheduleInput } from "@/lib/scheduling";
import { formatScheduleDates, sameScheduleInput, scheduleColumnsFromForm, scheduleFormFromJob } from "@/lib/schedule-form";
import { ScheduleFields } from "./schedule-fields";
import { CustomerPicker } from "@/components/customer-picker";
import { AddSiteDialog } from "@/components/site-add-dialog";

interface Props {
  job: any;
  staff: any[];
}

// Radix/shadcn's SelectItem can't take value="", so an explicit "Unassigned"
// option needs a sentinel value that gets translated back to "" (-> null on
// save) instead of colliding with a real staff id.
const UNASSIGNED_VALUE = "__unassigned__";
// Same trick for "no site selected" — a job can exist without a site.
const NO_SITE_VALUE = "__no_site__";
// Sentinel picked from the Site dropdown itself to open the "Add New Site"
// dialog inline, so a wrong/missing site can be fixed here without a trip to
// the Customer page — same pattern used on the New Job form.
const ADD_NEW_SITE_VALUE = "__add_new_site__";

export function JobOverview({ job, staff }: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [saving, setSaving] = useState(false);
  const [sites, setSites] = useState<any[]>([]);
  const [addSiteOpen, setAddSiteOpen] = useState(false);
  const [form, setForm] = useState({
    title: job.title ?? "",
    job_type: job.job_type ?? "service",
    customer_id: job.customer_id ?? "",
    site_id: job.site_id ?? "",
    status: job.status,
    priority: job.priority,
    assigned_to: job.assigned_to ?? "",
    description: job.description ?? "",
    notes: job.notes ?? "",
  });
  // The schedule as the job was loaded, and as edited here. Start date, end
  // date, All day and daily times — the same inputs as the Schedule Job
  // wizard, writing the same four columns.
  const [savedSchedule, setSavedSchedule] = useState<ScheduleInput>(() => scheduleFormFromJob(job));
  const [schedule, setSchedule] = useState<ScheduleInput>(savedSchedule);

  // The Schedule Job wizard writes the same columns and then refreshes the
  // page; follow it, or this form would show (and compare against) the old
  // schedule until a reload.
  useEffect(() => {
    const fresh = scheduleFormFromJob(job);
    setSavedSchedule(fresh);
    setSchedule(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.scheduled_start, job.scheduled_end, job.schedule_daily, job.schedule_all_day]);

  // Sites belong to a customer, so the site list has to be reloaded whenever
  // the customer changes — same pattern as the "New Job" form. Also runs
  // once on mount so the current site shows up in the dropdown immediately.
  useEffect(() => {
    async function loadSites() {
      if (!form.customer_id) { setSites([]); return; }
      // Active sites only — plus the job's saved site even if it has since
      // been archived, so the dropdown never blanks out an existing value.
      let query = supabase.from("sites").select("id, name, suburb").eq("customer_id", form.customer_id);
      query = job.site_id ? query.or(`is_active.eq.true,id.eq.${job.site_id}`) : query.eq("is_active", true);
      const { data } = await query;
      setSites(data ?? []);
    }
    loadSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.customer_id]);

  function set(field: string, value: string | null) {
    setForm((prev) => ({ ...prev, [field]: value ?? "" }));
  }

  // Changing the customer invalidates whatever site was previously selected
  // (it belongs to the old customer), so clear it rather than silently
  // keeping a site_id that no longer matches the chosen customer.
  function setCustomer(customerId: string) {
    setForm((prev) => ({ ...prev, customer_id: customerId, site_id: "" }));
  }

  async function save() {
    if (!form.title.trim()) {
      toast.error("Job title is required");
      return;
    }
    if (!form.customer_id) {
      toast.error("Customer is required");
      return;
    }
    // The schedule is only rewritten when it was edited here. This form saves
    // on every change of title or status too, and a job whose saved window
    // the inputs cannot express exactly — a pre-0071 block running past
    // midnight or over several days — must not be reshaped by an unrelated
    // save. A blank start date clears all four columns.
    const scheduleEdited = !sameScheduleInput(schedule, savedSchedule);
    const built = scheduleColumnsFromForm(schedule, { optional: true });
    if (scheduleEdited && !built.ok) {
      toast.error(built.error);
      return;
    }
    setSaving(true);
    // This form changes the schedule and the technician, so it goes through the
    // same seam the board does: the write and the Google push are one act with
    // two outcomes. It used to fire the push after `toast.success` and drop the
    // result, so a job could sit with a time the calendar had never heard of —
    // which the poll in lib/google.ts then "corrected" by undoing the edit.
    const result = await applyScheduleChange(supabase as unknown as ScheduleWriteClient, job.id, {
      ...form,
      title: form.title.trim(),
      site_id: form.site_id || null,
      assigned_to: form.assigned_to || null,
      ...(scheduleEdited && built.ok ? built.columns : {}),
    });
    if (!result.ok) {
      toast.error(result.error);
    } else {
      // Saved is saved — but "Job updated" alone would let someone leave
      // believing the technician's calendar shows the new time.
      if (result.calendarSynced) toast.success("Job updated");
      else toast.warning("Job updated — Google Calendar not updated");
      if (scheduleEdited) setSavedSchedule(schedule);
      // customer/site changed => the header and the read-only customer/site
      // cards below (which come from the server-fetched `job` prop, not this
      // form's local state) need a re-fetch to reflect the change.
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left — editable fields */}
      <div className="lg:col-span-2 space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Job Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Job Title *</Label>
              <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Fix burst pipe in bathroom" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Customer *</Label>
                <CustomerPicker value={form.customer_id} onChange={setCustomer} placeholder="Search customers..." />
              </div>
              <div className="space-y-2">
                <Label>Site</Label>
                <Select
                  value={form.site_id || NO_SITE_VALUE}
                  onValueChange={(v) => {
                    if (v === ADD_NEW_SITE_VALUE) { setAddSiteOpen(true); return; }
                    set("site_id", v === NO_SITE_VALUE ? "" : (v as string));
                  }}
                  disabled={!form.customer_id}
                >
                  <SelectTrigger><SelectValue placeholder={form.customer_id ? "Select site" : "Select customer first"} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SITE_VALUE}>No site</SelectItem>
                    <SelectItem value={ADD_NEW_SITE_VALUE}>+ Add new site</SelectItem>
                    {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} — {s.suburb}</SelectItem>)}
                  </SelectContent>
                </Select>
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
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Job Status & Assignment</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                <Label>Assigned Technician</Label>
                <Select
                  value={form.assigned_to || UNASSIGNED_VALUE}
                  onValueChange={(v) => set("assigned_to", v === UNASSIGNED_VALUE ? "" : v)}
                >
                  <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                    {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name} ({s.role})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Schedule</Label>
                {schedule.startDateKey && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setSchedule({ ...schedule, startDateKey: "", endDateKey: "", allDay: false })}
                  >
                    Clear schedule
                  </Button>
                )}
              </div>
              <ScheduleFields value={schedule} onChange={setSchedule} optional />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={3} placeholder="Job description..." />
            </div>
            <div className="space-y-2">
              <Label>Internal Notes</Label>
              <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} placeholder="Notes for the technician..." />
            </div>
            <div className="flex justify-end">
              <Button onClick={save} disabled={saving} className="gap-2">
                <Save className="w-4 h-4" />{saving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Right — customer & site info */}
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Customer</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <span className="text-sm font-medium">{job.customers?.name}</span>
            </div>
            {job.customers?.phone && (
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <a href={`tel:${job.customers.phone}`} className="text-sm text-blue-600 hover:underline">{job.customers.phone}</a>
              </div>
            )}
            {job.customers?.mobile && (
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <a href={`tel:${job.customers.mobile}`} className="text-sm text-blue-600 hover:underline">{job.customers.mobile} (mobile)</a>
              </div>
            )}
            {job.customers?.email && (
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <a href={`mailto:${job.customers.email}`} className="text-sm text-blue-600 hover:underline truncate">{job.customers.email}</a>
              </div>
            )}
          </CardContent>
        </Card>

        {job.sites && (
          <Card>
            <CardHeader><CardTitle className="text-base">Site</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">{job.sites.name}</p>
                  <p className="text-slate-500">{job.sites.address_line1}</p>
                  <p className="text-slate-500">{job.sites.suburb} {job.sites.state} {job.sites.postcode}</p>
                  <a
                    href={
                      job.sites.site_lat && job.sites.site_lng
                        ? `https://waze.com/ul?ll=${job.sites.site_lat},${job.sites.site_lng}&navigate=yes`
                        : `https://waze.com/ul?q=${encodeURIComponent(`${job.sites.address_line1} ${job.sites.suburb} ${job.sites.state}`)}&navigate=yes`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs mt-1"
                  >
                    <Navigation className="w-3 h-3" />
                    Navigate with Waze
                  </a>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Created</span>
              <span>{formatDate(job.created_at)}</span>
            </div>
            {job.scheduled_start && (
              <div className="flex justify-between">
                <span className="text-slate-500">Scheduled</span>
                <span>{job.schedule_daily ? formatScheduleDates(job) : formatDate(job.scheduled_start)}</span>
              </div>
            )}
            {job.actual_start && (
              <div className="flex justify-between">
                <span className="text-slate-500">Started</span>
                <span>{formatDate(job.actual_start)}</span>
              </div>
            )}
            {job.actual_end && (
              <div className="flex justify-between">
                <span className="text-slate-500">Completed</span>
                <span>{formatDate(job.actual_end)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AddSiteDialog
        customerId={form.customer_id}
        open={addSiteOpen}
        onOpenChange={setAddSiteOpen}
        onCreated={(site) => {
          setSites((prev) => [...prev, site]);
          set("site_id", site.id);
        }}
      />
    </div>
  );
}
