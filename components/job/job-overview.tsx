"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Phone, Mail, MapPin, Calendar, User, Save, Navigation } from "lucide-react";
import { formatDate, toBusinessInputValue, fromBusinessInputValue } from "@/lib/date";

interface Props {
  job: any;
  staff: any[];
}

export function JobOverview({ job, staff }: Props) {
  const supabase = createClient();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    status: job.status,
    priority: job.priority,
    assigned_to: job.assigned_to ?? "",
    scheduled_start: job.scheduled_start ? toBusinessInputValue(job.scheduled_start) : "",
    scheduled_end: job.scheduled_end ? toBusinessInputValue(job.scheduled_end) : "",
    description: job.description ?? "",
    notes: job.notes ?? "",
  });

  function set(field: string, value: string | null) {
    setForm((prev) => ({ ...prev, [field]: value ?? "" }));
  }

  // Quick-fill a standard 7:00am-3:30pm work day (Melbourne time) instead of
  // requiring manual entry of both start and end times. Keeps whatever date
  // is already selected (falls back to today) so this can be used after
  // picking a date, or before.
  function setAllDay() {
    const datePart = (form.scheduled_start || toBusinessInputValue(new Date())).slice(0, 10);
    setForm((prev) => ({ ...prev, scheduled_start: `${datePart}T07:00`, scheduled_end: `${datePart}T15:30` }));
  }

  async function save() {
    setSaving(true);
    const { error } = await supabase.from("jobs").update({
      ...form,
      assigned_to: form.assigned_to || null,
      scheduled_start: form.scheduled_start ? fromBusinessInputValue(form.scheduled_start) : null,
      scheduled_end: form.scheduled_end ? fromBusinessInputValue(form.scheduled_end) : null,
    }).eq("id", job.id);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Job updated");
      fetch(`/api/jobs/${job.id}/sync-calendar`, { method: "POST" }).catch(() => {});
    }
    setSaving(false);
  }

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left — editable fields */}
      <div className="lg:col-span-2 space-y-4">
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
                <Select value={form.assigned_to} onValueChange={(v) => set("assigned_to", v)}>
                  <SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger>
                  <SelectContent>
                    {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name} ({s.role})</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Job Type</Label>
                <p className="text-sm text-slate-700 capitalize py-2">{job.job_type}</p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Scheduled Start</Label>
                  <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={setAllDay}>All Day (7:00–3:30)</Button>
                </div>
                <Input type="datetime-local" value={form.scheduled_start} onChange={(e) => set("scheduled_start", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Scheduled End</Label>
                <Input type="datetime-local" value={form.scheduled_end} onChange={(e) => set("scheduled_end", e.target.value)} />
              </div>
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
                <span>{formatDate(job.scheduled_start)}</span>
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
    </div>
  );
}
