"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Camera, Loader2 } from "lucide-react";
import Link from "next/link";
import { WATER_AUTHORITIES, DEVICE_TYPES, PROTECTION_TYPES } from "@/lib/backflow";

const NO_SITE_VALUE = "__no_site__";

export default function NewBackflowDevicePage() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [customers, setCustomers] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [form, setForm] = useState({
    customer_id: "",
    site_id: "",
    water_authority: "",
    device_type: "",
    protection_type: "",
    make: "",
    model: "",
    serial_number: "",
    size_mm: "",
    location_description: "",
    water_authority_property_number: "",
    water_meter_number: "",
    fire_service_meter_number: "",
    test_frequency_months: "12",
    notes: "",
  });

  useEffect(() => {
    supabase.from("customers").select("id, name").eq("is_active", true).order("name").then(({ data }) => setCustomers(data ?? []));
  }, []);

  useEffect(() => {
    if (!form.customer_id) { setSites([]); return; }
    supabase.from("sites").select("id, name, suburb").eq("customer_id", form.customer_id).then(({ data }) => setSites(data ?? []));
  }, [form.customer_id]);

  function set(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // reader.result is a data URL ("data:image/jpeg;base64,xxxx") — strip
        // the prefix, the API route reattaches its own with the mime type.
        const result = reader.result as string;
        resolve(result.split(",")[1] ?? "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;

    setScanning(true);
    try {
      const imageBase64 = await fileToBase64(file);
      const res = await fetch("/api/backflow/scan-data-plate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64, mimeType: file.type || "image/jpeg" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to read data plate");

      const result = data.result as {
        make: string | null;
        model: string | null;
        serial_number: string | null;
        size_mm: number | null;
        device_type: string | null;
        additional_details: string | null;
      };

      const found: string[] = [];
      setForm((prev) => {
        const next = { ...prev };
        if (result.make) { next.make = result.make; found.push("make"); }
        if (result.model) { next.model = result.model; found.push("model"); }
        if (result.serial_number) { next.serial_number = result.serial_number; found.push("serial no."); }
        if (result.size_mm) { next.size_mm = String(result.size_mm); found.push("size"); }
        if (result.device_type) { next.device_type = result.device_type; found.push("device type"); }
        if (result.additional_details) {
          next.notes = next.notes ? `${next.notes}\n\n${result.additional_details}` : result.additional_details;
        }
        return next;
      });

      if (found.length === 0) {
        toast.warning("Couldn't read anything confidently off that plate — try a clearer, straighter-on photo.");
      } else {
        toast.success(`Read ${found.join(", ")} off the plate. Double-check before saving.`);
      }
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to read data plate");
    } finally {
      setScanning(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customer_id || !form.water_authority || !form.device_type) {
      toast.error("Customer, water authority, and device type are required");
      return;
    }
    if (
      !form.water_authority_property_number ||
      !form.protection_type ||
      !form.make ||
      !form.model ||
      !form.serial_number ||
      !form.size_mm ||
      !form.location_description
    ) {
      toast.error(
        "Water authority property no., protection type, make, model, serial no., size, and location are all required — the water authority will reject a certificate missing these."
      );
      return;
    }
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();
    const payload = {
      customer_id: form.customer_id,
      site_id: form.site_id || null,
      water_authority: form.water_authority,
      device_type: form.device_type,
      protection_type: form.protection_type || null,
      make: form.make || null,
      model: form.model || null,
      serial_number: form.serial_number || null,
      size_mm: form.size_mm ? Number(form.size_mm) : null,
      location_description: form.location_description || null,
      water_authority_property_number: form.water_authority_property_number || null,
      water_meter_number: form.water_meter_number || null,
      fire_service_meter_number: form.fire_service_meter_number || null,
      test_frequency_months: Number(form.test_frequency_months) || 12,
      notes: form.notes || null,
      created_by: user?.id ?? null,
    };
    const { data, error } = await supabase.from("backflow_devices").insert(payload).select("id").single();
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    toast.success("Device registered");
    router.push(`/dashboard/backflow/${data.id}`);
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/backflow">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Register Backflow Device</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Property &amp; Authority</CardTitle></CardHeader>
          <CardContent className="space-y-4">
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
                <Select value={form.site_id || NO_SITE_VALUE} onValueChange={(v) => set("site_id", v === NO_SITE_VALUE ? "" : (v as string))} disabled={!form.customer_id}>
                  <SelectTrigger><SelectValue placeholder={form.customer_id ? "Select site (optional)" : "Select customer first"} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SITE_VALUE}>No specific site</SelectItem>
                    {sites.map((s) => <SelectItem key={s.id} value={s.id}>{s.name} — {s.suburb}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Water Authority *</Label>
                <Select value={form.water_authority} onValueChange={(v) => set("water_authority", v as string)}>
                  <SelectTrigger><SelectValue placeholder="Select water authority" /></SelectTrigger>
                  <SelectContent>
                    {WATER_AUTHORITIES.map((w) => <SelectItem key={w.value} value={w.value}>{w.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Test Frequency (months)</Label>
                <Input type="number" min="1" value={form.test_frequency_months} onChange={(e) => set("test_frequency_months", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Water Authority Property No. *</Label>
                <Input required value={form.water_authority_property_number} onChange={(e) => set("water_authority_property_number", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Water Meter No.</Label>
                <Input value={form.water_meter_number} onChange={(e) => set("water_meter_number", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Fire Service Meter No.</Label>
                <Input value={form.fire_service_meter_number} onChange={(e) => set("fire_service_meter_number", e.target.value)} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Device Details</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={scanning}
              onClick={() => fileInputRef.current?.click()}
            >
              {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              {scanning ? "Reading plate..." : "Scan Data Plate"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleScanFile}
            />
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-slate-500 -mt-2">
              Snap a photo of the device&apos;s data plate to auto-fill make, model, serial number, size, and device type below — every plate is different, so review the fields before saving.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Device Type *</Label>
                <Select value={form.device_type} onValueChange={(v) => set("device_type", v as string)}>
                  <SelectTrigger><SelectValue placeholder="Select device type" /></SelectTrigger>
                  <SelectContent>
                    {DEVICE_TYPES.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Protection Type *</Label>
                <Select value={form.protection_type} onValueChange={(v) => set("protection_type", v as string)}>
                  <SelectTrigger><SelectValue placeholder="Select protection type" /></SelectTrigger>
                  <SelectContent>
                    {PROTECTION_TYPES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Make *</Label>
                <Input required value={form.make} onChange={(e) => set("make", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Model *</Label>
                <Input required value={form.model} onChange={(e) => set("model", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Serial No. *</Label>
                <Input required value={form.serial_number} onChange={(e) => set("serial_number", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Size (mm) *</Label>
                <Input required type="number" value={form.size_mm} onChange={(e) => set("size_mm", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Location of Device *</Label>
              <Input required value={form.location_description} onChange={(e) => set("location_description", e.target.value)} placeholder="e.g. Boundary, front garden" />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href="/dashboard/backflow"><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Register Device"}</Button>
        </div>
      </form>
    </div>
  );
}
