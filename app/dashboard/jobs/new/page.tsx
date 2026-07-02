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

export default function NewJobPage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [form, setForm] = useState({
    title: "", description: "", customer_id: "", site_id: "", assigned_to: "",
    status: "pending", priority: "normal", job_type: "service",
    scheduled_start: "", scheduled_end: "", notes: "",
  });

  useEffect(() => {
    async function load() {
      const [{ data: c }, { data: s }] = await Promise.all([
        supabase.from("customers").select("id, name").eq("is_active", true).order("name"),
        supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
      ]);
      setCustomers(c ?? []);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const payload: any = {
      ...form,
      assigned_to: form.assigned_to || null,
      site_id: form.site_id || null,
      scheduled_start: form.scheduled_start || null,
      scheduled_end: form.scheduled_end || null,
    };
    const { error } = await supabase.from("jobs").insert(payload);
    if (error) {
      toast.error(error.message);
      setLoading(false);
    } else {
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
                <Select value={form.customer_id} onValueChange={(v) => set("customer_id", v as string)}>
                  <SelectTrigger><SelectValue placeholder="Select customer" /></SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
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
                <Select value={form.assigned_to} onValueChange={(v) => set("assigned_to", v)}>
                  <SelectTrigger><SelectValue placeholder="Select technician" /></SelectTrigger>
                  <SelectContent>
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
                <Label htmlFor="scheduled_start">Scheduled Start</Label>
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
