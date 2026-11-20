"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw } from "lucide-react";
import type { KomtraxMachine } from "@/lib/komtrax-data";
import { ageText, hoursText } from "@/lib/komtrax-view";

// Fleet → Komtrax machines (office/admin; 0113). Every Komatsu machine
// Komtrax reports, linked to its fleet item — the sync links by serial when
// the serial is in the item's name, rego or notes; anything else the office
// links here. Admin can run the sync by hand (Komatsu allows each address
// once per 15 minutes, so a second press soon after is refused politely).

const NONE = "__none__";

export interface KomtraxFleetState {
  connected: boolean;
  /** false = 0113 not applied. */
  ready: boolean;
  machines: KomtraxMachine[];
  lastOkAt: string | null;
  lastRunAt: string | null;
}

export function FleetKomtrax({
  state,
  equipment,
  isAdmin,
  onMachinesChange,
}: {
  state: KomtraxFleetState;
  equipment: { id: string; name: string; is_active: boolean }[];
  isAdmin: boolean;
  onMachinesChange: (m: KomtraxMachine[]) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await fetch("/api/komtrax/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(data.error ?? "Komtrax sync failed");
      else if (data.skipped) toast.message(data.reason ?? "Komtrax sync skipped");
      else {
        toast.success(`Komtrax: ${data.machines} machine${data.machines === 1 ? "" : "s"} read`);
        window.location.reload();
      }
    } finally {
      setSyncing(false);
    }
  }

  async function link(machine: KomtraxMachine, value: string) {
    const equipmentId = value === NONE ? null : value;
    setSavingId(machine.id);
    try {
      const res = await fetch(`/api/komtrax/machines/${machine.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ equipment_id: equipmentId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't save the link.");
        return;
      }
      onMachinesChange(state.machines.map((m) => (m.id === machine.id ? { ...m, equipment_id: equipmentId, matched_by: "office" } : m)));
      toast.success(equipmentId ? "Linked" : "Unlinked");
    } finally {
      setSavingId(null);
    }
  }

  const linkedIds = new Set(state.machines.map((m) => m.equipment_id).filter(Boolean));
  const unlinked = state.machines.filter((m) => !m.equipment_id).length;
  const sorted = [...state.machines].sort((a, b) => Number(!!a.equipment_id) - Number(!!b.equipment_id) || a.model.localeCompare(b.model));

  return (
    <Card id="komtrax">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Komtrax machines</CardTitle>
            <p className="text-sm text-slate-500">
              {!state.connected
                ? "Komtrax not connected."
                : !state.ready
                  ? "Komtrax isn't switched on in this database yet (migration 0113)."
                  : state.machines.length === 0
                    ? `No Komatsu machines read yet${state.lastRunAt ? ` (last tried ${ageText(state.lastRunAt)})` : ""}.`
                    : `Engine hours, location, fuel and faults from Komatsu. Last read ${ageText(state.lastOkAt)}.`}
              {unlinked > 0 && <span className="font-medium text-amber-700"> {unlinked} not linked to a fleet item yet.</span>}
            </p>
          </div>
          {isAdmin && state.connected && state.ready && (
            <Button variant="outline" size="sm" className="gap-1.5 shrink-0" onClick={syncNow} disabled={syncing}>
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing…" : "Sync Komtrax"}
            </Button>
          )}
        </div>
      </CardHeader>
      {sorted.length > 0 && (
        <CardContent className="p-0">
          <div className="divide-y">
            {sorted.map((m) => (
              <div key={m.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 break-words">
                    {m.model} · serial {m.serial}
                    {m.komtrax_label && <span className="text-slate-500 font-normal"> ({m.komtrax_label})</span>}
                  </p>
                  <p className="text-xs text-slate-500">
                    {hoursText(m.hours)} · reported {ageText(m.last_seen_at)}
                    {m.matched_by === "auto" && m.equipment_id ? " · linked by serial" : ""}
                  </p>
                </div>
                <Select value={m.equipment_id ?? NONE} onValueChange={(v) => link(m, (v as string) ?? NONE)} disabled={savingId === m.id}>
                  <SelectTrigger className="h-8 text-xs w-full sm:w-[240px]">
                    <SelectValue placeholder="Not linked" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not linked</SelectItem>
                    {equipment
                      .filter((e) => e.is_active && (!linkedIds.has(e.id) || e.id === m.equipment_id))
                      .map((e) => (
                        <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
