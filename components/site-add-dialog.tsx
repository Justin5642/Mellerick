"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MapPin, Loader2 } from "lucide-react";

interface Props {
  customerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (site: any) => void;
}

const emptyForm = { name: "", address_line1: "", address_line2: "", suburb: "", state: "", postcode: "" };

// Lets a new job site be added for a customer/builder right from wherever a
// site is being picked (New Job form, Job Overview) instead of requiring a
// separate trip somewhere else to create it first — there was previously no
// site-creation UI anywhere in the app at all. Inserts straight into the
// shared `sites` table scoped to this customer_id, so it shows up on the
// Customer detail page's Sites list automatically, no extra step needed.
export function AddSiteDialog({ customerId, open, onOpenChange, onCreated }: Props) {
  const supabase = createClient();
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const [geocoding, setGeocoding] = useState(false);
  const [geocoded, setGeocoded] = useState<{ lat: number; lng: number; display: string } | null>(null);
  const [saving, setSaving] = useState(false);

  function set(field: string, value: string) {
    setForm((p) => ({ ...p, [field]: value }));
    if (errors[field]) setErrors((p) => ({ ...p, [field]: false }));
    if (["address_line1", "suburb", "state", "postcode"].includes(field)) setGeocoded(null);
  }

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  function reset() {
    setForm(emptyForm);
    setErrors({});
    setGeocoded(null);
  }

  async function geocode() {
    if (!form.address_line1.trim() || !form.suburb.trim()) return;
    const addr = `${form.address_line1}, ${form.suburb} ${form.state} ${form.postcode}`.trim();
    setGeocoding(true);
    try {
      const res = await fetch(`/api/geocode?address=${encodeURIComponent(addr)}`);
      const data = await res.json();
      if (res.ok) {
        setGeocoded(data);
        toast.success("Address confirmed");
      } else {
        toast.error("Address not found — check the details and try again");
      }
    } catch {
      toast.error("Address lookup failed");
    } finally {
      setGeocoding(false);
    }
  }

  async function handleSave() {
    const newErrors: Record<string, boolean> = {};
    if (!form.name.trim()) newErrors.name = true;
    if (!form.address_line1.trim()) newErrors.address_line1 = true;
    if (!form.suburb.trim()) newErrors.suburb = true;
    if (!form.state.trim()) newErrors.state = true;
    if (!form.postcode.trim()) newErrors.postcode = true;
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }
    setSaving(true);
    const { data, error } = await supabase
      .from("sites")
      .insert({
        customer_id: customerId,
        name: form.name.trim(),
        address_line1: form.address_line1.trim(),
        address_line2: form.address_line2.trim() || null,
        suburb: form.suburb.trim(),
        state: form.state.trim(),
        postcode: form.postcode.trim(),
        site_lat: geocoded?.lat ?? null,
        site_lng: geocoded?.lng ?? null,
      })
      .select()
      .single();
    setSaving(false);
    if (error || !data) {
      toast.error("Failed to add site");
      return;
    }
    toast.success("Site added");
    onCreated(data);
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Site</DialogTitle>
          <DialogDescription>
            Adds a job site for this customer — it&apos;ll also show up on their Customer page&apos;s Sites list.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Site Name *</Label>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Lot 12 - Riverside Estate"
              className={fieldErr("name")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Address Line 1 *</Label>
            <Input
              value={form.address_line1}
              onChange={(e) => set("address_line1", e.target.value)}
              placeholder="123 Main St"
              className={fieldErr("address_line1")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Address Line 2</Label>
            <Input value={form.address_line2} onChange={(e) => set("address_line2", e.target.value)} placeholder="Optional" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label>Suburb *</Label>
              <Input value={form.suburb} onChange={(e) => set("suburb", e.target.value)} className={fieldErr("suburb")} />
            </div>
            <div className="space-y-1.5">
              <Label>State *</Label>
              <Input value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase())} placeholder="VIC" className={fieldErr("state")} />
            </div>
            <div className="space-y-1.5">
              <Label>Postcode *</Label>
              <Input value={form.postcode} onChange={(e) => set("postcode", e.target.value)} className={fieldErr("postcode")} />
            </div>
          </div>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={geocode}
              disabled={geocoding || !form.address_line1.trim() || !form.suburb.trim()}
            >
              {geocoding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
              Confirm Location
            </Button>
            {geocoded ? (
              <p className="text-xs text-green-600 flex items-center gap-1.5 mt-1.5">
                <MapPin className="w-3 h-3" />Confirmed: {geocoded.display.split(",").slice(0, 3).join(",")}
              </p>
            ) : (
              <p className="text-xs text-slate-400 mt-1.5">Optional — enables precise Waze navigation for this site</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Adding..." : "Add Site"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
