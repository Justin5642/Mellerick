"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { siteAddress } from "@/lib/geocode";
import type { MapLayer } from "./site-location-map";

const SiteLocationMap = dynamic(() => import("./site-location-map"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-slate-100" />,
});

// Melbourne CBD — where the map opens when nothing better is known.
const FALLBACK: [number, number] = [-37.8136, 144.9631];

export interface LocatableSite {
  id: string;
  name?: string | null;
  address_line1?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  site_lat?: number | null;
  site_lng?: number | null;
}

// "Set location on map": drop the site's pin by hand. For addresses the
// geocoder cannot place precisely — mostly new estate streets OpenStreetMap
// has not mapped house by house yet — which otherwise have no auto clock-in
// geofence. Office/admin only (sites are office-writable, migration 0064).
export function SiteLocationDialog({
  site,
  open,
  onOpenChange,
}: {
  site: LocatableSite;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const hasPin = site.site_lat != null && site.site_lng != null;
  const [center, setCenter] = useState<[number, number]>(hasPin ? [site.site_lat!, site.site_lng!] : FALLBACK);
  const [zoom, setZoom] = useState(hasPin ? 18 : 11);
  const [pin, setPin] = useState<[number, number] | null>(hasPin ? [site.site_lat!, site.site_lng!] : null);
  // Satellite first when there is no pin: the usual reason is a new estate
  // that the street map does not show yet.
  const [layer, setLayer] = useState<MapLayer>(hasPin ? "map" : "satellite");
  const [saving, setSaving] = useState(false);

  // No pin yet: centre on the street or suburb (approximate is fine for where
  // the map opens — only the pin the user places is saved).
  useEffect(() => {
    if (!open || hasPin) return;
    const address = siteAddress(site);
    if (!address) return;
    let cancelled = false;
    fetch(`/api/geocode?approx=1&address=${encodeURIComponent(address)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((found) => {
        if (cancelled || !found) return;
        setCenter([found.lat, found.lng]);
        setZoom(found.precise ? 18 : 16);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, hasPin, site]);

  async function save() {
    if (!pin) return;
    setSaving(true);
    const { error, count } = await createClient()
      .from("sites")
      .update({ site_lat: pin[0], site_lng: pin[1] }, { count: "exact" })
      .eq("id", site.id);
    setSaving(false);
    if (error || count === 0) {
      console.error("site-location: save failed", error);
      toast.error("The location could not be saved.");
      return;
    }
    toast.success("Location saved — auto clock-in will work at this site");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Set location — {site.name ?? site.address_line1}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          Click the map where the job is (the house, lot or slab), or drag the pin. Auto clock-in triggers within 150 m of
          this point.
        </p>
        <div className="flex items-center justify-between gap-2">
          <div className="inline-flex rounded-md border border-slate-200 p-0.5 bg-slate-50">
            {(["map", "satellite"] as const).map((l) => (
              <Button key={l} size="sm" variant={layer === l ? "default" : "ghost"} className="h-7 px-3" onClick={() => setLayer(l)}>
                {l === "map" ? "Map" : "Satellite"}
              </Button>
            ))}
          </div>
          <span className="text-xs text-slate-400 tabular-nums">
            {pin ? `${pin[0].toFixed(5)}, ${pin[1].toFixed(5)}` : "No pin yet"}
          </span>
        </div>
        <div className="h-[420px] w-full overflow-hidden rounded-md border">
          {open && (
            <SiteLocationMap center={center} zoom={zoom} pin={pin} layer={layer} onPick={(lat, lng) => setPin([lat, lng])} />
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={!pin || saving}>{saving ? "Saving..." : "Save location"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
