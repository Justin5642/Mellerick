"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";

export interface CreatedCustomer {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  is_favorite: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefills the name — usually whatever was typed into the picker that found nothing. */
  initialName?: string;
  onCreated: (customer: CreatedCustomer) => void;
}

const emptyForm = { name: "", company: "", phone: "", mobile: "", email: "" };

// Adds a customer from inside the customer picker (New Job / Quote / Invoice)
// when a search comes up empty, instead of abandoning the half-filled form to
// go to Customers → New and back. Same insert as app/dashboard/customers/new,
// trimmed to the fields needed to book work; ABN and notes stay on the full
// customer page. Mirrors AddSiteDialog, which does the same for sites.
export function AddCustomerDialog({ open, onOpenChange, initialName, onCreated }: Props) {
  const supabase = createClient();
  const [form, setForm] = useState(emptyForm);
  const [nameError, setNameError] = useState(false);
  const [saving, setSaving] = useState(false);

  // Each opening starts from what was typed, not from the last attempt.
  useEffect(() => {
    if (open) {
      setForm({ ...emptyForm, name: initialName?.trim() ?? "" });
      setNameError(false);
    }
  }, [open, initialName]);

  function set(field: keyof typeof emptyForm, value: string) {
    setForm((p) => ({ ...p, [field]: value }));
    if (field === "name") setNameError(false);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setNameError(true);
      return;
    }
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: form.name.trim(),
        company: form.company.trim() || null,
        phone: form.phone.trim() || null,
        mobile: form.mobile.trim() || null,
        email: form.email.trim() || null,
        created_by: user?.id,
      })
      .select("id, name, company, phone, email, is_favorite")
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error(error?.message ?? "Failed to add customer");
      return;
    }
    toast.success("Customer added");
    onCreated(data);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Customer</DialogTitle>
          <DialogDescription>
            They&apos;ll be selected on this form straight away. ABN and notes can be added later on the customer&apos;s page.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            // Inside another form (the job/quote/invoice), so stop the outer
            // one submitting too.
            e.stopPropagation();
            handleSave();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-customer-name">Full Name *</Label>
            <Input
              id="new-customer-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="John Smith"
              autoFocus
              className={nameError ? "border-red-500 focus-visible:ring-red-500" : ""}
            />
            {nameError && <p className="text-xs text-red-500">A name is required.</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-customer-company">Company</Label>
            <Input id="new-customer-company" value={form.company} onChange={(e) => set("company", e.target.value)} placeholder="Smith Enterprises" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-customer-phone">Phone</Label>
              <Input id="new-customer-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="02 1234 5678" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-customer-mobile">Mobile</Label>
              <Input id="new-customer-mobile" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="0400 123 456" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-customer-email">Email</Label>
            <Input id="new-customer-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="john@example.com" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-1" /> Saving...</> : "Add Customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
