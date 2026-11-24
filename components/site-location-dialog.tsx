"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { MapPin, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { siteAddress, type AddressSuggestion } from "@/lib/geocode";
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

/** What the search box starts with: the site's own address, else whatever of it there is. */
function siteSearchText(site: LocatableSite): string {
  return (
    siteAddress(site) ??
    [site.address_line1, site.suburb, site.state, site.postcode].map((p) => (p ?? "").trim()).filter(Boolean).join(", ")
  );
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
  // Address search (24 Nov 2026): type or use the site's own address → pick a
  // match → the pin moves there (an approximate match only recentres the map)
  // → nudge it → Save. Nothing is saved until Save.
  const ownAddress = siteSearchText(site);
  const [query, setQuery] = useState(ownAddress);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<AddressSuggestion[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function runSearch(text: string) {
    const q = text.trim();
    if (q.length < 3) {
      setSearchError("Type at least 3 characters of the address.");
      return;
    }
    setQuery(q);
    setSearching(true);
    setSearchError(null);
    setResults(null);
    try {
      const res = await fetch(`/api/geocode?search=1&q=${encodeURIComponent(q)}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setSearchError(body?.error ?? "Address lookup is unavailable, try again shortly");
        return;
      }
      const found = (body?.results ?? []) as AddressSuggestion[];
      setResults(found);
      if (found.length === 0) setSearchError("No matches. Try fewer words (street and suburb), or find the spot on the satellite map.");
    } catch {
      setSearchError("Address lookup is unavailable, try again shortly");
    } finally {
      setSearching(false);
    }
  }

  function pickResult(r: AddressSuggestion) {
    setCenter([r.lat, r.lng]);
    if (r.precise) {
      setPin([r.lat, r.lng]);
      setZoom(18);
      setNotice(`Pin moved to ${r.label}. Check it sits on the house or lot — drag it or click the map to adjust — then Save.`);
    } else {
      // A street or suburb centroid can be hundreds of metres out — too far
      // for a 150 m clock-on fence — so the pin isn't put there for them.
      setZoom(17);
      setNotice(`Approximate match (${r.label}) — the map is centred on the street or area. Click the exact house or lot to place the pin.`);
    }
    setResults(null);
  }

  function placePin(lat: number, lng: number) {
    setPin([lat, lng]);
    setNotice(null);
  }

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
      <DialogContent className="max-w-3xl max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set location — {site.name ?? site.address_line1}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-slate-500">
          Search the address, or click the map where the job is (the house, lot or slab) and drag the pin. Auto clock-in
          triggers within 150 m of this point.
        </p>
        <div className="space-y-2">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query);
            }}
          >
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                aria-label="Search for an address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Street address, suburb"
                className="pl-8"
                maxLength={200}
              />
            </div>
            <Button type="submit" variant="outline" disabled={searching || query.trim().length < 3}>
              {searching ? "Searching..." : "Search"}
            </Button>
            {ownAddress && (
              <Button
                type="button"
                variant="ghost"
                className="gap-1.5 text-blue-700"
                disabled={searching}
                onClick={() => void runSearch(ownAddress)}
                title={ownAddress}
              >
                <MapPin className="h-4 w-4" />
                Find this address
              </Button>
            )}
          </form>
          {searchError && <p className="text-xs text-amber-700">{searchError}</p>}
          {results && results.length > 0 && (
            <ul className="max-h-48 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100" aria-label="Address matches">
              {results.map((r) => (
                <li key={`${r.lat},${r.lng}`}>
                  <button
                    type="button"
                    onClick={() => pickResult(r)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
                    title={r.display}
                  >
                    <MapPin className={`mt-0.5 h-4 w-4 shrink-0 ${r.precise ? "text-blue-600" : "text-amber-500"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-slate-800">{r.label}</span>
                      <span className="block truncate text-xs text-slate-400">{r.display}</span>
                    </span>
                    {!r.precise && (
                      <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                        Approximate
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {notice && <p className="text-xs text-slate-600">{notice}</p>}
        </div>
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
            <SiteLocationMap center={center} zoom={zoom} pin={pin} layer={layer} onPick={placePin} />
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
