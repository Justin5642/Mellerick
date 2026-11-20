"use client";

import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, MapPin, Fuel, Gauge } from "lucide-react";
import { formatDateTime } from "@/lib/date";
import type { KomtraxMachineLoad } from "@/lib/komtrax-data";
import { ageText, fuelText, hoursText, mapsUrl, severityTone } from "@/lib/komtrax-view";

// Fleet → machine → Komtrax (office/admin; 0113 (draft)). Engine hours, last known
// position, fuel used and recent fault codes, as Komtrax last reported them
// (it refreshes about every 6 hours). Read-only. No money.

const TONE: Record<string, string> = {
  high: "bg-red-50 text-red-700",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

export function EquipmentKomtrax({ data }: { data: KomtraxMachineLoad | null }) {
  if (!data) return null;
  if (!data.connected) return <p className="text-xs text-slate-400">Komtrax not connected.</p>;
  if (!data.ready) return <p className="text-xs text-slate-400">Komtrax isn&apos;t switched on in this database yet (migration 0113).</p>;
  const m = data.machine;
  if (!m) return null; // Not a Komatsu machine, or not linked yet (Fleet → Komtrax machines).

  return (
    <Card>
      <CardContent className="pt-4 pb-4 space-y-3 text-sm">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Komtrax · {m.model} · serial {m.serial}</p>
          <p className="text-xs text-slate-400">Last report {ageText(m.last_seen_at)}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex items-start gap-2">
            <Gauge className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-500">Engine hours</p>
              <p className="font-semibold text-slate-900">{hoursText(m.hours)}</p>
              {m.hours_at && <p className="text-[11px] text-slate-400">read {formatDateTime(m.hours_at)}</p>}
              {m.idle_hours !== null && <p className="text-[11px] text-slate-400">idle {hoursText(m.idle_hours)}</p>}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <MapPin className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-500">Last known location</p>
              {m.lat !== null && m.lng !== null ? (
                <a href={mapsUrl(m.lat, m.lng)} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline">
                  Open in maps
                </a>
              ) : (
                <p className="text-slate-400">Not reported</p>
              )}
              {m.location_at && <p className="text-[11px] text-slate-400">{formatDateTime(m.location_at)}</p>}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Fuel className="w-4 h-4 text-slate-400 mt-0.5" />
            <div>
              <p className="text-xs text-slate-500">Fuel used</p>
              <p className="font-semibold text-slate-900">{fuelText(m.fuel_used_last24, m.fuel_units)} <span className="text-xs font-normal text-slate-500">last 24 h</span></p>
              <p className="text-[11px] text-slate-400">{fuelText(m.fuel_used_cumulative, m.fuel_units)} lifetime</p>
              {m.fuel_remaining_pct !== null && <p className="text-[11px] text-slate-400">tank {Math.round(m.fuel_remaining_pct)}%{m.def_remaining_pct !== null ? ` · DEF ${Math.round(m.def_remaining_pct)}%` : ""}</p>}
            </div>
          </div>
        </div>
        <div className="border-t pt-3">
          <p className="text-xs text-slate-500 mb-1.5">Fault codes, last 30 days</p>
          {data.faults.length === 0 ? (
            <p className="text-xs text-slate-400">None reported.</p>
          ) : (
            <ul className="space-y-1">
              {data.faults.map((f) => (
                <li key={f.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                  <AlertTriangle className="w-3 h-3 text-amber-600 self-center" />
                  <span className={`px-1.5 py-0.5 rounded font-mono ${TONE[severityTone(f.severity)]}`}>{f.code}</span>
                  <span className="text-slate-700">{f.description ?? "No description"}</span>
                  <span className="text-slate-400">{formatDateTime(f.occurred_at)}{f.severity ? ` · ${f.severity}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
