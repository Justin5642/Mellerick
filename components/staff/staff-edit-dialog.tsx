"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface StaffMember {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: string;
}

interface Props {
  member: StaffMember;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (updated: StaffMember) => void;
}

export function StaffEditDialog({ member, open, onOpenChange, onSaved }: Props) {
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", role: "technician" });
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      full_name: member.full_name ?? "",
      email: member.email ?? "",
      phone: member.phone ?? "",
      role: member.role ?? "technician",
    });
    setErrors({});
  }, [open, member]);

  function setField(field: string, value: string) {
    setForm(p => ({ ...p, [field]: value }));
    if (errors[field]) setErrors(p => ({ ...p, [field]: false }));
  }

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  async function handleSave() {
    const newErrors: Record<string, boolean> = {};
    if (!form.full_name.trim()) newErrors.full_name = true;
    if (!form.email.trim()) newErrors.email = true;
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }

    setSaving(true);
    const res = await fetch("/api/staff/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: member.id, ...form }),
    });
    const data = await res.json();

    if (!res.ok) {
      toast.error(data.error ?? "Failed to update staff member");
    } else {
      toast.success("Staff member updated");
      onSaved({ id: member.id, ...form });
      onOpenChange(false);
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {member.full_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Full Name *</Label>
              <Input value={form.full_name} onChange={e => setField("full_name", e.target.value)} className={fieldErr("full_name")} />
              {errors.full_name && <p className="text-xs text-red-500">Name is required</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input type="email" value={form.email} onChange={e => setField("email", e.target.value)} className={fieldErr("email")} />
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
          <p className="text-xs text-slate-400">
            Changing the email also updates their login email -- they will need to use the new address to sign in.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Changes"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
