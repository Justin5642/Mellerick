"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MapPin, Loader2 } from "lucide-react";
import {
  composeSiteNotes,
  findDuplicateSite,
  validateSiteAddress,
  type SiteAddressField,
} from "@/lib/site-address";

/** The columns the job forms' site pickers show. */
export interface PickedSite {
  id: string;
  name: string;
  suburb: string | null;
}

interface Props {
  customerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The site to select in the job form: the one just saved, or — when the
   * address was already one of this customer's sites — that existing site.
   * Called only after the server has answered.
   */
  onCreated: (site: PickedSite) => void;
}

const emptyForm = { name: "", address_line1: "", address_line2: "", suburb: "", state: "VIC", postcode: "", contact: "", access: "" };
type FormField = keyof typeof emptyForm;

const SITE_COLUMNS = "id, name, suburb, address_line1, address_line2, state, postcode, is_active";

// Lets a new job site be added for a customer/builder right from wherever a
// site is being picked (New Job form, Job Overview) without leaving the form:
// the dialog sits over the page, so everything already typed there is kept.
// Inserts into the shared `sites` table for this customer_id, so it also shows
// on the Customer page's Sites list.
//
// Address rules and the duplicate check are lib/site-address.ts, shared with
// the phone. The duplicate check reads the customer's sites from the server at
// save time (not the picker's list, which may be stale); a match offers that
// site instead of a second copy. A database-level guard is not in place —
// two people saving the same address at the same moment could still both
// succeed.
//
// Coordinates: "Confirm location" geocodes now; otherwise the hourly
// /api/sites/geocode-missing cron fills them (new sites have no
// geocode_attempted_at, so they are picked up on its next run).
export function AddSiteDialog({ customerId, open, onOpenChange, onCreated }: Props) {
  const supabase = createClient();
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<Partial<Record<SiteAddressField, string>>>({});
  const [geocoding, setGeocoding] = useState(false);
  const [geocoded, setGeocoded] = useState<{ lat: number; lng: number; display: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [duplicate, setDuplicate] = useState<PickedSite | null>(null);

  function set(field: FormField, value: string) {
    setForm((p) => ({ ...p, [field]: value }));
    if (field in errors) setErrors((p) => ({ ...p, [field]: undefined }));
    if (["address_line1", "address_line2", "suburb", "state", "postcode"].includes(field)) {
      setGeocoded(null);
      setDuplicate(null);
    }
  }

  function fieldErr(field: SiteAddressField) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  function errorText(field: SiteAddressField) {
    return errors[field] ? <p className="text-xs text-red-600">{errors[field]}</p> : null;
  }

  function reset() {
    setForm(emptyForm);
    setErrors({});
    setGeocoded(null);
    setDuplicate(null);
  }

  function close() {
    onOpenChange(false);
    reset();
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
    if (saving || !customerId) return;
    const checked = validateSiteAddress(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      // Fresh from the server: another tab or the phone may have added it.
      const { data: existing, error: listError } = await supabase
        .from("sites")
        .select(SITE_COLUMNS)
        .eq("customer_id", customerId)
        .eq("is_active", true);
      if (listError) {
        console.error("add site: duplicate check failed", listError);
        toast.error("Couldn't check this customer's sites. Try again.");
        return;
      }
      const dup = findDuplicateSite(checked.value, existing ?? []);
      if (dup) {
        setDuplicate({ id: dup.id, name: dup.name ?? "", suburb: dup.suburb ?? null });
        return;
      }
      const v = checked.value;
      const { data, error } = await supabase
        .from("sites")
        .insert({
          customer_id: customerId,
          name: v.name,
          address_line1: v.address_line1,
          address_line2: v.address_line2,
          suburb: v.suburb,
          state: v.state,
          postcode: v.postcode,
          notes: composeSiteNotes({ contact: form.contact, access: form.access }),
          site_lat: geocoded?.lat ?? null,
          site_lng: geocoded?.lng ?? null,
        })
        .select("id, name, suburb")
        .single();
      if (error || !data) {
        console.error("add site: insert failed", error);
        toast.error("The site wasn't saved. Check your connection and try again.");
        return;
      }
      // Only now — the server has the row and returned its id.
      toast.success("Site added");
      onCreated(data as PickedSite);
      close();
    } finally {
      setSaving(false);
    }
  }

  function pickExisting() {
    if (!duplicate) return;
    onCreated(duplicate);
    toast.success(`Selected the existing site "${duplicate.name}"`);
    close();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (saving) return;
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add New Site</DialogTitle>
          <DialogDescription>
            Saved against this customer and selected on the job. It&apos;ll also show on their Customer page.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            // This dialog is portalled, but stop a submit reaching the job form anyway.
            e.preventDefault();
            e.stopPropagation();
            void handleSave();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="site-line1">Street address *</Label>
            <Input
              id="site-line1"
              value={form.address_line1}
              onChange={(e) => set("address_line1", e.target.value)}
              placeholder="12 Smith St"
              autoComplete="off"
              className={fieldErr("address_line1")}
            />
            {errorText("address_line1")}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-line2">Address line 2</Label>
            <Input id="site-line2" value={form.address_line2} onChange={(e) => set("address_line2", e.target.value)} placeholder="Unit, lot (optional)" autoComplete="off" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div className="space-y-1.5 col-span-2 sm:col-span-1">
              <Label htmlFor="site-suburb">Suburb *</Label>
              <Input id="site-suburb" value={form.suburb} onChange={(e) => set("suburb", e.target.value)} autoComplete="off" className={fieldErr("suburb")} />
              {errorText("suburb")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="site-state">State *</Label>
              <Input id="site-state" value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase())} placeholder="VIC" autoComplete="off" className={fieldErr("state")} />
              {errorText("state")}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="site-postcode">Postcode *</Label>
              <Input id="site-postcode" value={form.postcode} onChange={(e) => set("postcode", e.target.value)} inputMode="numeric" maxLength={4} autoComplete="off" className={fieldErr("postcode")} />
              {errorText("postcode")}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-name">Site name</Label>
            <Input
              id="site-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Optional — e.g. Lot 12 Riverside Estate (defaults to the street)"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-contact">Site contact</Label>
            <Input id="site-contact" value={form.contact} onChange={(e) => set("contact", e.target.value)} placeholder="Name and phone (optional)" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="site-access">Access notes</Label>
            <Textarea id="site-access" value={form.access} onChange={(e) => set("access", e.target.value)} placeholder="Gate code, parking, dogs… (optional)" rows={2} />
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
              <p className="text-xs text-slate-400 mt-1.5">Optional — otherwise the map pin is looked up automatically within the hour</p>
            )}
          </div>
          {duplicate && (
            <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
              <p>
                This customer already has a site at this address: <strong>{duplicate.name}</strong>
                {duplicate.suburb ? ` — ${duplicate.suburb}` : ""}.
              </p>
              <Button type="button" size="sm" onClick={pickExisting}>Use existing site</Button>
            </div>
          )}
          {/* Hidden submit so Enter in a field saves the site. */}
          <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !!duplicate}>
            {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />Saving…</> : "Add Site"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
