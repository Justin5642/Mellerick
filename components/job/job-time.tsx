"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Clock, LogIn, LogOut, MapPin, Radio, WifiOff, Car } from "lucide-react";

interface TimeEntry {
  id: string;
  staff_id: string;
  clock_in: string;
  clock_out: string | null;
  hours: number | null;
  auto_clocked: boolean;
  entry_type?: "work" | "travel";
  cost_center_id: string | null;
  profiles: { full_name: string };
}

interface PO {
  site_lat: number | null;
  site_lng: number | null;
  site_address: string | null;
}

interface CostCenterOption {
  id: string;
  name: string;
  code: string | null;
  po_number?: string;
}

interface Props {
  jobId: string;
  currentUserId: string;
  timeEntries: TimeEntry[];
  pos: PO[];
  costCenters: CostCenterOption[];
  onUpdate: (entries: TimeEntry[]) => void;
}

const GEOFENCE_RADIUS = 150;

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (n: number) => n * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

export function JobTime({ jobId, currentUserId, timeEntries: initial, pos, costCenters, onUpdate }: Props) {
  const supabase = createClient();
  const [entries, setEntries] = useState<TimeEntry[]>(initial);
  const [loading, setLoading] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [withinFence, setWithinFence] = useState(false);
  const lastInsideRef = useRef<boolean | null>(null);

  // Single source of truth for entries lives in local state (needed for the
  // geofencing watcher's functional updates below); mirror every change up
  // to the parent so the PO tab's per-stage actuals stay in sync without a
  // full page reload.
  useEffect(() => {
    onUpdate(entries);
  }, [entries]);

  async function assignCostCenter(entryId: string, costCenterId: string) {
    setAssigningId(entryId);
    const { data, error } = await supabase
      .from("time_entries")
      .update({ cost_center_id: costCenterId === "none" ? null : costCenterId })
      .eq("id", entryId)
      .select("*, profiles(full_name)")
      .single();
    setAssigningId(null);
    if (error || !data) {
      toast.error("Failed to assign stage");
      return;
    }
    setEntries((prev) => prev.map((e) => (e.id === entryId ? (data as TimeEntry) : e)));
  }

  const poWithLocation = pos.find(p => p.site_lat && p.site_lng);
  const myOpenEntry = entries.find(e => e.staff_id === currentUserId && e.entry_type !== "travel" && !e.clock_out);
  const workEntries = entries.filter(e => e.entry_type !== "travel");
  const travelEntries = entries.filter(e => e.entry_type === "travel");
  const totalHours = workEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);
  const totalTravelHours = travelEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);

  useEffect(() => {
    if (!poWithLocation?.site_lat || !poWithLocation?.site_lng) return;
    if (!("geolocation" in navigator)) return;

    const watchId = navigator.geolocation.watchPosition(
      async (position) => {
        const dist = haversineDistance(
          position.coords.latitude, position.coords.longitude,
          poWithLocation.site_lat!, poWithLocation.site_lng!
        );
        setDistance(Math.round(dist));
        const inside = dist <= GEOFENCE_RADIUS;
        setWithinFence(inside);

        if (inside === lastInsideRef.current) return;
        lastInsideRef.current = inside;

        if (inside) {
          const { data: open } = await supabase
            .from("time_entries")
            .select("id")
            .eq("job_id", jobId)
            .eq("staff_id", currentUserId)
            .is("clock_out", null)
            .maybeSingle();

          if (!open) {
            const { data } = await supabase
              .from("time_entries")
              .insert({ job_id: jobId, staff_id: currentUserId, clock_in: new Date().toISOString(), auto_clocked: true })
              .select("*, profiles(full_name)")
              .single();
            if (data) {
              setEntries(e => [data as TimeEntry, ...e]);
              toast.success("On site — clocked in automatically");
            }
          }
        } else {
          const { data: open } = await supabase
            .from("time_entries")
            .select("id, clock_in")
            .eq("job_id", jobId)
            .eq("staff_id", currentUserId)
            .is("clock_out", null)
            .maybeSingle();

          if (open) {
            const clockOut = new Date().toISOString();
            const hours = Math.round(((new Date(clockOut).getTime() - new Date(open.clock_in).getTime()) / 3600000) * 100) / 100;
            const { data } = await supabase
              .from("time_entries")
              .update({ clock_out: clockOut, hours })
              .eq("id", open.id)
              .select("*, profiles(full_name)")
              .single();
            if (data) {
              setEntries(e => e.map(en => en.id === open.id ? data as TimeEntry : en));
              toast.success("Left site — clocked out automatically");
            }
          }
        }
      },
      null,
      { enableHighAccuracy: true, maximumAge: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [jobId, currentUserId, poWithLocation?.site_lat, poWithLocation?.site_lng]);

  async function clockIn() {
    if (myOpenEntry || loading) return;
    setLoading(true);
    const { data } = await supabase
      .from("time_entries")
      .insert({ job_id: jobId, staff_id: currentUserId, clock_in: new Date().toISOString(), auto_clocked: false })
      .select("*, profiles(full_name)")
      .single();
    if (data) {
      setEntries(e => [data as TimeEntry, ...e]);
      toast.success("Clocked in");
    }
    setLoading(false);
  }

  async function clockOut() {
    if (!myOpenEntry || loading) return;
    setLoading(true);
    const clockOutTime = new Date().toISOString();
    const hours = Math.round(((new Date(clockOutTime).getTime() - new Date(myOpenEntry.clock_in).getTime()) / 3600000) * 100) / 100;
    const { data } = await supabase
      .from("time_entries")
      .update({ clock_out: clockOutTime, hours })
      .eq("id", myOpenEntry.id)
      .select("*, profiles(full_name)")
      .single();
    if (data) {
      setEntries(e => e.map(en => en.id === myOpenEntry.id ? data as TimeEntry : en));
      toast.success("Clocked out");
    }
    setLoading(false);
  }

  return (
    <div className="p-6 space-y-5">
      {/* Geo-fence indicator */}
      {poWithLocation ? (
        <Card className={withinFence ? "border-green-200 bg-green-50/60" : "border-slate-200"}>
          <CardContent className="py-3 px-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {withinFence ? (
                  <Radio className="w-4 h-4 text-green-600 animate-pulse" />
                ) : (
                  <WifiOff className="w-4 h-4 text-slate-400" />
                )}
                <span className="text-sm font-medium text-slate-700">
                  {withinFence ? "On site — geo-fence active" : distance !== null ? "Not on site" : "Locating..."}
                </span>
              </div>
              {distance !== null && (
                <span className="text-xs text-slate-500 flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  {distance < 1000 ? `${distance}m away` : `${(distance / 1000).toFixed(1)}km away`}
                </span>
              )}
            </div>
            {withinFence && <p className="text-xs text-green-600 mt-1">Clock-in/out is handled automatically</p>}
          </CardContent>
        </Card>
      ) : (
        <p className="text-xs text-slate-400 flex items-center gap-1.5">
          <MapPin className="w-3 h-3" />Add a PO with a site address to enable automatic geo-fence clock-in/out
        </p>
      )}

      {/* Manual clock in/out */}
      <div className="flex items-center gap-3">
        {!myOpenEntry ? (
          <Button onClick={clockIn} disabled={loading} className="gap-2">
            <LogIn className="w-4 h-4" />Clock In
          </Button>
        ) : (
          <>
            <Button onClick={clockOut} disabled={loading} variant="outline" className="gap-2 border-red-200 text-red-600 hover:bg-red-50">
              <LogOut className="w-4 h-4" />Clock Out
            </Button>
            <span className="flex items-center gap-1.5 text-sm text-green-600 font-medium">
              <Clock className="w-4 h-4" />Since {formatTime(myOpenEntry.clock_in)}
            </span>
          </>
        )}
      </div>

      {/* Time log */}
      {entries.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">Time Log</h3>
            <span className="text-sm font-bold text-slate-900">
              {totalHours.toFixed(1)}h total
              {totalTravelHours > 0 && <span className="text-slate-400 font-normal"> · {totalTravelHours.toFixed(1)}h travel</span>}
            </span>
          </div>
          <div className="space-y-2">
            {entries.map(entry => {
              const isTravel = entry.entry_type === "travel";
              return (
                <div key={entry.id} className={`py-2.5 px-3 rounded-lg text-sm space-y-1.5 ${isTravel ? "bg-blue-50/60" : "bg-slate-50"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      {isTravel && <Car className="w-3.5 h-3.5 text-blue-500" />}
                      <span className="font-medium text-slate-800">{entry.profiles?.full_name}</span>
                      <span className="text-slate-400 text-xs ml-1">{formatDate(entry.clock_in)}</span>
                      {isTravel ? (
                        <span className="text-xs text-blue-500 ml-1.5 bg-blue-100 px-1.5 py-0.5 rounded">travel</span>
                      ) : entry.auto_clocked && (
                        <span className="text-xs text-blue-500 ml-1.5 bg-blue-50 px-1.5 py-0.5 rounded">auto</span>
                      )}
                    </div>
                    <div className="text-right text-slate-600">
                      {formatTime(entry.clock_in)} → {entry.clock_out ? formatTime(entry.clock_out) : <span className="text-green-600 font-medium">now</span>}
                      {entry.hours != null && (
                        <span className="ml-2 font-semibold text-slate-800">{Number(entry.hours).toFixed(1)}h</span>
                      )}
                    </div>
                  </div>
                  {!isTravel && costCenters.length > 0 && (
                    <Select
                      value={entry.cost_center_id ?? "none"}
                      onValueChange={(v) => assignCostCenter(entry.id, v ?? "none")}
                      disabled={assigningId === entry.id}
                    >
                      <SelectTrigger className="h-7 text-xs w-56 bg-white"><SelectValue placeholder="Assign to stage..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {costCenters.map((cc) => (
                          <SelectItem key={cc.id} value={cc.id}>
                            {cc.name}{cc.po_number ? ` (PO #${cc.po_number})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {entries.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-8">No time logged yet</p>
      )}
    </div>
  );
}
