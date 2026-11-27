"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { distanceNote, kmFieldText, type DistanceResult, type TripEnds } from "@/lib/distance-trip";

// "Work out km" beside a Day Works km box (float moves, cartage by km).
// One call to /api/distance (OSRM road distance + Nominatim, no key). The
// answer fills the box only if nobody typed in it meanwhile; the box stays
// editable. Places and km only — no money. 27 Nov 2026.
export function KmLookupButton({ jobId, km, ends, onKm }: {
  jobId: string;
  km: string;
  ends: () => TripEnds | { error: string };
  onKm: (km: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const kmRef = useRef(km);
  const onKmRef = useRef(onKm);
  useEffect(() => {
    kmRef.current = km;
    onKmRef.current = onKm;
  });

  async function press() {
    if (busy) return;
    const trip = ends();
    if ("error" in trip) {
      setNote({ text: trip.error, warn: true });
      return;
    }
    const kmAtPress = kmRef.current;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/distance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: trip.from, to: trip.to, jobId }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<DistanceResult> & { error?: string };
      if (!res.ok || typeof data.km !== "number") {
        setNote({ text: data.error ?? "Couldn't work out the km — type them in.", warn: true });
        return;
      }
      const r = data as DistanceResult;
      if (kmRef.current === kmAtPress) onKmRef.current(kmFieldText(r.km));
      setNote({ text: distanceNote(r), warn: r.approximate });
    } catch {
      setNote({ text: "No connection — type the km in.", warn: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button type="button" size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void press()}>
        <MapPin className="w-3.5 h-3.5" />
        {busy ? "Working out km…" : "Work out km"}
      </Button>
      {note && <p className={`text-xs ${note.warn ? "text-amber-700" : "text-slate-500"}`}>{note.text}</p>}
    </div>
  );
}
