"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Plus, Mail, Phone, Shield, Wrench, Monitor } from "lucide-react";

const roleColors: Record<string, string> = {
  admin: "bg-purple-100 text-purple-700",
  office: "bg-blue-100 text-blue-700",
  technician: "bg-green-100 text-green-700",
};

const roleIcons: Record<string, any> = {
  admin: Shield,
  office: Monitor,
  technician: Wrench,
};

export default function StaffPage() {
  const supabase = createClient();
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", role: "technician" });
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase.from("profiles").select("*").order("full_name");
      if (error) setFetchError(error.message);
      setStaff(data ?? []);
      setLoading(false);
    }
    load();
  }, []);

  function setField(field: string, value: string) {
    setForm(p => ({ ...p, [field]: value }));
    if (errors[field]) setErrors(p => ({ ...p, [field]: false }));
  }

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  async function handleInvite() {
    const newErrors: Record<string, boolean> = {};
    if (!form.full_name.trim()) newErrors.full_name = true;
    if (!form.email.trim()) newErrors.email = true;
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }

    setSaving(true);
    const res = await fetch("/api/staff/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();

    if (!res.ok) {
      toast.error(data.error ?? "Failed to invite staff member");
    } else {
      toast.success(`Invite sent to ${form.email}`);
      setShowForm(false);
      setForm({ full_name: "", email: "", phone: "", role: "technician" });
      const { data: updated } = await supabase.from("profiles").select("*").order("full_name");
      setStaff(updated ?? []);
    }
    setSaving(false);
  }

  async function toggleActive(id: string, current: boolean) {
    await supabase.from("profiles").update({ is_active: !current }).eq("id", id);
    setStaff(s => s.map(m => m.id === id ? { ...m, is_active: !current } : m));
    toast.success(current ? "Staff member deactivated" : "Staff member reactivated");
  }

  if (loading) return <div className="p-6 text-slate-400 text-sm">Loading...</div>;
  if (fetchError) return <div className="p-6 text-red-500 text-sm">Error loading staff: {fetchError}</div>;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Staff</h1>
          <p className="text-slate-500 text-sm mt-1">{staff.filter(s => s.is_active).length} active team members</p>
        </div>
        <Button className="gap-2" onClick={() => setShowForm(v => !v)}>
          <Plus className="w-4 h-4" />Add Staff
        </Button>
      </div>

      {/* Invite form */}
      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">Invite Team Member</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Full Name *</Label>
                <Input value={form.full_name} onChange={e => setField("full_name", e.target.value)} placeholder="e.g. Jane Smith" className={fieldErr("full_name")} />
                {errors.full_name && <p className="text-xs text-red-500">Name is required</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Email *</Label>
                <Input type="email" value={form.email} onChange={e => setField("email", e.target.value)} placeholder="jane@example.com" className={fieldErr("email")} />
                {errors.email && <p className="text-xs text-red-500">Email is required</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={e => setField("phone", e.target.value)} placeholder="04xx xxx xxx" />
              </div>
              <div className="space-y-1.5">
                <Label>Role *</Label>
                <Select value={form.role} onValueChange={v => setField("role", v ?? "technician")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="office">Office</SelectItem>
                    <SelectItem value="technician">Technician</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-slate-400">They'll receive an email to set their own password and log in.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button onClick={handleInvite} disabled={saving}>{saving ? "Sending invite..." : "Send Invite"}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Staff list */}
      <Card>
        <CardContent className="p-0">
          {staff.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Users className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">No staff added yet</p>
            </div>
          ) : (
            <div className="divide-y">
              {staff.map(member => {
                const RoleIcon = roleIcons[member.role] ?? Shield;
                return (
                  <div key={member.id} className="flex items-center justify-between px-6 py-4">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-semibold text-sm">
                        {(member.full_name ?? "?").split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm text-slate-900">{member.full_name}</p>
                          {!member.is_active && <span className="text-xs text-slate-400">(inactive)</span>}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-xs text-slate-500 flex items-center gap-1">
                            <Mail className="w-3 h-3" />{member.email}
                          </span>
                          {member.phone && (
                            <span className="text-xs text-slate-500 flex items-center gap-1">
                              <Phone className="w-3 h-3" />{member.phone}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex items-center gap-1 ${roleColors[member.role]}`}>
                        <RoleIcon className="w-3 h-3" />{member.role}
                      </span>
                      <Button
                        variant="ghost" size="sm"
                        className={`text-xs h-7 ${member.is_active ? "text-slate-400 hover:text-red-500" : "text-slate-400 hover:text-green-600"}`}
                        onClick={() => toggleActive(member.id, member.is_active)}
                      >
                        {member.is_active ? "Deactivate" : "Reactivate"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
