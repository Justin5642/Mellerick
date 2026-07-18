"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { fromBusinessInputValue, toBusinessInputValue } from "@/lib/date";
import { CustomerPicker } from "@/components/customer-picker";

// Radix/shadcn's SelectItem can't take value="", so an explicit "Unassigned"
// option needs a sentinel value that gets translated back to "" (-> null on
// save) instead of colliding with a real staff id.
const UNASSIGNED_VALUE = "__unassigned__";

export default function NewJobPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [staff, setStaff] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);

  // Lets links like the Customer detail page's "+ Add Job" button
  // (/dashboard/jobs/new?customer_id=...) preselect the customer instead of
  // making staff search for them again — same pattern already used by
  // quotes/new and invoices/new.
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const [form, setForm] = useState({
    title: "", description: "", customer_id: params?.get("customer_id") ?? "", site_id: "", assigned_to: "",
    status: "pending", priority: "normal", job_type: "service",
    scheduled_start: "", scheduled_end: "", notes: "",
  });

  useEffect(() => {
    async function load() {
      const { data: s } = await supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name");
      setStaff(s ?? []);
    }
    load();
  }, []);

  useEffect(() => {
    async function loadSites() {
      if (!form.customer_id) { setSites([]); return; }
      const { data } = await supabase.from("sites").select("id, name, suburb").eq("customer_id", form.customer_id);
      setSites(data ?? []);
    }
    loadSites();
  }, [form.customer_id]);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const payload: any = {
      ...form,
      assigned_to: form.assigned_to || null,
      site_id: form.site_id || null,
      scheduled_start: form.scheduled_start ? fromBusinessInputValue(form.scheduled_start) : null,
      scheduled_end: form.scheduled_end ? fromBusinessInputValue(form.scheduled_end) : null,
    };
    const { data, error } = await supabase.from("jobs").insert(payload).select("id").single();
    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
      if (data?.id) {
        fetch(`/api/jobs/${data.id}/sync-calendar`, { method: "POST" }).catch(() => {});
      }
      toast.success("Job created successfully");
      window.location.href = "/dashboard/jobs";
    }
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
                <CustomerPicker value={form.customer_id} onChange={(v) => set("customer_id", v)} placeholder="Search customers..." />
              </div>
              <div className="space-y-2">
                <Label>Site</Label>
                <Select value={form.site_id} onValueChange={(v) => set("site_id", v as string)} disabled={!form.customer_id}>
                  <SelectTrigger><SelectValue placeholder={form.customer_id ? "Select site" : "Select customer first"} /></SelectTrigger>
                  <SelectContent>
                    {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} — {s.suburb}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Assign To</Label>
                <Select
                  value={form.assigned_to || UNASSIGNED_VALUE}
                  onValueChange={(v) => set("assigned_to", v === UNASSIGNED_VALUE ? "" : v)}
                >
                  <SelectTrigger><SelectValue placeholder="Select technician" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                    {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.full_name} ({s.role})</SelectItem>)}
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
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="scheduled_start">Scheduled Start</Label>
                  <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={setAllDay}>All Day (7:00–3:30)</Button>
                </div>
                <Input id="scheduled_start" type="datetime-local" value={form.scheduled_start} onChange={(e) => set("scheduled_start", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scheduled_end">Scheduled End</Label>
                <Input id="scheduled_end" type="datetime-local" value={form.scheduled_end} onChange={(e) => set("scheduled_end", e.target.value)} />
              </div>
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
    </div>
  );
}
